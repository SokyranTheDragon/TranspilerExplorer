// Code sources for the Method lookup tab. The tab renders one button per entry, so a new source (e.g. another method
// body transformer) is added here without touching the UI.
//
// load(ctx) returns a /code-shaped response { code?, exception?, unsupported?, warnings }.
//   ctx.key            MethodKey being looked up
//   ctx.catalogMethod  its entry in the /patches catalog, or undefined when it has no Harmony patches
//   ctx.lang           "cs" | "il"
//   ctx.code(keys, source?)  /code for that method with the given patch keys, or from another server-side source
//                            (cached until the catalog reloads)
// notes(ctx, response) returns extra lines shown above the code.

/** Patches Harmony has actually applied (erroring ones only exist in a failed PatchInfo) */
export const appliedPatches = (catalogMethod) => (catalogMethod?.patches ?? []).filter(p => !p.erroring);

export const SOURCES = [
    {
        id: "loaded",
        label: "As loaded",
        title: "The method body as the game reports it through reflection, without Harmony patches. On 1.7 this already includes Prepatcher free patches.",
        load: (ctx) => ctx.code([]),
        notes: () => [],
    },
    {
        id: "harmony",
        label: "With current Harmony patches",
        title: "Rebuilt with every Harmony patch currently applied to the method, in Harmony's execution order.",
        load: (ctx) => ctx.code(appliedPatches(ctx.catalogMethod).map(p => p.key)),
        notes: (ctx) => appliedPatches(ctx.catalogMethod).length
            ? ["Prefixes, postfixes and finalizers show up as calls. Use \"view source\" in the Patches view to see their bodies."]
            : ["This method has no Harmony patches, so this is the same as \"As loaded\"."],
    },
    {
        id: "compiled",
        label: "As compiled",
        title: "Decompiled from the assembly file on disk, in its own module, so iterators (yield return), async methods and lambdas read like the source. Doesn't include Prepatcher or Harmony changes.",
        load: (ctx) => ctx.code([], "compiled"),
        notes: (ctx, r) => [
            "From the assembly file on disk: doesn't include Prepatcher free patches or Harmony patches.",
            ...(r?.file ? [`File: ${r.file}`] : []),
        ],
    },
];

export const SOURCE_IDS = SOURCES.map(s => s.id);
export const sourceById = (id) => SOURCES.find(s => s.id === id) ?? SOURCES[0];
