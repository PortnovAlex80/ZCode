// Compiled only with BuildVerification=true; use an isolated Core Console drawing.
using System;
using System.IO;
using System.Linq;
using Autodesk.AutoCAD.DatabaseServices;
using Autodesk.AutoCAD.Geometry;
using Autodesk.AutoCAD.Runtime;
using Newtonsoft.Json.Linq;
using AcApp = Autodesk.AutoCAD.ApplicationServices.Core.Application;

[assembly: CommandClass(typeof(SpecHarness.AutoCAD.Verification))]
namespace SpecHarness.AutoCAD;
public sealed class Verification
{
    [CommandMethod("SHDOCVERIFY")]
    public void Verify()
    {
        var output = Environment.GetEnvironmentVariable("ZCODE_CAD_ACCEPTANCE_RECEIPT");
        if (string.IsNullOrEmpty(output)) throw new InvalidOperationException("Use the isolated verification runner");
        var passed = 0;
        void Check(bool condition, string message) { if (!condition) throw new InvalidOperationException(message); passed++; }
        void Refuses(Action call, string message) { try { call(); } catch (InvalidOperationException) { passed++; return; } throw new InvalidOperationException(message); }
        try
        {
            var document = AcApp.DocumentManager.MdiActiveDocument; var database = document.Database;
            var adapter = new DocumentAdapter(); ObjectId lineId, polylineId, tiltedId, pointId;
            using (var transaction = database.TransactionManager.StartTransaction())
            {
                database.Insunits = UnitsValue.Undefined;
                var space = (BlockTableRecord)transaction.GetObject(database.CurrentSpaceId, OpenMode.ForWrite);
                var line = new Line(new Point3d(1, 2, 3), new Point3d(4, 6, 3)); lineId = space.AppendEntity(line); transaction.AddNewlyCreatedDBObject(line, true);
                var polyline = new Polyline(); polyline.AddVertexAt(0, new Point2d(1, 2), 0, 0, 0); polyline.AddVertexAt(1, new Point2d(3, 4), 0.5, 0, 0); polyline.Elevation = 7;
                polylineId = space.AppendEntity(polyline); transaction.AddNewlyCreatedDBObject(polyline, true);
                var tilted = new Polyline(); tilted.AddVertexAt(0, new Point2d(1, 2), 0, 0, 0); tilted.AddVertexAt(1, new Point2d(3, 4), 0, 0, 0); tilted.Normal = new Vector3d(0, 1, 0); tilted.Elevation = 7;
                tiltedId = space.AppendEntity(tilted); transaction.AddNewlyCreatedDBObject(tilted, true);
                var point = new DBPoint(new Point3d(0, 0, 0)); pointId = space.AppendEntity(point); transaction.AddNewlyCreatedDBObject(point, true);
                var layers = (LayerTable)transaction.GetObject(database.LayerTableId, OpenMode.ForWrite);
                foreach (var name in new[] { "SH_TEST", "SH_LOCKED" }) { var layer = new LayerTableRecord { Name = name, IsLocked = name == "SH_LOCKED" }; layers.Add(layer); transaction.AddNewlyCreatedDBObject(layer, true); }
                transaction.Commit();
            }
            JObject Read(ObjectId id) => (JObject)adapter.Execute(document, "readTarget", new JObject {
                ["documentInstanceId"] = adapter.Instance(document), ["target"] = new JObject { ["layout"] = LayoutManager.Current.CurrentLayout, ["handles"] = new JArray(id.Handle.ToString()) }
            });
            JObject Proposal(JObject expected, string layer, string operation) => new() { ["operationId"] = operation, ["expected"] = expected, ["patch"] = new JObject { ["kind"] = "setLayer", ["layer"] = layer } };
            var first = Read(lineId);
            Check((int)first["data"]!["insunitsCode"]! == 0, "Unspecified drawing units must remain explicit");
            Check((string?)first["data"]!["frame"] == "WCS", "WCS frame missing");
            Check(JToken.DeepEquals(first["data"]!["entities"]![0]!["start"], new JArray(1.0, 2.0, 3.0)), "Fresh source LINE coordinates changed");
            var poly = Read(polylineId);
            Check(JToken.DeepEquals(poly["data"]!["entities"]![0]!["vertices"]![0]!["point"], new JArray(1.0, 2.0, 7.0)), "OCS elevation must be transformed to WCS");
            Check(DocumentAdapter.SameSnapshot(Read(tiltedId)["data"]!["entities"]![0]!["vertices"]![0]!["point"], new JArray(-1, 7, 2)), "Tilted normal must use the native arbitrary-axis OCS transform, not global XY");
            // Mimic JSON.parse/stringify in the WebView: integral doubles return as integer tokens.
            JToken BrowserRoundTrip(JToken value) {
                if (value is JObject obj) return new JObject(obj.Properties().Select(property => new JProperty(property.Name, BrowserRoundTrip(property.Value))));
                if (value is JArray array) return new JArray(array.Select(BrowserRoundTrip));
                if (value.Type == JTokenType.Float && value.Value<double>() == Math.Truncate(value.Value<double>())) return new JValue((long)value.Value<double>());
                return value.DeepClone();
            }
            var returned = (JObject)BrowserRoundTrip(JObject.Parse(first.ToString()));
            Check(!JToken.DeepEquals(first["data"], returned["data"]), "Fixture did not exercise browser numeric conversion");
            var write = Proposal(returned, "SH_TEST", "once");
            Check((string?)adapter.Execute(document, "applyEdit", write)["status"] == "applied", "Layer apply failed");
            using (var transaction = database.TransactionManager.StartTransaction()) Check(((Line)transaction.GetObject(lineId, OpenMode.ForRead)).Layer == "SH_TEST", "Native database postcondition failed");
            Refuses(() => adapter.Execute(document, "applyEdit", write), "Duplicate write accepted");
            Check((string?)adapter.Execute(document, "applyEdit", Proposal(first, "0", "stale"))["status"] == "refused", "Changed target accepted");
            Refuses(() => adapter.Execute(document, "applyEdit", Proposal(Read(lineId), "SH_LOCKED", "locked")), "Locked destination accepted");
            Refuses(() => adapter.Execute(document, "applyEdit", Proposal(Read(pointId), "SH_TEST", "unsupported")), "Unsupported entity written");
            var old = Read(lineId); old["documentInstanceId"] = "old";
            Refuses(() => adapter.Execute(document, "applyEdit", Proposal(old, "0", "old-instance")), "Old drawing instance accepted");
            Check((bool)Read(pointId)["data"]!["entities"]![0]!["geometrySupported"]! == false, "Unsupported geometry advertised");
            File.WriteAllText(output!, new JObject { ["status"] = "passed", ["checks"] = passed, ["documentId"] = adapter.Descriptor(document)["documentId"] }.ToString());
        }
        catch (System.Exception error) { File.WriteAllText(output!, new JObject { ["status"] = "failed", ["checks"] = passed, ["error"] = error.ToString() }.ToString()); }
    }
}
