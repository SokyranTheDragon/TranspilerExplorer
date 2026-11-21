using System;
using System.Collections.Concurrent;
using System.Linq;
using System.Reflection;
using System.Text;

namespace TranspilerExplorer
{
    // Stable string keys for methods and patches, so the frontend can keep a selection across list rebuilds and game restarts.
    //   MethodKey: assemblyName|Type.FullName|methodName|paramType1,paramType2   (ctor = .ctor, static ctor = .cctor)
    //   PatchKey:  patchType|owner|MethodKey(patch method)[#n]                  (#n only for the 2nd+ registration of the same method by the same owner)
    [HotSwappable]
    public static class Keys
    {
        public const BindingFlags All = BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance | BindingFlags.Static | BindingFlags.DeclaredOnly;

        // Every key handed out in this instance maps back to its method, which also covers methods that can't be found by name
        // (closed generic types/methods)
        private static readonly ConcurrentDictionary<string, MethodBase> known = new();

        public static string Of(MethodBase m)
        {
            var sb = new StringBuilder();
            sb.Append(AssemblyOf(m)).Append('|');
            sb.Append(DeclaringTypeName(m)).Append('|');
            sb.Append(m.Name);
            if (m.IsGenericMethod && !m.IsGenericMethodDefinition)
                sb.Append('<').Append(string.Join(",", m.GetGenericArguments().Select(TypeName))).Append('>');
            else if (m.IsGenericMethodDefinition)
                sb.Append('`').Append(m.GetGenericArguments().Length);
            sb.Append('|');
            sb.Append(string.Join(",", m.GetParameters().Select(p => TypeName(p.ParameterType))));

            var key = sb.ToString();
            known[key] = m;
            return key;
        }

        public static string AssemblyOf(MemberInfo m) => (m.DeclaringType?.Assembly ?? m.Module.Assembly).GetName().Name;

        public static string DeclaringTypeName(MemberInfo m) => m.DeclaringType == null ? "" : TypeName(m.DeclaringType);

        public static MethodBase Resolve(string key)
        {
            if (string.IsNullOrEmpty(key))
                return null;
            if (known.TryGetValue(key, out var cached))
                return cached;

            // Local function names contain '|' (<Tick>g__Local|5_0), so everything between the type and the parameters is the name
            var parts = key.Split('|');
            if (parts.Length < 4)
                return null;
            var name = string.Join("|", parts, 2, parts.Length - 3);

            foreach (var asm in AppDomain.CurrentDomain.GetAssemblies())
            {
                if (asm.GetName().Name != parts[0])
                    continue;

                Type type;
                try { type = asm.GetType(parts[1], false); }
                catch { continue; }
                if (type == null)
                    continue;

                var found = MethodsOf(type).FirstOrDefault(m => KeyMatches(m, name, key));
                if (found != null)
                    return found;
            }

            return null;
        }

        private static bool KeyMatches(MethodBase m, string name, string key)
        {
            // Generic suffixes (<T1,T2> or `N) follow the name, so a prefix check keeps this cheap. Compiler-generated names
            // start with '<' themselves (<GetGizmos>b__12_0), so the suffix can't be split off.
            return name.StartsWith(m.Name, StringComparison.Ordinal) && Of(m) == key;
        }

        public static MethodBase[] MethodsOf(Type type)
        {
            try
            {
                return [.. type.GetMethods(All).Cast<MethodBase>(), .. type.GetConstructors(All)];
            }
            catch
            {
                return [];
            }
        }

        // Namespace-qualified, nested types joined with '+', generic arguments as <A,B>. No assembly qualifiers.
        public static string TypeName(Type t)
        {
            if (t.IsByRef) return TypeName(t.GetElementType()) + "&";
            if (t.IsPointer) return TypeName(t.GetElementType()) + "*";
            if (t.IsArray) return TypeName(t.GetElementType()) + "[" + new string(',', t.GetArrayRank() - 1) + "]";
            if (t.IsGenericParameter) return t.Name;
            if (t.IsGenericType && !t.IsGenericTypeDefinition)
            {
                var def = t.GetGenericTypeDefinition();
                return (def.FullName ?? def.Name) + "<" + string.Join(",", t.GetGenericArguments().Select(TypeName)) + ">";
            }
            return t.FullName ?? ((t.Namespace == null ? "" : t.Namespace + ".") + t.Name);
        }
    }
}
