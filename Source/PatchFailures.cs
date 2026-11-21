using HarmonyLib;
using System;
using System.Collections.Generic;
using System.Linq;
using System.Reflection;
using System.Threading;

namespace TranspilerExplorer
{
    // Finalizer on Harmony's PatchFunctions.UpdateWrapper (patched early, in the Mod constructor).
    // Every call (patch or unpatch, successful or not) bumps PatchVersion, the frontend's change signal.
    // A failed call keeps a copy of the whole patch set it tried to apply, so the catalog can still list the patches that
    // never made it in and the user can build them.
    public static class PatchFailures
    {
        public class Failure
        {
            public MethodBase original;
            public PatchInfo info;
            public string error;
        }

        public static int PatchVersion;

        private static readonly List<Failure> failures = new();

        public static Failure[] All
        {
            get
            {
                lock (failures)
                    return failures.ToArray();
            }
        }

        private static void Finalizer(MethodBase original, PatchInfo patchInfo, Exception __exception)
        {
            Interlocked.Increment(ref PatchVersion);

            if (__exception == null || original == null || patchInfo == null)
                return;

            try
            {
                var failure = new Failure { original = original, info = Copy(patchInfo), error = __exception.Message };
                lock (failures)
                    failures.Add(failure);
            }
            catch
            {
                // Never let our bookkeeping change the outcome of a patch
            }
        }

        public static PatchInfo Copy(PatchInfo src) => PatchCatalog.Make(t => PatchCatalog.Get(src, t).ToArray(), src.VersionCount);
    }
}
