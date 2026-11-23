using HarmonyLib;
using MonoMod.Utils;
using System;
using System.Collections.Generic;
using System.Linq;
using System.Reflection;
using System.Reflection.Emit;

namespace TranspilerExplorer
{
    public class BuiltMethod
    {
        public MethodBase original;
        public MethodCreatorConfig config;
        public DynamicMethodDefinition dmd;

        // Harmony's structured infix helpers: generated for real, the main body calls them
        public List<(DynamicMethodDefinition dmd, MethodInfo generated)> helpers = new();
        // The helper each helper call in the main body targets, in body order (Cecil can only match them by position)
        public List<MethodInfo> helperCalls = new();

        // LocalBuilder.LocalIndex -> readable name for the locals Harmony adds (__result, __runOriginal, __state_X, ...)
        public Dictionary<int, string> harmonyLocalNames = new();
        public List<string> warnings = new();
        public string error;
    }

    // Builds a method through Harmony's own pipeline (SingleConfig + MethodCreator.CreateReplacement) with any subset of
    // its patches, and captures the DynamicMethodDefinition instead of compiling and installing it.
    // Every Harmony internal this tool depends on for building is used here.
    [HotSwappable]
    public static class MethodBuilder
    {
        [ThreadStatic] internal static bool capturing;
        [ThreadStatic] internal static List<(DynamicMethodDefinition dmd, MethodInfo generated)> capturedHelpers;
        [ThreadStatic] internal static List<MethodInfo> capturedHelperCalls;
        [ThreadStatic] internal static List<string> captureWarnings;

        public static BuiltMethod Build(MethodBase original, IEnumerable<CatalogPatch> selected)
        {
            var byType = selected.ToLookup(p => p.type, p => p.patch);

            try
            {
                lock (MethodBodyPatching.ProtocolLock)
                {
                    var info = PatchCatalog.Make(t => byType[t].ToArray(), HarmonySharedState.GetPatchInfo(original)?.VersionCount ?? 0);

                    var built = Capture(PatchFunctions.SingleConfig(original, info, false), original);

                    var familyOwner = MethodBodyPatching.FamilyOwner(original) ?? original;
                    if (MethodBodyPatching.IsDefinitionWide(familyOwner))
                        built.warnings.Add("This method is patched definition-wide (generic family patching). It was built for this instantiation only, so the result can differ from what Harmony installed.");

                    return built;
                }
            }
            catch (Exception e)
            {
                return new BuiltMethod { original = original, error = e.ToString() };
            }
        }

        // Runs CreateReplacement with GenerateMethod skipped for the main method. Errors are returned, not thrown.
        internal static BuiltMethod Capture(MethodCreatorConfig config, MethodBase original)
        {
            var built = new BuiltMethod { original = original, config = config };
            var creator = new MethodCreator(config);

            capturing = true;
            capturedHelpers = built.helpers;
            capturedHelperCalls = null;
            captureWarnings = built.warnings;
            try
            {
                creator.CreateReplacement();
                built.dmd = config.patch;
            }
            catch (Exception e)
            {
                built.error = e.ToString();
            }
            finally
            {
                if (capturedHelperCalls != null)
                    built.helperCalls = capturedHelperCalls;
                capturing = false;
                capturedHelpers = null;
                capturedHelperCalls = null;
                captureWarnings = null;
            }

            try
            {
                CollectLocalNames(config, built.harmonyLocalNames);
            }
            catch (Exception e)
            {
                built.warnings.Add("Couldn't name Harmony's locals: " + e.Message);
            }

            return built;
        }

        private static void CollectLocalNames(MethodCreatorConfig c, Dictionary<int, string> names)
        {
            void L(LocalBuilder lb, string name)
            {
                if (lb == null || names.ContainsKey(lb.LocalIndex))
                    return;

                var unique = name;
                for (var i = 2; names.ContainsValue(unique); i++)
                    unique = name + i;
                names[lb.LocalIndex] = unique;
            }

            L(c.resultVariable, "__result");
            L(c.runOriginalVariable, "__runOriginal");
            L(c.exceptionVariable, "__exception");
            L(c.finalizedVariable, "__finalized");

            if (c.localVariables == null)
                return;

            // __state locals are keyed by the patch's declaring type, or (declaring type, instantiation) for generic families
            foreach (var kv in c.localVariables.other)
            {
                if (kv.Value.local == null)
                    continue;

                var type = kv.Key switch
                {
                    Type t => t,
                    ValueTuple<Type, MethodBase> tuple => tuple.Item1,
                    _ => null
                };
                L(kv.Value.local, type == null ? "__state" : "__state_" + Identifier(type.Name));
            }
        }

        private static string Identifier(string s) => new string(s.Select(ch => char.IsLetterOrDigit(ch) || ch == '_' ? ch : '_').ToArray());
    }

    // Stands in for an instruction Harmony can't emit, so the rest of the method can still be shown.
    // Decompiles as `InvalidInstruction.Here("callvirt NULL")`.
    public static class InvalidInstruction
    {
        public static void Here(string instruction) { }
    }

    // Harmony throws on an instruction with a missing or wrong-kind operand (a transpiler's `callvirt NULL`, say), which
    // would lose the whole method. While capturing, swap each such instruction for `ldstr "<instruction>"` +
    // `call InvalidInstruction.Here(string)`. That has no net stack effect, so the real one's is lost, but the code around it reads fine.
    [HarmonyPatch(typeof(MethodCreatorTools), nameof(MethodCreatorTools.EmitCodes))]
    static class ReplaceInvalidInstructionsPatch
    {
        private static readonly MethodInfo Here = AccessTools.Method(typeof(InvalidInstruction), nameof(InvalidInstruction.Here));

        private static void Prefix(List<CodeInstruction> codeInstructions)
        {
            if (!MethodBuilder.capturing || codeInstructions == null)
                return;

            for (var i = 0; i < codeInstructions.Count; i++)
            {
                var ci = codeInstructions[i];
                if (!IsInvalid(ci))
                    continue;

                var text = ci.ToString();
                MethodBuilder.captureWarnings?.Add($"Invalid instruction `{text}` (a transpiler emitted it with a missing or wrong operand). Harmony would fail to patch this method; it's shown as InvalidInstruction.Here(\"{text}\").");

                // Labels and the exception blocks Harmony begins before an instruction go on the first one, the blocks it ends after it on the last one
                var load = new CodeInstruction(OpCodes.Ldstr, text) { labels = ci.labels };
                var call = new CodeInstruction(OpCodes.Call, Here);
                foreach (var block in ci.blocks)
                    (block.blockType == ExceptionBlockType.EndExceptionBlock ? call : load).blocks.Add(block);

                codeInstructions[i] = load;
                codeInstructions.Insert(++i, call);
            }
        }

        // Mirrors the checks in MethodCreatorTools.EmitCodes
        private static bool IsInvalid(CodeInstruction ci) =>
            ci.opcode.OperandType switch
            {
                OperandType.InlineNone => false,
                OperandType.InlineSig => ci.operand is not ICallSiteGenerator,
                _ => ci.operand == null
            };
    }

    [HarmonyPatch(typeof(MethodCreatorConfig), nameof(MethodCreatorConfig.GenerateMethod))]
    static class SkipGenerateMethodPatch
    {
        // Only the main replacement is skipped. Infix sites with finalizers are emitted as separate "structured helper"
        // methods that the main body calls, so those have to be generated for real (a null result becomes `call null`).
        private static bool Prefix(MethodCreatorConfig __instance, bool structuredHelper, ref MethodInfo __result)
        {
            if (!MethodBuilder.capturing || structuredHelper)
                return true;

            // config.instructions is what was just emitted into the DMD, in order. Record which helper each helper call targets.
            var helpers = MethodBuilder.capturedHelpers;
            if (helpers != null && __instance.instructions != null)
                MethodBuilder.capturedHelperCalls = __instance.instructions
                    .Where(ci => (ci.opcode == OpCodes.Call || ci.opcode == OpCodes.Callvirt) && ci.operand is MethodInfo m && helpers.Any(h => h.generated == m))
                    .Select(ci => (MethodInfo)ci.operand)
                    .ToList();

            __result = null;
            return false;
        }

        private static void Postfix(MethodCreatorConfig __instance, bool structuredHelper, MethodInfo __result)
        {
            if (MethodBuilder.capturing && structuredHelper)
                MethodBuilder.capturedHelpers?.Add((__instance.patch, __result));
        }
    }
}
