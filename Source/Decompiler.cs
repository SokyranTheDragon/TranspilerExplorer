using ICSharpCode.Decompiler;
using ICSharpCode.Decompiler.CSharp;
using ICSharpCode.Decompiler.DebugInfo;
using ICSharpCode.Decompiler.Disassembler;
using ICSharpCode.Decompiler.Metadata;
using ICSharpCode.Decompiler.TypeSystem;
using Mono.Cecil;
using Mono.Cecil.Cil;
using MonoMod.Utils;
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Reflection.PortableExecutable;
using System.Runtime.InteropServices;
using System.Threading;
using UnityEngine;

namespace TranspilerExplorer
{
    [HotSwappable]
    public static class Decompiler
    {
        private const string DummyType = "TranspilerExplorer";
        internal const string DummyMethod = "Method";
        private const string DummyDll = "decomp.dll";

        // Readable C#: local names come from the unpatched build of the same method, with Harmony's own locals named on top
        // (see VariableNames), so both sides of a diff use the same names.
        public static string Decompile(BuiltMethod built)
        {
            // The decompiler changes similar looking variable names which end in a number.
            // The appended string prevents that. It's stripped after decompilation finishes.
            const string appended = "_0___1_";
            var names = VariableNames.For(built).ToDictionary(kv => kv.Key, kv => kv.Value + appended);

            return Decompile(built, null, new VariableNameProvider(names)).Replace(appended, "");
        }

        // The dummy type holds the main method as `Method` plus every structured infix helper as InfixHelper0..N, with the
        // main body's calls pointed at them. built.helperCalls is the helper each call targets, in body order: the Cecil
        // references to those calls carry no name or declaring type, so they can only be matched by position.
        public static string Decompile(BuiltMethod built, Action<DecompilerSettingsWrapper> postProcess, IDebugInfoProvider debugInfo)
        {
            using var peFile = Load(built);

            var settings = new DecompilerSettingsWrapper()
            {
                ThrowOnAssemblyResolveErrors = false,
                AnonymousMethods = false,
                UseDebugSymbols = debugInfo != null
            };
            var decompiler = new CSharpDecompiler(peFile, Resolver(peFile, DataPath("Assembly-CSharp.dll"), PEStreamOptions.Default), settings)
            {
                DebugInfoProvider = debugInfo,
            };

            var code = decompiler.DecompileTypeAsString(new FullTypeName(DummyType));
            postProcess?.Invoke(settings);

            return code;
        }

        public static string Disasm(BuiltMethod built)
        {
            using var peFile = Load(built);
            return Disassemble(rd =>
            {
                rd.DetectControlStructure = false;
                rd.DisassembleType(peFile, peFile.GetTypeDefinition(new TopLevelTypeName(DummyType)));
            });
        }

        internal static string Disassemble(Action<ReflectionDisassembler> disassemble)
        {
            using var writer = new StringWriter();
            disassemble(new ReflectionDisassembler(new PlainTextOutput(writer), CancellationToken.None));
            return writer.ToString();
        }

        internal static UniversalAssemblyResolver Resolver(MetadataFile pe, string mainPath, PEStreamOptions options)
            => new(mainPath, false, pe.DetectTargetFrameworkId(), pe.DetectRuntimePack(), options);

        // The dummy assembly, read back from memory
        private static PEFile Load(BuiltMethod built)
        {
            var stream = new MemoryStream();
            WriteAssembly(stream, built);
            stream.Position = 0;
            return new PEFile(DummyDll, stream);
        }

        // Writes an already-built method (e.g. captured from Harmony's MethodCreator) into the dummy assembly
        private static void WriteAssembly(Stream stream, BuiltMethod built)
        {
            var patch = built.dmd ?? throw new InvalidOperationException(built.error ?? "The method wasn't built");
            var helpers = built.helpers;
            var helperCalls = built.helperCalls;

            string name = patch.GetDumpName("Cecil");
            var module = ModuleDefinition.CreateModule(name, new ModuleParameters()
            {
                Kind = ModuleKind.Dll,
                ReflectionImporterProvider = MMReflectionImporter.ProviderNoDefault
            });

            var typeDef = new TypeDefinition(
                "",
                DummyType,
                Mono.Cecil.TypeAttributes.Public | Mono.Cecil.TypeAttributes.Abstract | Mono.Cecil.TypeAttributes.Sealed | Mono.Cecil.TypeAttributes.Class
            )
            {
                BaseType = module.TypeSystem.Object
            };

            module.Types.Add(typeDef);

            // Helpers only wrap one call site each and don't call other helpers, so only the main body needs resolving
            var helperDefs = new List<(MethodInfo generated, MethodDefinition def)>();
            for (var i = 0; i < helpers.Count; i++)
                helperDefs.Add((helpers[i].generated, GenerateCecilMethod(helpers[i].dmd, typeDef, $"InfixHelper{i}", null)));

            // GenerateCecilMethod walks the body in order, so the n-th unresolved call is the n-th entry of helperCalls
            var nextCall = 0;
            MethodReference ResolveMainCall(MethodReference reference)
            {
                if (reference.DeclaringType != null || nextCall >= helperCalls.Count)
                    return null;

                var target = helperCalls[nextCall++];
                foreach (var (generated, def) in helperDefs)
                    if (generated == target)
                        return def;
                return null;
            }

            var main = GenerateCecilMethod(patch, typeDef, DummyMethod, ResolveMainCall);

            // The main method goes first, so it's always MethodDef row 1 (VariableNameProvider names only that one)
            typeDef.Methods.Remove(main);
            typeDef.Methods.Insert(0, main);

            module.Write(stream);
        }

        // Copied from MonoMod.Utils.DMDCecilGenerator, edited to not load the assembly
        private static MethodDefinition GenerateCecilMethod(DynamicMethodDefinition dmd, TypeDefinition typeDef, string name, Func<MethodReference, MethodReference> resolveHelper)
        {
            var def = dmd.Definition;
            var module = typeDef.Module;

            Relinker relinker = (mtp, ctx) => {
                return module.ImportReference(mtp);
            };

            // Always use the same name, so methods built by different pipelines (and Harmony's _PatchN suffixes) diff cleanly
            MethodDefinition clone = new MethodDefinition(name, def.Attributes, module.TypeSystem.Void)
            {
                MethodReturnType = def.MethodReturnType,
                Attributes = Mono.Cecil.MethodAttributes.Public | Mono.Cecil.MethodAttributes.HideBySig | Mono.Cecil.MethodAttributes.Public | Mono.Cecil.MethodAttributes.Static,
                ImplAttributes = Mono.Cecil.MethodImplAttributes.IL | Mono.Cecil.MethodImplAttributes.Managed,
                DeclaringType = typeDef
            };

            foreach (ParameterDefinition param in def.Parameters)
                clone.Parameters.Add(param.Clone().Relink(relinker, clone));

            clone.ReturnType = def.ReturnType.Relink(relinker, clone);

            typeDef.Methods.Add(clone);

            clone.HasThis = def.HasThis;
            Mono.Cecil.Cil.MethodBody body = clone.Body = def.Body.Clone(clone);

            foreach (VariableDefinition var in clone.Body.Variables)
                var.VariableType = var.VariableType.Relink(relinker, clone);

            foreach (var handler in clone.Body.ExceptionHandlers)
                if (handler.CatchType != null)
                    handler.CatchType = handler.CatchType.Relink(relinker, clone);

            for (int instri = 0; instri < body.Instructions.Count(); instri++)
            {
                Instruction instr = body.Instructions.ElementAt(instri);
                object operand = instr.Operand;

                if (operand is ParameterDefinition param)
                    operand = clone.Parameters.ElementAt(param.Index);
                else if (operand is MethodReference mr && resolveHelper?.Invoke(mr) is { } helper)
                    operand = helper;
                else if (operand is MethodReference { DeclaringType: null } unresolved)
                    throw new NotSupportedException($"Call to a generated method without a declaring type ('{unresolved.Name}') that doesn't match a captured infix helper call.");
                else if (operand is IMetadataTokenProvider mtp)
                    operand = mtp.Relink(relinker, clone);

                instr.Operand = operand;
            }

            clone.HasThis = false;

            if (def.HasThis)
            {
                TypeReference type = def.DeclaringType;
                if (type.IsValueType)
                    type = new Mono.Cecil.ByReferenceType(type);
                clone.Parameters.Insert(0, new ParameterDefinition("<>_this", Mono.Cecil.ParameterAttributes.None, type.Relink(relinker, clone)));
            }

            return clone;
        }

        private static string ManagedFolderOS() => RuntimeInformation.IsOSPlatform(OSPlatform.OSX) ? "Resources/Data/Managed" : "Managed";

        public static string DataPath(string file)
        {
            // RimWorld 1.7+ runs on CoreCLR with every assembly next to the executable
            var root = Path.Combine(AppContext.BaseDirectory, file);
            if (File.Exists(root))
                return root;

            return Path.Combine(Application.dataPath, ManagedFolderOS(), file);
        }
    }
}
