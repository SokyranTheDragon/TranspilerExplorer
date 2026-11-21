using HarmonyLib;
using ICSharpCode.Decompiler;
using ICSharpCode.Decompiler.DebugInfo;
using ICSharpCode.Decompiler.IL;
using ICSharpCode.Decompiler.IL.Transforms;
using ICSharpCode.Decompiler.TypeSystem;
using System;
using System.Collections.Generic;
using System.Linq;
using System.Reflection;
using System.Reflection.Emit;
using System.Reflection.Metadata.Ecma335;

namespace TranspilerExplorer
{
    [HotSwappable]
    public static class VariableNames
    {
        // MethodKey -> local names ILSpy picked for the unpatched build
        private static readonly Dictionary<string, Dictionary<int, string>> baseNames = new();

        // Names for a built method: the unpatched build's names, with Harmony's locals (__result, __state_X, ...) on top
        public static Dictionary<int, string> For(BuiltMethod built)
        {
            var names = new Dictionary<int, string>(BaseNames(built.original));
            foreach (var kv in built.harmonyLocalNames)
                names[kv.Key] = kv.Value;
            return names;
        }

        public static Dictionary<int, string> BaseNames(MethodBase original)
        {
            var key = Keys.Of(original);
            lock (baseNames)
                if (baseNames.TryGetValue(key, out var cached))
                    return cached;

            var names = new Dictionary<int, string>();
            try
            {
                var plain = MethodBuilder.Build(original, Array.Empty<CatalogPatch>());
                if (plain.dmd != null)
                    Decompiler.Decompile(plain, d => names = CollectVarNames(d), null);
            }
            catch
            {
                // No names then. ILSpy picks its own.
            }

            lock (baseNames)
                baseNames[key] = names;
            return names;
        }

        public static Dictionary<int, string> CollectVarNames(DecompilerSettingsWrapper d)
        {
            var names = new Dictionary<int, string>();

            // The dummy type can also hold infix helpers, so pick the main method by name
            var func = d.ilfuncs.FirstOrDefault(kv => kv.Key.Name == Decompiler.DummyMethod).Value ?? d.ilfuncs.Values.FirstOrDefault();
            if (func == null)
                return names;

            foreach (var l in func.Variables)
                if (l.Index.HasValue && l.Name != null)
                    names[l.Index.Value] = l.Name;

            return names;
        }
    }

    public class DecompilerSettingsWrapper : DecompilerSettings
    {
        public Dictionary<IMethod, ILFunction> ilfuncs = new Dictionary<IMethod, ILFunction>();
    }

    // Fake debug info that hands ILSpy fixed local names for the main method (MethodDef row 1, see Decompiler.WriteAssembly).
    // Locals past the highest named index are new (e.g. declared by a transpiler) and get newvarN.
    [HotSwappable]
    public class VariableNameProvider : IDebugInfoProvider
    {
        private readonly Dictionary<int, string> vars;
        private readonly int maxIndex;

        public VariableNameProvider(Dictionary<int, string> vars)
        {
            this.vars = vars;
            maxIndex = this.vars.Count == 0 ? -1 : this.vars.Keys.Max();
        }

        public string Description => throw new NotImplementedException();

        public string SourceFileName => throw new NotImplementedException();

        public IList<SequencePoint> GetSequencePoints(System.Reflection.Metadata.MethodDefinitionHandle method)
        {
            return null;
        }

        public IList<Variable> GetVariables(System.Reflection.Metadata.MethodDefinitionHandle method)
        {
            throw new NotImplementedException();
        }

        public bool TryGetName(System.Reflection.Metadata.MethodDefinitionHandle method, int index, out string name)
        {
            name = null;
            if (MetadataTokens.GetRowNumber(method) != 1)
                return false;

            if (!vars.TryGetValue(index, out name) && index > maxIndex)
                name = $"newvar{index}";
            return name != null;
        }

        public bool TryGetExtraTypeInfo(System.Reflection.Metadata.MethodDefinitionHandle method, int index, out PdbExtraTypeInfo extraTypeInfo)
        {
            extraTypeInfo = default;
            return false;
        }
    }

    [HarmonyPatch(typeof(AssignVariableNames), nameof(AssignVariableNames.Run))]
    static class AssignVariableNamesPatch
    {
        private static void Postfix(ILFunction function, ILTransformContext context)
        {
            // Track assigned variable names
            if (context.Settings is DecompilerSettingsWrapper wrapper)
                wrapper.ilfuncs[function.Method] = function;
        }
    }

    // ILSpy 9 moved GenerateNameForVariable(ILVariable) into the nested VariableScope class (instance method, so the variable
    // is still argument 1)
    [HarmonyPatch]
    static class AssignVariableNamesPatch2
    {
        private static MethodBase TargetMethod() => AccessTools.Method(AccessTools.Inner(typeof(AssignVariableNames), "VariableScope"), "GenerateNameForVariable");

        private static MethodBase processMethod = AccessTools.Method(typeof(AssignVariableNamesPatch2), nameof(ProcessProposedName));

        private static IEnumerable<CodeInstruction> Transpiler(IEnumerable<CodeInstruction> insts)
        {
            foreach (var inst in insts)
            {
                yield return inst;
                if (inst.operand is MethodBase m && m.Name == "SplitName")
                {
                    yield return new CodeInstruction(OpCodes.Ldarg_1);
                    yield return new CodeInstruction(OpCodes.Call, processMethod);
                }
            }
        }

        private static string[] varKindSuffix =
        [
            "l", "pil", "pirl", "ul", "fl", "it", "p", "es", "s", "na", "dcl", "pl", "dit"
        ];

        private static string ProcessProposedName(string proposedName, ILVariable var)
        {
            var kind = (int)var.Kind;
            return proposedName + (kind < varKindSuffix.Length ? varKindSuffix[kind] : "v" + kind);
        }
    }
}
