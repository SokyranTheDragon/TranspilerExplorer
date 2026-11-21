using HarmonyLib;
using System;
using System.Collections.Generic;
using System.Linq;
using System.Reflection;

namespace TranspilerExplorer
{
    // Type search for method lookup (/types, /methods, /resolve). The type list is built once per game instance.
    [HotSwappable]
    public static class TypeIndex
    {
        private static (Type type, string name, string dotted)[] types;

        private static (Type type, string name, string dotted)[] Types
        {
            get
            {
                if (types == null)
                {
                    var list = new List<(Type, string, string)>();
                    foreach (var t in AccessTools.AllTypes())
                    {
                        try
                        {
                            if (t?.FullName == null)
                                continue;
                            var name = Keys.TypeName(t);
                            list.Add((t, name, Dotted(name)));
                        }
                        catch
                        {
                            // Types that fail to load are skipped
                        }
                    }
                    types = [.. list];
                }
                return types;
            }
        }

        // Ranked: exact full name, exact short name, short name prefix, full name contains
        public static IEnumerable<Type> Search(string query, int limit)
        {
            var dotted = Dotted(query.Replace("::", "."));
            int Rank((Type type, string name, string dotted) e)
            {
                if (Eq(e.dotted, dotted)) return 0;
                if (Eq(e.type.Name, query)) return 1;
                if (e.type.Name.StartsWith(query, StringComparison.OrdinalIgnoreCase)) return 2;
                if (Contains(e.dotted, dotted)) return 3;
                return -1;
            }

            return Types
                .Select(e => (e, rank: Rank(e)))
                .Where(x => x.rank >= 0)
                .OrderBy(x => x.rank)
                .ThenBy(x => x.e.type.Name.StartsWith("<") ? 1 : 0)
                .ThenBy(x => x.e.name.Length)
                .Take(limit)
                .Select(x => x.e.type);
        }

        public static Type Find(string name, string assembly)
        {
            if (string.IsNullOrWhiteSpace(name))
                return null;
            name = name.Trim();

            // Cheap name filter first; the assembly name allocates, so it's only read for the few types that match
            var dotted = Dotted(name);
            var candidates = Types.Where(e => Eq(e.dotted, dotted) && (assembly == null || e.type.Assembly.GetName().Name == assembly)).ToArray();
            return candidates.FirstOrDefault(e => e.name == name).type
                ?? candidates.FirstOrDefault().type
                ?? (assembly == null ? AccessTools.TypeByName(name) : null);
        }

        // Free text: "Ns.Type:Method", "Ns.Type::Method", "Type.Method", optionally followed by "(int, string)".
        // A method key is accepted as well.
        public static List<MethodBase> ResolveMethods(string text, int limit)
        {
            text = text?.Trim() ?? "";
            if (text.Length == 0)
                return [];

            if (text.Count(c => c == '|') >= 3 && Keys.Resolve(text) is { } byKey)
                return [byKey];

            string[] paramNames = null;
            var paren = text.IndexOf('(');
            if (paren >= 0)
            {
                var inner = text.Substring(paren + 1).TrimEnd(')', ' ');
                paramNames = inner.Length == 0 ? [] : SplitParams(inner);
                text = text.Substring(0, paren).Trim();
            }

            text = text.Replace("::", ":");
            int split;
            var colon = text.LastIndexOf(':');
            if (colon >= 0)
                split = colon;
            else if (text.EndsWith("..cctor"))
                split = text.Length - 7;
            else if (text.EndsWith("..ctor"))
                split = text.Length - 6;
            else
                split = text.LastIndexOf('.');

            if (split <= 0 || split >= text.Length - 1)
                return [];

            var typePart = text.Substring(0, split);
            var methodPart = text.Substring(split + 1);
            var dottedType = Dotted(typePart);

            return
            [
                .. Types
                    .Where(e => Eq(e.dotted, dottedType) || Eq(e.type.Name, typePart) || e.dotted.EndsWith("." + dottedType, StringComparison.OrdinalIgnoreCase))
                    .SelectMany(e => Keys.MethodsOf(e.type))
                    .Where(m => Eq(m.Name, methodPart))
                    .Where(m => paramNames == null || ParamsMatch(m, paramNames))
                    .Take(limit)
            ];
        }

        private static string[] SplitParams(string s)
        {
            // Split on top-level commas only (generic arguments have commas too)
            var parts = new List<string>();
            int depth = 0, start = 0;
            for (var i = 0; i < s.Length; i++)
            {
                if (s[i] == '<' || s[i] == '[') depth++;
                else if (s[i] == '>' || s[i] == ']') depth--;
                else if (s[i] == ',' && depth == 0)
                {
                    parts.Add(s.Substring(start, i - start).Trim());
                    start = i + 1;
                }
            }
            parts.Add(s.Substring(start).Trim());
            return [.. parts];
        }

        private static readonly Dictionary<string, Type> Aliases = new()
        {
            ["bool"] = typeof(bool), ["byte"] = typeof(byte), ["sbyte"] = typeof(sbyte), ["char"] = typeof(char),
            ["short"] = typeof(short), ["ushort"] = typeof(ushort), ["int"] = typeof(int), ["uint"] = typeof(uint),
            ["long"] = typeof(long), ["ulong"] = typeof(ulong), ["float"] = typeof(float), ["double"] = typeof(double),
            ["decimal"] = typeof(decimal), ["string"] = typeof(string), ["object"] = typeof(object),
        };

        private static bool ParamsMatch(MethodBase m, string[] names)
        {
            var ps = m.GetParameters();
            if (ps.Length != names.Length)
                return false;

            for (var i = 0; i < ps.Length; i++)
            {
                var want = names[i];
                var byRef = want.EndsWith("&");
                foreach (var prefix in new[] { "ref ", "out ", "in " })
                    if (want.StartsWith(prefix))
                    {
                        want = want.Substring(prefix.Length);
                        byRef = true;
                    }
                want = want.TrimEnd('&').Trim();

                var type = ps[i].ParameterType;
                if (byRef != type.IsByRef)
                    return false;
                if (byRef)
                    type = type.GetElementType();

                var matches = Aliases.TryGetValue(want, out var alias)
                    ? alias == type
                    : Eq(type.Name, want) || Eq(Dotted(Keys.TypeName(type)), Dotted(want));
                if (!matches)
                    return false;
            }
            return true;
        }

        private static string Dotted(string s) => s.Replace('+', '.');
        private static bool Eq(string a, string b) => string.Equals(a, b, StringComparison.OrdinalIgnoreCase);
        private static bool Contains(string a, string b) => a.IndexOf(b, StringComparison.OrdinalIgnoreCase) >= 0;
    }
}
