using System;
using System.Collections.Generic;
using System.Drawing;
using System.IO;
using System.Reflection;
using System.Threading.Tasks;
using System.Windows.Forms;
using Autodesk.AutoCAD.ApplicationServices;
using Autodesk.AutoCAD.Runtime;
using Autodesk.AutoCAD.Windows;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;
using Newtonsoft.Json.Linq;
using AcApp = Autodesk.AutoCAD.ApplicationServices.Core.Application;
using AcException = System.Exception;

[assembly: ExtensionApplication(typeof(SpecHarness.AutoCAD.Plugin))]
[assembly: CommandClass(typeof(SpecHarness.AutoCAD.Plugin))]
namespace SpecHarness.AutoCAD;

public sealed class Plugin : IExtensionApplication
{
    private static PaletteSet? palette;
    private static WebView2? web;
    private static readonly DocumentAdapter adapter = new();
    private static readonly Queue<Request> queue = new();
    private static long epoch;
    private static Document? activeDocument;
    private sealed class Request
    {
        internal string Id = "", Method = "";
        internal JObject Args = new(); internal Document Document = null!;
        internal DateTime Deadline;
        internal long Epoch;
    }
    public void Initialize()
    {
        // Trusted local dependencies live alongside the plug-in; no installed Autodesk files are changed.
        AppDomain.CurrentDomain.AssemblyResolve += ResolveDependency;
        activeDocument = AcApp.DocumentManager.MdiActiveDocument;
        AcApp.DocumentManager.DocumentActivated += DocumentActivated;
        AcApp.DocumentManager.DocumentToBeDestroyed += DocumentDestroyed;
    }
    private static Assembly? ResolveDependency(object sender, ResolveEventArgs args)
    {
        var name = new AssemblyName(args.Name).Name;
        if (name != "Microsoft.Web.WebView2.Core" && name != "Microsoft.Web.WebView2.WinForms" && name != "Newtonsoft.Json") return null;
        var requester = args.RequestingAssembly?.GetName().Name;
        if (requester != typeof(Plugin).Assembly.GetName().Name && requester != "Microsoft.Web.WebView2.Core" && requester != "Microsoft.Web.WebView2.WinForms") return null;
        var file = Path.Combine(Path.GetDirectoryName(typeof(Plugin).Assembly.Location)!, name + ".dll");
        if (!File.Exists(file) || AssemblyName.GetAssemblyName(file).FullName != args.Name) return null;
        return Assembly.LoadFrom(file);
    }
    public void Terminate()
    {
        AcApp.DocumentManager.DocumentActivated -= DocumentActivated;
        AcApp.DocumentManager.DocumentToBeDestroyed -= DocumentDestroyed;
        AppDomain.CurrentDomain.AssemblyResolve -= ResolveDependency;
        InvalidateRequests("Document pane closed");
        web?.Dispose(); palette?.Dispose();
    }
    [CommandMethod("SHDOC", CommandFlags.Session)]
    public void ShowPane()
    {
        if (palette != null) { palette.Visible = true; return; }
        palette = new PaletteSet("ZCODE · Document", new Guid("b028b6d5-4ae2-4569-ab99-f1c040117248"))
        { Size = new Size(430, 760), MinimumSize = new Size(320, 480), Style = PaletteSetStyles.ShowCloseButton | PaletteSetStyles.ShowAutoHideButton | PaletteSetStyles.ShowPropertiesMenu };
        web = new WebView2 { Dock = DockStyle.Fill };
        palette.Add("ZCODE", web); palette.Visible = true;
        _ = InitializeWeb();
    }
    private static async Task InitializeWeb()
    {
        try
        {
            var directory = Path.GetDirectoryName(typeof(Plugin).Assembly.Location)!;
            var data = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "SpecHarness", "autocad-preview", "webview-profile");
            var environment = await CoreWebView2Environment.CreateAsync(null, data);
            await web!.EnsureCoreWebView2Async(environment);
            web.CoreWebView2.SetVirtualHostNameToFolderMapping("acad-preview.invalid", Path.Combine(directory, "assets"), CoreWebView2HostResourceAccessKind.DenyCors);
            web.CoreWebView2.Settings.AreDevToolsEnabled = true;
            web.CoreWebView2.Settings.AreDefaultContextMenusEnabled = true;
            web.CoreWebView2.NavigationStarting += (_, args) => {
                if (!args.Uri.StartsWith("https://acad-preview.invalid/", StringComparison.Ordinal)) args.Cancel = true;
                else InvalidateRequests("Document pane reloaded");
            };
            web.CoreWebView2.NewWindowRequested += (_, args) => args.Handled = true;
            web.CoreWebView2.WebMessageReceived += MessageReceived;
            web.Source = new Uri("https://acad-preview.invalid/index.html");
        }
        catch (AcException error) { AcApp.DocumentManager.MdiActiveDocument?.Editor.WriteMessage("\nZCODE pane unavailable: " + error.Message); }
    }
    private static void MessageReceived(object? sender, CoreWebView2WebMessageReceivedEventArgs args)
    {
        if (!args.Source.StartsWith("https://acad-preview.invalid/", StringComparison.Ordinal)) return;
        string? id = null;
        try
        {
            var message = JObject.Parse(args.WebMessageAsJson); id = (string?)message["id"];
            if (id == null || id.Length > 128 || args.WebMessageAsJson.Length > 256 * 1024) throw new InvalidOperationException("Invalid native message");
            var method = (string?)message["method"] ?? "";
            if (method != "descriptor" && method != "readSelection" && method != "readTarget" && method != "locate" && method != "applyEdit") throw new InvalidOperationException("Unsupported native operation");
            var document = AcApp.DocumentManager.MdiActiveDocument ?? throw new InvalidOperationException("Open a drawing first");
            if (queue.Count >= 20) throw new InvalidOperationException("Native document request queue is full");
            var request = new Request { Id = id, Method = method, Args = message["args"] as JObject ?? new JObject(), Document = document, Deadline = DateTime.UtcNow.AddSeconds(20), Epoch = epoch };
            // WebView callbacks return before entering AutoCAD's command context or showing GetSelection.
            web!.BeginInvoke(new Action(() => {
                try {
                    ValidateRequest(request);
                    if (queue.Count >= 20) throw new InvalidOperationException("Native document request queue is full");
                    queue.Enqueue(request);
                    // Never reactivate a drawing for a queued operation.
                    document.SendStringToExecute("SHDOCREQUEST ", false, false, false);
                } catch (AcException error) {
                    // Failed dispatch must not leave executable work behind.
                    var retained = new Queue<Request>();
                    while (queue.Count > 0) { var item = queue.Dequeue(); if (!ReferenceEquals(item, request)) retained.Enqueue(item); }
                    while (retained.Count > 0) queue.Enqueue(retained.Dequeue());
                    Reply(request.Id, null, error.Message);
                }
            }));
        }
        catch (AcException error) { Reply(id ?? "", null, error.Message); }
    }
    [CommandMethod("SHDOCREQUEST", CommandFlags.UsePickSet | CommandFlags.Redraw)]
    public void ProcessRequest()
    {
        if (queue.Count == 0) return;
        var request = queue.Dequeue();
        try
        {
            ValidateRequest(request);
            var value = request.Method == "descriptor" ? adapter.Descriptor(request.Document) : adapter.Execute(request.Document, request.Method, request.Args);
            Reply(request.Id, value, null);
        }
        catch (AcException error) { Reply(request.Id, null, error.Message); }
    }
    private static void Reply(string id, JToken? result, string? error)
    {
        if (web?.CoreWebView2 == null) return;
        var value = error == null ? new JObject { ["id"] = id, ["result"] = result } : new JObject { ["id"] = id, ["error"] = error };
        try { web.CoreWebView2.PostWebMessageAsJson(value.ToString(Newtonsoft.Json.Formatting.None)); }
        catch (AcException) { /* A destroyed pane cannot receive results; no operation is replayed. */ }
    }
    private static void ValidateRequest(Request request)
    {
        if (DateTime.UtcNow > request.Deadline) throw new InvalidOperationException("Native request expired before execution");
        if (request.Epoch != epoch || AcApp.DocumentManager.MdiActiveDocument != request.Document)
            throw new InvalidOperationException("Drawing or pane changed before execution");
    }
    private static void InvalidateRequests(string reason)
    {
        epoch++;
        while (queue.Count > 0) Reply(queue.Dequeue().Id, null, reason);
    }
    private static void DocumentActivated(object sender, DocumentCollectionEventArgs args)
    {
        if (ReferenceEquals(activeDocument, args.Document)) return;
        activeDocument = args.Document;
        InvalidateRequests("Drawing changed before execution");
        if (web?.CoreWebView2 != null) web.CoreWebView2.PostWebMessageAsJson(new JObject { ["event"] = "documentChanged" }.ToString());
    }
    private static void DocumentDestroyed(object sender, DocumentCollectionEventArgs args)
    {
        adapter.Forget(args.Document);
        if (!ReferenceEquals(activeDocument, args.Document)) return;
        activeDocument = null;
        InvalidateRequests("Drawing closed before execution");
        if (web?.CoreWebView2 != null) web.CoreWebView2.PostWebMessageAsJson(new JObject { ["event"] = "documentChanged" }.ToString());
    }
}
