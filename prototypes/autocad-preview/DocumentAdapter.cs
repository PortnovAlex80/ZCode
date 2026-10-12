using System;
using System.Collections.Generic;
using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using System.Linq;
using Autodesk.AutoCAD.ApplicationServices;
using Autodesk.AutoCAD.DatabaseServices;
using Autodesk.AutoCAD.EditorInput;
using Autodesk.AutoCAD.Geometry;
using Newtonsoft.Json.Linq;
using AcApp = Autodesk.AutoCAD.ApplicationServices.Core.Application;

namespace SpecHarness.AutoCAD;

internal sealed class DocumentAdapter
{
    private readonly Dictionary<Document, string> instances = new();
    private readonly HashSet<string> attempted = new();
    internal string Instance(Document document)
    {
        if (!instances.TryGetValue(document, out var instance)) instances[document] = instance = Guid.NewGuid().ToString();
        return instance;
    }
    internal void Forget(Document document) => instances.Remove(document);
    internal JObject Descriptor(Document document) => new()
    {
        ["host"] = "autocad", ["documentId"] = document.Database.FingerprintGuid.ToString(),
        ["documentInstanceId"] = Instance(document), ["name"] = System.IO.Path.GetFileName(document.Name), ["url"] = document.Name
    };
    internal JToken Execute(Document document, string method, JObject args)
    {
        if (AcApp.DocumentManager.MdiActiveDocument != document) throw new InvalidOperationException("Drawing changed; capture the selection again");
        var expected = args["expected"] as JObject;
        if (method != "readSelection" && (string?)(expected ?? args)["documentInstanceId"] != Instance(document))
            throw new InvalidOperationException("Drawing instance changed");
        using (document.LockDocument())
        {
            ObjectId[] ids;
            if (method == "readSelection")
            {
                var result = document.Editor.SelectImplied();
                if (result.Status != PromptStatus.OK) result = document.Editor.GetSelection(new PromptSelectionOptions { MessageForAdding = "\nSelect objects for ZCODE: " });
                if (result.Status != PromptStatus.OK) throw new InvalidOperationException("Selection cancelled");
                ids = result.Value.GetObjectIds();
            }
            else ids = Resolve(document.Database, ((expected ?? args)["target"] as JObject) ?? throw new InvalidOperationException("Target required"));
            if (ids.Length == 0 || ids.Length > 100) throw new InvalidOperationException("Select 1 to 100 objects");
            using (var transaction = document.Database.TransactionManager.StartTransaction())
            {
                var snapshot = Snapshot(document, transaction, ids);
                if (method == "readSelection" || method == "readTarget") return snapshot;
                if (method == "locate") { document.Editor.SetImpliedSelection(ids); return new JObject { ["status"] = "located" }; }
                if (method != "applyEdit") throw new InvalidOperationException("Unsupported drawing operation");
                var operationId = (string?)args["operationId"];
                if (string.IsNullOrWhiteSpace(operationId) || !attempted.Add(operationId!)) throw new InvalidOperationException("Operation already attempted or has no identity");
                if (!SameSnapshot(expected!["data"], snapshot["data"])) return new JObject { ["status"] = "refused", ["reason"] = "Objects changed since proposal" };
                var patch = args["patch"] as JObject ?? throw new InvalidOperationException("Patch required");
                if ((string?)patch["kind"] != "setLayer") throw new InvalidOperationException("Only setLayer is supported");
                var layerName = (string?)patch["layer"] ?? throw new InvalidOperationException("Existing layer name required");
                var layers = (LayerTable)transaction.GetObject(document.Database.LayerTableId, OpenMode.ForRead);
                if (!layers.Has(layerName)) throw new InvalidOperationException("Destination layer does not exist");
                var destination = (LayerTableRecord)transaction.GetObject(layers[layerName], OpenMode.ForRead);
                if (destination.IsLocked || destination.IsDependent || destination.IsOff || destination.IsFrozen)
                    throw new InvalidOperationException("Destination layer must be unlocked, local, visible and thawed");
                foreach (var id in ids)
                {
                    var entity = (Entity)transaction.GetObject(id, OpenMode.ForRead);
                    var source = (LayerTableRecord)transaction.GetObject(entity.LayerId, OpenMode.ForRead);
                    var owner = (BlockTableRecord)transaction.GetObject(entity.OwnerId, OpenMode.ForRead);
                    if (!Supported(entity) || source.IsLocked || source.IsDependent || owner.IsFromExternalReference || owner.IsFromOverlayReference)
                        throw new InvalidOperationException("Unsupported, locked or external-reference object");
                    entity.UpgradeOpen(); entity.LayerId = destination.ObjectId;
                }
                var after = Snapshot(document, transaction, ids);
                if (after["data"]!["entities"]!.Any(entity => (string?)entity["layer"] != layerName)) throw new InvalidOperationException("Layer postcondition failed; transaction rolled back");
                transaction.Commit();
                return new JObject { ["status"] = "applied", ["operationId"] = operationId, ["snapshot"] = after };
            }
        }
    }
    // JSON has one number type in JavaScript: 1.0 returns as 1. Compare values, never token tags or tolerances.
    internal static bool SameSnapshot(JToken? left, JToken? right)
    {
        if (left == null || right == null) return left == right;
        bool Numeric(JToken item) => item.Type == JTokenType.Float || item.Type == JTokenType.Integer;
        if (Numeric(left) && Numeric(right)) return left.Value<double>().Equals(right.Value<double>());
        if (left is JObject a && right is JObject b) return a.Count == b.Count && a.Properties().All(property => b.ContainsKey(property.Name) && SameSnapshot(property.Value, b[property.Name]));
        if (left is JArray x && right is JArray y) return x.Count == y.Count && x.Zip(y, SameSnapshot).All(equal => equal);
        return JToken.DeepEquals(left, right);
    }
    private static ObjectId[] Resolve(Database database, JObject target)
    {
        if ((string?)target["layout"] != LayoutManager.Current.CurrentLayout) throw new InvalidOperationException("Layout changed; capture the target again");
        var handles = target["handles"] as JArray ?? throw new InvalidOperationException("Captured handles required");
        if (handles.Count < 1 || handles.Count > 100) throw new InvalidOperationException("Invalid target size");
        return handles.Select(item =>
        {
            var text = (string?)item;
            if (text == null || text.Length > 16 || !long.TryParse(text, NumberStyles.HexNumber, CultureInfo.InvariantCulture, out var value) || value <= 0)
                throw new InvalidOperationException("Invalid entity handle");
            var id = database.GetObjectId(false, new Handle(value), 0);
            if (id.IsNull || id.IsErased) throw new InvalidOperationException("Entity no longer exists");
            return id;
        }).Distinct().ToArray();
    }
    private JObject Snapshot(Document document, Transaction transaction, ObjectId[] ids)
    {
        var entities = new JArray(); var remainingVertices = 1000;
        foreach (var id in ids)
        {
            if (!(transaction.GetObject(id, OpenMode.ForRead) is Entity entity)) throw new InvalidOperationException("Target is not an entity");
            var owner = (BlockTableRecord)transaction.GetObject(entity.OwnerId, OpenMode.ForRead);
            if (!owner.IsLayout || owner.IsFromExternalReference) throw new InvalidOperationException("Select top-level entities in the current layout");
            if (owner.LayoutId != LayoutManager.Current.GetLayoutId(LayoutManager.Current.CurrentLayout)) throw new InvalidOperationException("Entity is in another layout");
            entities.Add(EntitySnapshot(entity, ref remainingVertices));
        }
        var snapshot = new JObject
        {
            ["host"] = "autocad", ["documentInstanceId"] = Instance(document),
            ["target"] = new JObject { ["handles"] = new JArray(ids.Select(id => id.Handle.ToString())), ["layout"] = LayoutManager.Current.CurrentLayout },
            ["data"] = new JObject { ["insunits"] = document.Database.Insunits.ToString(), ["insunitsCode"] = (int)document.Database.Insunits, ["frame"] = "WCS", ["entities"] = entities }
        };
        if (Encoding.UTF8.GetByteCount(snapshot.ToString(Newtonsoft.Json.Formatting.None)) > 64 * 1024) throw new InvalidOperationException("Selection exceeds 64 KiB; capture fewer objects");
        return snapshot;
    }
    private static bool Supported(Entity entity) => entity is Line || entity is Circle || entity is Arc || entity is Polyline || entity is DBText || entity is MText;
    private static JArray Point(Point3d point) => new(point.X, point.Y, point.Z);
    private static JArray Vector(Vector3d vector) => new(vector.X, vector.Y, vector.Z);
    private static string TextFingerprint(string text) { using (var hash = SHA256.Create()) return Convert.ToBase64String(hash.ComputeHash(Encoding.UTF8.GetBytes(text))); }
    private static JObject EntitySnapshot(Entity entity, ref int remainingVertices)
    {
        var result = new JObject { ["handle"] = entity.Handle.ToString(), ["type"] = entity.GetType().Name, ["layer"] = entity.Layer, ["colorIndex"] = entity.ColorIndex, ["visible"] = entity.Visible, ["geometrySupported"] = Supported(entity) };
        switch (entity)
        {
            case Line line: result["start"] = Point(line.StartPoint); result["end"] = Point(line.EndPoint); break;
            case Circle circle: result["center"] = Point(circle.Center); result["radius"] = circle.Radius; result["normal"] = Vector(circle.Normal); break;
            case Arc arc:
                result["center"] = Point(arc.Center); result["radius"] = arc.Radius; result["start"] = Point(arc.StartPoint); result["end"] = Point(arc.EndPoint); result["normal"] = Vector(arc.Normal);
                result["startAngleRadiansOCS"] = arc.StartAngle; result["endAngleRadiansOCS"] = arc.EndAngle; break;
            case Polyline polyline:
                if (polyline.NumberOfVertices > remainingVertices) throw new InvalidOperationException("Selection exceeds 1000 polyline vertices");
                remainingVertices -= polyline.NumberOfVertices;
                var vertices = new JArray();
                for (var index = 0; index < polyline.NumberOfVertices; index++) vertices.Add(new JObject { ["point"] = Point(polyline.GetPoint3dAt(index)), ["bulge"] = polyline.GetBulgeAt(index), ["startWidth"] = polyline.GetStartWidthAt(index), ["endWidth"] = polyline.GetEndWidthAt(index) });
                result["vertices"] = vertices; result["closed"] = polyline.Closed; result["normal"] = Vector(polyline.Normal); result["elevationOCS"] = polyline.Elevation; break;
            case DBText text:
                result["position"] = Point(text.Position); result["normal"] = Vector(text.Normal); result["text"] = text.TextString.Length > 2048 ? text.TextString.Substring(0, 2048) : text.TextString;
                result["textTruncated"] = text.TextString.Length > 2048; result["textFingerprint"] = TextFingerprint(text.TextString); result["height"] = text.Height; result["rotationRadiansOCS"] = text.Rotation; break;
            case MText text:
                result["position"] = Point(text.Location); result["normal"] = Vector(text.Normal); result["text"] = text.Contents.Length > 2048 ? text.Contents.Substring(0, 2048) : text.Contents;
                result["textTruncated"] = text.Contents.Length > 2048; result["textFingerprint"] = TextFingerprint(text.Contents); result["height"] = text.TextHeight;
                result["directionWCS"] = Vector(text.Direction); result["width"] = text.Width; result["attachment"] = text.Attachment.ToString(); break;
        }
        return result;
    }
}
