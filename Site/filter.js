// Pure search/filter logic over the /patches catalog. No DOM.
//
// Rule: a method is listed if at least one of its patches passes every filter, and the search text matches the method
// (name or type) or that same patch (name, declaring type or owner).
// Facet counts: for each option, how many methods would be listed if that facet were set to only that option,
// with all other filters and the search unchanged.

export const PATCH_TYPES = [
    { id: "Transpiler", short: "T", label: "Transpiler" },
    { id: "Prefix", short: "Pre", label: "Prefix" },
    { id: "Postfix", short: "Post", label: "Postfix" },
    { id: "Finalizer", short: "Fin", label: "Finalizer" },
    { id: "InnerPrefix", short: "iPre", label: "Inner prefix" },
    { id: "InnerPostfix", short: "iPost", label: "Inner postfix" },
    { id: "InnerFinalizer", short: "iFin", label: "Inner finalizer" },
];
export const TYPE_INDEX = Object.fromEntries(PATCH_TYPES.map((t, i) => [t.id, i]));

// Facet id -> value of a (method, patch) pair
export const FACETS = {
    targetAsm: (m, p) => m.targetAssembly,
    patchAsm: (m, p) => p.patchAssembly,
    types: (m, p) => p.type,
    owners: (m, p) => p.owner,
};
const FACET_IDS = Object.keys(FACETS);
const BIT = Object.fromEntries([...FACET_IDS, "erroringOnly"].map((f, i) => [f, 1 << i]));

const hayCache = new WeakMap();
function hay(obj, make) {
    let h = hayCache.get(obj);
    if (h === undefined) {
        h = make(obj).toLowerCase();
        hayCache.set(obj, h);
    }
    return h;
}
const methodHay = (m) => hay(m, m => `${m.type}::${m.name}\n${m.type}.${m.name}`);
const patchHay = (p) => hay(p, p => `${p.declaringType}::${p.name}\n${p.declaringType}.${p.name}\n${p.owner}`);

function compile(filters) {
    return {
        sets: Object.fromEntries(FACET_IDS.map(f => [f, filters[f].length ? new Set(filters[f]) : null])),
        erroringOnly: filters.erroringOnly,
    };
}

// Bitmask of the filters this patch fails (0 = passes all)
function failMask(c, m, p) {
    let mask = 0;
    for (const f of FACET_IDS) {
        const set = c.sets[f];
        if (set && !set.has(FACETS[f](m, p))) mask |= BIT[f];
    }
    if (c.erroringOnly && !p.erroring) mask |= BIT.erroringOnly;
    return mask;
}

/** Patches of `method` that pass the filters (ignoring search), in execution order. */
export function matchingPatches(method, filters) {
    const c = compile(filters);
    return sortPatches(method.patches.filter(p => failMask(c, method, p) === 0));
}

export function sortPatches(patches) {
    return [...patches].sort((a, b) => TYPE_INDEX[a.type] - TYPE_INDEX[b.type] || a.order - b.order);
}

/**
 * @returns {{ listed: object[], counts: { [facet]: Map<string, number>, erroringOnly: number } }}
 */
export function apply(methods, filters, query) {
    const c = compile(filters);
    const q = query.trim().toLowerCase();
    const counts = Object.fromEntries(FACET_IDS.map(f => [f, new Map()]));
    counts.erroringOnly = 0;
    const listed = [];

    for (const m of methods) {
        const methodHit = !q || methodHay(m).includes(q);
        let isListed = false;
        let erroringHit = false;
        const seen = Object.fromEntries(FACET_IDS.map(f => [f, new Set()]));

        for (const p of m.patches) {
            if (!methodHit && !patchHay(p).includes(q)) continue;
            const mask = failMask(c, m, p);
            if (mask === 0) isListed = true;
            // A facet's own selection doesn't restrict its counts, the other filters do
            for (const f of FACET_IDS)
                if ((mask & ~BIT[f]) === 0) seen[f].add(FACETS[f](m, p));
            if (p.erroring && (mask & ~BIT.erroringOnly) === 0) erroringHit = true;
        }

        if (isListed) listed.push(m);
        for (const f of FACET_IDS)
            for (const v of seen[f]) counts[f].set(v, (counts[f].get(v) ?? 0) + 1);
        if (erroringHit) counts.erroringOnly++;
    }

    return { listed, counts };
}

/** Every option of every facet in the catalog, sorted by how many methods use it (stable for the catalog's lifetime). */
export function facetOptions(methods) {
    // With no filters and no search, apply()'s counts are the totals
    const noFilters = { ...Object.fromEntries(FACET_IDS.map(f => [f, []])), erroringOnly: false };
    const totals = apply(methods, noFilters, "").counts;
    const sorted = (map) => [...map.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(e => e[0]);
    return {
        targetAsm: sorted(totals.targetAsm),
        patchAsm: sorted(totals.patchAsm),
        owners: sorted(totals.owners),
        types: PATCH_TYPES.map(t => t.id),
    };
}

/** Patch count per type, for the row badges */
export function typeCounts(method) {
    const counts = new Array(PATCH_TYPES.length).fill(0);
    for (const p of method.patches) counts[TYPE_INDEX[p.type]]++;
    return counts;
}

export function shortTypeName(full) {
    // Last '.' before any generic argument list
    const cut = full.search(/[<\[]/);
    const head = cut < 0 ? full : full.slice(0, cut);
    const dot = head.lastIndexOf(".");
    return dot < 0 ? full : full.slice(dot + 1);
}

export function namespaceOf(full) {
    const short = shortTypeName(full);
    return full.length > short.length ? full.slice(0, full.length - short.length - 1) : "";
}
