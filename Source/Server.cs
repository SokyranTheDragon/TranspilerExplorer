using HarmonyLib;
using Newtonsoft.Json.Linq;
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Net;
using System.Reflection;

namespace TranspilerExplorer
{
    // A method /code can't show, with the reason shown to the user instead of code
    public class UnsupportedException : Exception
    {
        public UnsupportedException(string message) : base(message) { }
    }

    [HotSwappable]
    public class Server
    {
        public HttpListener listener;
        public bool running = true;

        // New every game start, so the frontend can tell a restart from a reconnect
        public static readonly string Instance = Guid.NewGuid().ToString();

        private int port;
        private string contentFolder;

        public Server(int port, string contentFolder)
        {
            this.port = port;
            this.contentFolder = contentFolder;
        }

        // Runs on its own thread. On 1.7 (CoreCLR) an exception escaping it would end the game, so nothing may.
        public void Start()
        {
            try
            {
                listener = new HttpListener();
                listener.Prefixes.Add($"http://localhost:{port}/");
                listener.Start();
            }
            catch (Exception e)
            {
                Verse.Log.Error($"[Transpiler Explorer] Couldn't start the server on port {port} (in use by another program or game instance?): {e.Message}");
                return;
            }

            HandleRequests();

            try { listener.Close(); }
            catch { /* already closed by /stop */ }
        }

        private void HandleRequests()
        {
            while (running)
            {
                HttpListenerContext ctx;
                try
                {
                    ctx = listener.GetContext();
                }
                catch (Exception e)
                {
                    // /stop closes the listener, which ends a pending GetContext
                    if (!running || !listener.IsListening)
                        return;
                    Verse.Log.Warning($"[Transpiler Explorer] Server: {e.Message}");
                    continue;
                }

                try
                {
                    HandleRequest(ctx);
                }
                catch
                {
                    // Writing the error failed too (the browser went away)
                }

                try { ctx.Response.Close(); }
                catch { /* client gone */ }
            }
        }

        private void HandleRequest(HttpListenerContext ctx)
        {
            var cmd = ctx.Request.Url.PathPart(0);

            try
            {
                switch (ctx.Request.HttpMethod, cmd)
                {
                    case ("POST", "stop"): Stop(); break;
                    case ("POST", "patches"): ServePatches(ctx); break;
                    case ("POST", "code"): ServeCode(ctx); break;
                    case ("POST", "types"): ServeTypes(ctx); break;
                    case ("POST", "methods"): ServeMethods(ctx); break;
                    case ("POST", "resolve"): ServeResolve(ctx); break;
                    case ("GET", "alive"): ServeAlive(ctx); break;
                    case ("GET", _): ServeFile(ctx); break;
                    default: NotFound(ctx); break;
                }
            }
            catch (Exception e)
            {
                ctx.Response.StatusCode = 500;
                ctx.Response.WriteJson(new JObject { ["exception"] = e.ToString() });
            }
        }

        // Frees the port now: the loop exits after this request instead of waiting for another one
        private void Stop()
        {
            running = false;
            listener.Stop();
        }

        private static void NotFound(HttpListenerContext ctx) => ctx.Response.StatusCode = 404;

        private static readonly Dictionary<string, string> ContentTypes = new(StringComparer.OrdinalIgnoreCase)
        {
            [".html"] = "text/html; charset=utf-8",
            [".js"] = "text/javascript; charset=utf-8",
            [".mjs"] = "text/javascript; charset=utf-8",
            [".css"] = "text/css; charset=utf-8",
            [".json"] = "application/json; charset=utf-8",
            [".svg"] = "image/svg+xml",
            [".png"] = "image/png",
            [".ico"] = "image/x-icon",
            [".txt"] = "text/plain; charset=utf-8",
        };

        private void ServeFile(HttpListenerContext ctx)
        {
            var reqPath = Uri.UnescapeDataString(ctx.Request.Url.AbsolutePath);
            var root = Path.GetFullPath(contentFolder).TrimEnd('/', '\\') + Path.DirectorySeparatorChar;
            var path = Path.GetFullPath(Path.Combine(root, (reqPath == "/" ? "index.html" : reqPath).TrimStart('/', '\\')));

            if (!path.StartsWith(root, StringComparison.OrdinalIgnoreCase) || !File.Exists(path))
            {
                NotFound(ctx);
                return;
            }

            if (ContentTypes.TryGetValue(Path.GetExtension(path), out var type))
                ctx.Response.ContentType = type;
            ctx.Response.Headers["Cache-Control"] = "no-store";
            ctx.Response.WriteBytes(File.ReadAllBytes(path));
        }

        private void ServeAlive(HttpListenerContext ctx)
        {
            ctx.Response.Headers["Cache-Control"] = "no-store";
            ctx.Response.WriteJson(new JObject { ["instance"] = Instance, ["patchVersion"] = PatchFailures.PatchVersion });
        }

        private void ServePatches(HttpListenerContext ctx)
        {
            // Read the version first: a change during the snapshot then shows up as a newer version on the next /alive
            var version = PatchFailures.PatchVersion;
            var catalog = PatchCatalog.Snapshot();

            ctx.Response.WriteJson(new JObject
            {
                ["instance"] = Instance,
                ["patchVersion"] = version,
                ["methods"] = new JArray(catalog.Select(MethodJson)),
            });
        }

        private static JObject MethodJson(CatalogMethod m) => new()
        {
            ["key"] = m.key,
            ["name"] = m.method.Name,
            ["type"] = Keys.DeclaringTypeName(m.method),
            ["signature"] = SafeDescription(m.method),
            ["targetAssembly"] = Keys.AssemblyOf(m.method),
            ["erroring"] = m.Erroring,
            ["patches"] = new JArray(m.patches.Select(p => new JObject
            {
                ["key"] = p.key,
                ["methodKey"] = Keys.Of(p.method),
                ["type"] = p.type.ToString(),
                ["name"] = p.method.Name,
                ["declaringType"] = Keys.DeclaringTypeName(p.method),
                ["patchAssembly"] = Keys.AssemblyOf(p.method),
                ["owner"] = p.patch.owner,
                ["priority"] = p.patch.priority,
                ["before"] = new JArray(p.patch.before ?? Array.Empty<string>()),
                ["after"] = new JArray(p.patch.after ?? Array.Empty<string>()),
                ["order"] = p.order,
                ["erroring"] = p.erroring,
                ["error"] = p.error,
            })),
        };

        // { method, patches: [keys], lang: "cs"|"il", source? } -> { code, warnings } or { exception, unsupported?, warnings }.
        // source: "compiled" decompiles the method from its assembly file instead (CompiledSource), patches ignored, and adds
        // { source, file }.
        private void ServeCode(HttpListenerContext ctx)
        {
            var body = ctx.Request.ReadJson();
            var methodKey = (string)body["method"];
            var il = (string)body["lang"] == "il";
            var compiled = (string)body["source"] == "compiled";
            var warnings = new List<string>();
            var resp = new JObject();

            var original = Keys.Resolve(methodKey);
            if (original == null)
                resp["exception"] = $"Method not found: {methodKey}";
            else
            {
                try
                {
                    CheckSupported(original, compiled);
                    if (compiled)
                    {
                        resp["source"] = "compiled";
                        resp["code"] = CompiledSource.Decompile(original, il, warnings, out var file);
                        resp["file"] = file;
                    }
                    else
                    {
                        var (code, exception) = BuildCode(original, body["patches"]?.Values<string>() ?? Enumerable.Empty<string>(), il, warnings);
                        resp[code != null ? "code" : "exception"] = code ?? exception;
                    }
                }
                catch (UnsupportedException e)
                {
                    resp["exception"] = e.Message;
                    resp["unsupported"] = true;
                }
                catch (Exception e)
                {
                    resp["exception"] = e.ToString();
                }
            }

            resp["warnings"] = new JArray(warnings);
            ctx.Response.WriteJson(resp);
        }

        private static (string code, string exception) BuildCode(MethodBase original, IEnumerable<string> keys, bool il, List<string> warnings)
        {
            var missing = new List<string>();
            var selected = PatchCatalog.Select(PatchCatalog.ForMethod(original), keys, missing);

            warnings.AddRange(missing.Select(k => $"Patch not found (it may have been removed): {k}"));
            var erroring = selected.Count(p => p.erroring);
            if (erroring > 0)
                warnings.Add($"Includes {erroring} patch(es) that failed to apply in game.");

            var built = MethodBuilder.Build(original, selected);
            warnings.AddRange(built.warnings);
            if (built.error != null)
                return (null, built.error);

            return (il ? Decompiler.Disasm(built) : Decompiler.Decompile(built), null);
        }

        // Methods /code can't show. Open generics only matter for Harmony builds; the compiled source shows their definition.
        private static void CheckSupported(MethodBase m, bool compiled)
        {
            if (!HasBody(m))
                throw new UnsupportedException("This method has no body (abstract, extern, an interface method or implemented by the runtime), so there is no code to show.");
            // Harmony can't create a DynamicMethodDefinition with open generic parameters (MMReflectionImporter throws
            // NotSupportedException), so neither definitions nor methods of generic type definitions (List<T>.Add) build
            if (!compiled && IsOpenGeneric(m))
                throw new UnsupportedException("Open generic methods (generic method definitions, and methods of generic types such as List<T>.Add) aren't supported yet. Only closed instantiations can be built, for example one that is patched. \"As compiled\" can show it.");
        }

        // { query } -> up to 50 [{ name, assembly }]
        private void ServeTypes(HttpListenerContext ctx)
        {
            var query = ((string)ctx.Request.ReadJson()["query"] ?? "").Trim();
            var result = new JArray();

            if (query.Length > 0)
            {
                foreach (var t in TypeIndex.Search(query, 50))
                    result.Add(new JObject { ["name"] = Keys.TypeName(t), ["assembly"] = t.Assembly.GetName().Name });
            }

            ctx.Response.WriteJson(result);
        }

        // { type, assembly? } -> [{ key, name, signature, declaringType, hasBody, openGeneric, patched }], including compiler-generated nested types
        private void ServeMethods(HttpListenerContext ctx)
        {
            var body = ctx.Request.ReadJson();
            var type = TypeIndex.Find((string)body["type"], (string)body["assembly"]);
            if (type == null)
            {
                ctx.Response.StatusCode = 404;
                ctx.Response.WriteJson(new JObject { ["exception"] = $"Type not found: {body["type"]}" });
                return;
            }

            var patched = PatchedSet();
            var result = new JArray();
            foreach (var t in WithCompilerGenerated(type))
                foreach (var m in Keys.MethodsOf(t))
                    result.Add(MethodRefJson(m, patched));

            ctx.Response.WriteJson(result);
        }

        private static IEnumerable<Type> WithCompilerGenerated(Type type)
        {
            yield return type;

            Type[] nested;
            try { nested = type.GetNestedTypes(BindingFlags.Public | BindingFlags.NonPublic); }
            catch { yield break; }

            foreach (var n in nested.Where(n => n.Name.StartsWith("<")))
                foreach (var t in WithCompilerGenerated(n))
                    yield return t;
        }

        // { text } -> [{ key, name, signature, declaringType, hasBody, openGeneric, patched }] for free text like Verse.Pawn:Tick,
        // Pawn.Tick or RimWorld.X:Y(int, string)
        private void ServeResolve(HttpListenerContext ctx)
        {
            var text = (string)ctx.Request.ReadJson()["text"] ?? "";
            var patched = PatchedSet();
            ctx.Response.WriteJson(new JArray(TypeIndex.ResolveMethods(text, 50).Select(m => MethodRefJson(m, patched))));
        }

        // Every patch or unpatch bumps PatchVersion, so the set only needs rebuilding then (not on every lookup keystroke)
        private static (int version, HashSet<MethodBase> set) patched = (-1, null);

        private static HashSet<MethodBase> PatchedSet()
        {
            var version = PatchFailures.PatchVersion;
            if (patched.version != version)
                patched = (version, new HashSet<MethodBase>(PatchCatalog.PatchedMethods(PatchFailures.All)));
            return patched.set;
        }

        private static JObject MethodRefJson(MethodBase m, HashSet<MethodBase> patched) => new()
        {
            ["key"] = Keys.Of(m),
            ["name"] = m.Name,
            ["signature"] = SafeDescription(m),
            ["declaringType"] = Keys.DeclaringTypeName(m),
            ["hasBody"] = HasBody(m),
            ["openGeneric"] = IsOpenGeneric(m),
            ["patched"] = patched.Contains(m),
        };

        private static bool IsOpenGeneric(MethodBase m) => m.IsGenericMethodDefinition || m.DeclaringType?.ContainsGenericParameters == true;

        private static bool HasBody(MethodBase m)
        {
            try
            {
                if (m.IsAbstract || (m.Attributes & MethodAttributes.PinvokeImpl) != 0)
                    return false;
                if ((m.GetMethodImplementationFlags() & (MethodImplAttributes.InternalCall | MethodImplAttributes.Runtime)) != 0)
                    return false;
                return m.GetMethodBody() != null;
            }
            catch
            {
                return false;
            }
        }

        private static string SafeDescription(MethodBase m)
        {
            try { return m.FullDescription(); }
            catch { return m.ToString(); }
        }
    }
}
