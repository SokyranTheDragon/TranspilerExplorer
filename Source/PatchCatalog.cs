using HarmonyLib;
using System;
using System.Collections.Generic;
using System.Linq;
using System.Reflection;

namespace TranspilerExplorer
{
    public enum PatchType { Prefix, Postfix, Transpiler, Finalizer, InnerPrefix, InnerPostfix, InnerFinalizer }

    public class CatalogPatch
    {
        public string key;
        public PatchType type;
        public Patch patch;
        public MethodInfo method;
        public int order;       // position in Harmony's sorted execution order within its patch type
        public bool erroring;   // only present in a failed UpdateWrapper call, not in the current PatchInfo
        public string error;
    }

    public class CatalogMethod
    {
        public string key;
        public MethodBase method;
        public List<CatalogPatch> patches = new();
        public bool Erroring => patches.Any(p => p.erroring);
    }

    // Snapshot of every Harmony-patched method with all 7 patch types, plus the patches of failed UpdateWrapper calls that
    // aren't in the current PatchInfo
    [HotSwappable]
    public static class PatchCatalog
    {
        public static readonly PatchType[] AllTypes = (PatchType[])Enum.GetValues(typeof(PatchType));

        public static Patch[] Get(PatchInfo info, PatchType type) => (type switch
        {
            PatchType.Prefix => info.prefixes,
            PatchType.Postfix => info.postfixes,
            PatchType.Transpiler => info.transpilers,
            PatchType.Finalizer => info.finalizers,
            PatchType.InnerPrefix => info.innerprefixes,
            PatchType.InnerPostfix => info.innerpostfixes,
            PatchType.InnerFinalizer => info.innerfinalizers,
            _ => null
        }) ?? Array.Empty<Patch>();

        // The only place (with Get) that spells out PatchInfo's patch fields
        public static PatchInfo Make(Func<PatchType, Patch[]> of, int versionCount) => new PatchInfo
        {
            prefixes = of(PatchType.Prefix),
            postfixes = of(PatchType.Postfix),
            transpilers = of(PatchType.Transpiler),
            finalizers = of(PatchType.Finalizer),
            innerprefixes = of(PatchType.InnerPrefix),
            innerpostfixes = of(PatchType.InnerPostfix),
            innerfinalizers = of(PatchType.InnerFinalizer),
            VersionCount = versionCount,
        };

        // Methods with at least one current patch or a failed patch attempt
        public static List<MethodBase> PatchedMethods(PatchFailures.Failure[] failures)
        {
            lock (MethodBodyPatching.ProtocolLock)
                return Harmony.GetAllPatchedMethods()
                    .Where(m => HarmonySharedState.GetPatchInfo(m) is { } info && AllTypes.Any(t => Get(info, t).Length > 0))
                    .Concat(failures.Select(f => f.original))
                    .Distinct()
                    .ToList();
        }

        public static List<CatalogMethod> Snapshot()
        {
            lock (MethodBodyPatching.ProtocolLock)
            {
                var failures = PatchFailures.All;
                var result = new List<CatalogMethod>();
                foreach (var m in PatchedMethods(failures))
                {
                    var entry = ForMethod(m, failures);
                    if (entry.patches.Count > 0)
                        result.Add(entry);
                }
                return result;
            }
        }

        public static CatalogMethod ForMethod(MethodBase original) => ForMethod(original, PatchFailures.All);

        private static CatalogMethod ForMethod(MethodBase original, PatchFailures.Failure[] failures)
        {
            lock (MethodBodyPatching.ProtocolLock)
            {
                var entry = new CatalogMethod { key = Keys.Of(original), method = original };
                var current = HarmonySharedState.GetPatchInfo(original) ?? new PatchInfo();

                foreach (var type in AllTypes)
                {
                    var patches = WithKeys(Get(current, type), type).ToList();

                    // Newest failure first, so a patch that failed several times shows its latest error
                    var seen = new HashSet<string>(patches.Select(p => p.key));
                    foreach (var f in failures.Where(f => f.original == original).Reverse())
                        foreach (var p in WithKeys(Get(f.info, type), type))
                            if (seen.Add(p.key))
                            {
                                p.erroring = true;
                                p.error = f.error;
                                patches.Add(p);
                            }

                    AssignOrder(patches);
                    entry.patches.AddRange(patches.OrderBy(p => p.order));
                }

                return entry;
            }
        }

        private static IEnumerable<CatalogPatch> WithKeys(Patch[] patches, PatchType type)
        {
            var counts = new Dictionary<string, int>();
            foreach (var p in patches)
            {
                MethodInfo method;
                try { method = p.PatchMethod; }
                catch { method = null; }
                if (method == null)
                    continue;

                var key = $"{type}|{p.owner}|{Keys.Of(method)}";
                counts.TryGetValue(key, out var n);
                counts[key] = ++n;
                yield return new CatalogPatch { key = n == 1 ? key : $"{key}#{n}", type = type, patch = p, method = method };
            }
        }

        // Harmony's own sorter (priority, before/after, registration index) decides the execution order
        private static void AssignOrder(List<CatalogPatch> patches)
        {
            Patch[] sorted;
            try { sorted = new PatchSorter(patches.Select(p => p.patch).ToArray(), false).Sort(); }
            catch { sorted = Array.Empty<Patch>(); }

            var next = sorted.Length;
            foreach (var p in patches)
            {
                var i = Array.FindIndex(sorted, s => ReferenceEquals(s, p.patch));
                p.order = i >= 0 ? i : next++;
            }
        }

        // Patches of `entry` with the given keys. Unknown keys are reported in `missing`.
        public static List<CatalogPatch> Select(CatalogMethod entry, IEnumerable<string> keys, List<string> missing)
        {
            var byKey = entry.patches.ToDictionary(p => p.key);
            var selected = new List<CatalogPatch>();
            foreach (var k in keys.Distinct())
            {
                if (byKey.TryGetValue(k, out var p))
                    selected.Add(p);
                else
                    missing?.Add(k);
            }
            return selected;
        }
    }
}
