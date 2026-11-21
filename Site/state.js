// UI state. `state` holds only plain JSON (strings, arrays, booleans) keyed by stable server keys, so persist.js can
// write it to the URL / localStorage and read it back with restore().
// Data fetched from the server (the catalog) lives in `data` and is never persisted.

import { matchingPatches } from "./filter.js";
import { SOURCE_IDS } from "./sources.js";

const DEFAULTS = {
    tab: "patches",          // "patches" | "lookup"
    q: "",                   // sidebar search text
    filters: {
        targetAsm: [],       // assemblies holding the patched originals ("patches in")
        patchAsm: [],        // assemblies holding the patch methods ("patches from")
        types: ["Transpiler"], // PatchType names; empty = all. Transpilers only by default, the common case
        owners: [],          // Harmony IDs
        erroringOnly: false,
    },
    method: null,            // MethodKey of the selected method
    patches: [],             // PatchKeys checked in the selected method's checklist
    patchesFromFilters: true, // checklist follows the filters until the user toggles a patch by hand
    baseline: "original",    // "original": left = no patches, right = checked
                             // "others":   left = all but the checked patches, right = all patches
    lang: "cs",              // "cs" | "il"
    lookup: {
        method: null,        // MethodKey shown in the Method lookup tab
        mode: "loaded",      // code source, an id from sources.js ("loaded" | "harmony")
    },
};

const clone = (o) => structuredClone(o);

export const state = clone(DEFAULTS);

/** A fresh copy of the default state */
export const defaults = () => clone(DEFAULTS);

// Allowed values of the string settings that are enums
const ENUMS = { tab: ["patches", "lookup"], lang: ["cs", "il"], baseline: ["original", "others"] };

export const data = {
    catalog: null,           // last /patches response
    methodsByKey: new Map(), // MethodKey -> catalog method
};

const listeners = new Set();

/** fn(changedTopLevelKeys: Set<string>) runs after every update */
export function subscribe(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
}

/** Shallow-merges top-level keys; `filters` is merged one level deeper. */
export function update(changes) {
    const changed = new Set();
    for (const [k, v] of Object.entries(changes)) {
        if (k === "filters") {
            state.filters = { ...state.filters, ...v };
        } else if (k === "lookup") {
            const next = { ...state.lookup, ...v };
            if (next.method === state.lookup.method && next.mode === state.lookup.mode) continue;
            state.lookup = next;
        } else {
            if (state[k] === v) continue;
            state[k] = v;
        }
        changed.add(k);
    }
    if (changed.size)
        for (const fn of listeners) fn(changed);
}

/** Keys of the selected method's patches that match `filters` */
function filterKeys(methodKey, filters) {
    const m = methodKey && data.methodsByKey.get(methodKey);
    return m ? matchingPatches(m, filters).map(p => p.key) : [];
}

/** Changes filters; the checklist follows them unless the user has edited it. */
export function setFilters(changes) {
    const filters = { ...state.filters, ...changes };
    update(state.patchesFromFilters
        ? { filters: changes, patches: filterKeys(state.method, filters) }
        : { filters: changes });
}

export function resetFilters() {
    setFilters(clone(DEFAULTS.filters));
}

/** Opens a method with the patches matching the active filters checked */
export function selectMethod(key) {
    if (key === state.method) return;
    update({ method: key, patches: filterKeys(key, state.filters), patchesFromFilters: true });
}

/** Sets the checked patches by hand (fromFilters = the "Matching filters" button) */
export function setPatches(keys, fromFilters = false) {
    update({ patches: fromFilters ? filterKeys(state.method, state.filters) : keys, patchesFromFilters: fromFilters });
}

/** Opens a method in the Method lookup tab, optionally with a code source (sources.js id) */
export function openLookup(key, mode) {
    update({ tab: "lookup", lookup: mode ? { method: key, mode } : { method: key } });
}

/** True when the filters differ from the defaults */
export function hasActiveFilters(f = state.filters) {
    return JSON.stringify(f) !== JSON.stringify(DEFAULTS.filters);
}

const isStringArray = (v) => Array.isArray(v) && v.every(x => typeof x === "string");

/** Applies a previously serialized state, ignoring unknown keys and wrong types. */
export function restore(saved) {
    if (!saved || typeof saved !== "object") return;
    const next = clone(DEFAULTS);
    for (const k of ["tab", "q", "lang", "baseline", "patchesFromFilters"])
        if (typeof saved[k] === typeof DEFAULTS[k] && (!ENUMS[k] || ENUMS[k].includes(saved[k])))
            next[k] = saved[k];
    if (typeof saved.method === "string") next.method = saved.method;
    if (isStringArray(saved.patches)) next.patches = saved.patches;
    if (saved.filters && typeof saved.filters === "object")
        for (const k of Object.keys(DEFAULTS.filters)) {
            const v = saved.filters[k];
            if (Array.isArray(DEFAULTS.filters[k]) ? isStringArray(v) : typeof v === "boolean")
                next.filters[k] = v;
        }
    if (saved.lookup && typeof saved.lookup === "object") {
        if (typeof saved.lookup.method === "string") next.lookup.method = saved.lookup.method;
        if (SOURCE_IDS.includes(saved.lookup.mode)) next.lookup.mode = saved.lookup.mode;
    }
    update(next);
}

/**
 * Stores a new catalog and re-applies the selection to it. A checklist that follows the filters is recomputed; one
 * edited by hand keeps the keys that still exist. Changes `state` without notifying listeners: the caller re-renders.
 * @returns {{ methodMissing: boolean, missingPatches: number }}
 */
export function setCatalog(catalog) {
    data.catalog = catalog;
    data.methodsByKey = new Map(catalog.methods.map(m => [m.key, m]));
    const method = state.method && data.methodsByKey.get(state.method);
    let missingPatches = 0;
    if (state.patchesFromFilters) {
        state.patches = filterKeys(state.method, state.filters);
    } else if (method) {
        const have = new Set(method.patches.map(p => p.key));
        const kept = state.patches.filter(k => have.has(k));
        missingPatches = state.patches.length - kept.length;
        state.patches = kept;
    }
    return { methodMissing: !!state.method && !method, missingPatches };
}
