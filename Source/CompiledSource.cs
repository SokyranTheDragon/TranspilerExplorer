using ICSharpCode.Decompiler;
using ICSharpCode.Decompiler.CSharp;
using ICSharpCode.Decompiler.Metadata;
using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Reflection.Metadata;
using System.Reflection.Metadata.Ecma335;
using System.Reflection.PortableExecutable;
using Verse;

namespace TranspilerExplorer
{
    // The "as compiled" lookup source: decompiles a method straight from its assembly file, in its real module. Unlike the
    // dummy-assembly path (Decompiler.WriteAssembly), ILSpy can see the compiler-generated nested types there, so iterators
    // come back as `yield return`, async methods as `await` and lambdas inline. The IL is the one on disk, so it includes
    // neither Prepatcher free patches nor Harmony patches.
    [HotSwappable]
    public static class CompiledSource
    {
        private static readonly ConcurrentDictionary<Assembly, string> paths = new(); // file of each assembly (null = none)
        private static string[] modDlls;
        private static ILookup<string, string> modDllsByName; // assembly name -> files, built on first use

        // Throws UnsupportedException when there's no file to decompile from
        public static string Decompile(MethodBase method, bool il, List<string> warnings, out string file)
        {
            var asm = method.Module.Assembly;
            var path = FileOf(asm)
                ?? throw new UnsupportedException($"No assembly file found for {asm.GetName().Name} (it may be dynamic or loaded from memory), so it can't be shown as compiled. Use \"As loaded\" instead.");
            if (method.Module != asm.ManifestModule)
                throw new UnsupportedException("Methods in secondary modules of multi-module assemblies aren't supported. Use \"As loaded\" instead.");

            // Read into memory so the file isn't kept open
            using var pe = new PEFile(path, new MemoryStream(File.ReadAllBytes(path)), PEStreamOptions.PrefetchEntireImage);
            var md = pe.Metadata;
            if (md.GetGuid(md.GetModuleDefinition().Mvid) != method.Module.ModuleVersionId)
                warnings.Add($"{Path.GetFileName(path)} on disk isn't the build the game loaded (rebuilt since the game started?), so this may not match what's running.");

            // Generic instantiations share the definition's token
            var token = method is MethodInfo { IsGenericMethod: true } mi ? mi.GetGenericMethodDefinition().MetadataToken : method.MetadataToken;
            var handle = (MethodDefinitionHandle)MetadataTokens.EntityHandle(token);
            file = path;

            if (il)
                return Decompiler.Disassemble(rd => rd.DisassembleMethod(pe, handle));

            var resolver = Decompiler.Resolver(pe, path, PEStreamOptions.PrefetchMetadata);
            resolver.AddSearchDirectory(Path.GetDirectoryName(Decompiler.DataPath("Assembly-CSharp.dll")));
            foreach (var dir in ModDlls().Select(Path.GetDirectoryName).Distinct())
                resolver.AddSearchDirectory(dir);

            var settings = new DecompilerSettings { ThrowOnAssemblyResolveErrors = false };
            return new CSharpDecompiler(pe, resolver, settings).DecompileAsString(handle);
        }

        public static string FileOf(Assembly asm)
        {
            if (asm.IsDynamic)
                return null;
            if (paths.TryGetValue(asm, out var cached))
                return cached;
            var found = Find(asm);
            // A miss is only final once the mod DLL list could be read
            if (found != null || modDlls != null)
                paths[asm] = found;
            return found;
        }

        private static string Find(Assembly asm)
        {
            try
            {
                if (!string.IsNullOrEmpty(asm.Location) && File.Exists(asm.Location))
                    return asm.Location;
            }
            catch
            {
                // Location can throw for some assemblies
            }

            // Mod assemblies are loaded from bytes and have no Location: look in the running mods' Assemblies folders,
            // preferring the file whose MVID matches the loaded module
            var name = asm.GetName().Name;
            var mvid = asm.ManifestModule.ModuleVersionId;
            var byName = modDllsByName ?? ModDlls().Select(f => (name: NameOf(f), file: f)).Where(x => x.name != null).ToLookup(x => x.name, x => x.file);
            if (modDlls != null)
                modDllsByName = byName; // only once the file list itself is final
            var candidates = byName[name].ToList();
            var root = Decompiler.DataPath(name + ".dll");
            if (File.Exists(root))
                candidates.Add(root);

            return candidates.FirstOrDefault(f => MvidOf(f) == mvid) ?? candidates.FirstOrDefault();
        }

        // Every DLL in the Assemblies folders of the running mods, for the folders the game loads (version folders included)
        private static string[] ModDlls()
        {
            if (modDlls != null)
                return modDlls;

            var list = new List<string>();
            try
            {
                foreach (var mod in LoadedModManager.RunningMods)
                    foreach (var folder in mod.foldersToLoadDescendingOrder)
                    {
                        try
                        {
                            var dir = Path.Combine(Path.IsPathRooted(folder) ? folder : Path.Combine(mod.RootDir, folder), "Assemblies");
                            if (Directory.Exists(dir))
                                list.AddRange(Directory.GetFiles(dir, "*.dll", SearchOption.AllDirectories));
                        }
                        catch
                        {
                            // An unreadable folder only loses its own DLLs
                        }
                    }
            }
            catch
            {
                // Mod list not available: use what was found, and try again next time
                return list.ToArray();
            }
            return modDlls = list.ToArray();
        }

        private static string NameOf(string file)
        {
            try { return AssemblyName.GetAssemblyName(file).Name; }
            catch { return null; }
        }

        private static Guid MvidOf(string file)
        {
            try
            {
                using var stream = File.OpenRead(file);
                using var reader = new PEReader(stream);
                var md = reader.GetMetadataReader();
                return md.GetGuid(md.GetModuleDefinition().Mvid);
            }
            catch
            {
                return Guid.Empty;
            }
        }
    }
}
