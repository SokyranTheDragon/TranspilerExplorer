using System;
using System.IO;
using System.Threading;
using HarmonyLib;
using UnityEngine;
using Verse;

namespace TranspilerExplorer
{
    [StaticConstructorOnStartup]
    [HotSwappable]
    static class TranspilerExplorer
    {
        private static Server server;

        static TranspilerExplorer()
        {
            TranspilerExplorerMod.harmony.PatchAll(typeof(TranspilerExplorer).Assembly);

            server = new Server(
                TranspilerExplorerMod.settings.port,
                Path.Combine(GenFilePaths.ModsFolderPath, "TranspilerExplorer/Site")
            );

            new Thread(server.Start).Start();
        }
    }

    public class TranspilerExplorerMod : Mod
    {
        public static Harmony harmony = new Harmony("transpiler_explorer");
        public static Settings settings;

        public TranspilerExplorerMod(ModContentPack content) : base(content)
        {
            settings = GetSettings<Settings>();
            EarlyPatches();
        }

        private void EarlyPatches()
        {
            harmony.Patch(
                AccessTools.Method("HarmonyLib.PatchFunctions:UpdateWrapper"),
                finalizer: new HarmonyMethod(AccessTools.Method(typeof(PatchFailures), "Finalizer"))
            );
        }

        private string portBuffer;

        public override void DoSettingsWindowContents(Rect inRect)
        {
            var listing = new Listing_Standard();
            listing.Begin(inRect);
            listing.ColumnWidth = 220f;

            listing.TextFieldNumericLabeled("Port (requires restart): ", ref settings.port, ref portBuffer, 0, ushort.MaxValue);

            listing.End();
        }

        public override string SettingsCategory()
        {
            return "Transpiler Explorer";
        }
    }

    public class Settings : ModSettings
    {
        private const int DEFAULT_PORT = 8339;
        public int port = DEFAULT_PORT;

        public override void ExposeData()
        {
            Scribe_Values.Look(ref port, "port", DEFAULT_PORT);
        }
    }

    [AttributeUsage(AttributeTargets.Class)]
    public class HotSwappableAttribute : Attribute
    {
    }
}
