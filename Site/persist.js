// Persists `state` to the URL query string (the source of truth, so a view survives a refresh and can be bookmarked)
// and mirrors it to localStorage, which is used when the URL has no state (e.g. opening localhost:8339 fresh).
// Default values are left out of the URL to keep it short. lm/lmode hold the Method lookup tab (state.lookup).

import { state, defaults } from "./state.js";

const STORAGE_KEY = "transpilerExplorer.state";

// URL param -> filters list
const LISTS = { ta: "targetAsm", pa: "patchAsm", t: "types", o: "owners" };
const KNOWN = ["tab", "q", "m", "p", "base", "lang", "err", "lm", "lmode", ...Object.keys(LISTS)];

const sameList = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

// A list that is empty but whose default isn't (or patches checked by hand, but none) is written as a single empty value
function appendList(params, name, values) {
    if (!values.length) params.append(name, "");
    else for (const v of values) params.append(name, v);
}

export function toQuery(s) {
    const d = defaults();
    const p = new URLSearchParams();
    if (s.tab !== d.tab) p.set("tab", s.tab);
    if (s.q) p.set("q", s.q);
    for (const [name, f] of Object.entries(LISTS))
        if (!sameList(s.filters[f], d.filters[f])) appendList(p, name, s.filters[f]);
    if (s.filters.erroringOnly) p.set("err", "1");
    if (s.method) {
        p.set("m", s.method);
        // Checks that follow the filters are recomputed, so only hand-edited ones are stored
        if (!s.patchesFromFilters) appendList(p, "p", s.patches);
    }
    if (s.baseline !== d.baseline) p.set("base", s.baseline);
    if (s.lang !== d.lang) p.set("lang", s.lang);
    if (s.lookup.method) p.set("lm", s.lookup.method);
    if (s.lookup.mode !== d.lookup.mode) p.set("lmode", s.lookup.mode);
    // Keys are full of these; leaving them unescaped keeps the URL readable
    return p.toString().replace(/%7C/gi, "|").replace(/%2C/gi, ",").replace(/%3A/gi, ":").replace(/%2F/gi, "/")
        .replace(/%3C/gi, "<").replace(/%3E/gi, ">");
}

/** Parses a query string into a state object, or null if it holds no state */
export function fromQuery(search) {
    const p = new URLSearchParams(search);
    if (!KNOWN.some(k => p.has(k))) return null;
    const s = defaults();
    if (p.has("tab")) s.tab = p.get("tab");
    if (p.has("q")) s.q = p.get("q");
    for (const [name, f] of Object.entries(LISTS))
        if (p.has(name)) s.filters[f] = p.getAll(name).filter(Boolean);
    s.filters.erroringOnly = p.get("err") === "1";
    if (p.get("m")) {
        s.method = p.get("m");
        if (p.has("p")) {
            s.patchesFromFilters = false;
            s.patches = p.getAll("p").filter(Boolean);
        }
    }
    if (p.has("base")) s.baseline = p.get("base");
    if (p.has("lang")) s.lang = p.get("lang");
    if (p.get("lm")) s.lookup.method = p.get("lm");
    if (p.has("lmode")) s.lookup.mode = p.get("lmode");
    return s;
}

/** The state to start with: from the URL, else from localStorage, else null */
export function load() {
    const fromUrl = fromQuery(location.search);
    if (fromUrl) return fromUrl;
    try {
        const stored = localStorage.getItem(STORAGE_KEY);
        if (stored) return fromQuery(stored);
    } catch { /* storage blocked */ }
    return null;
}

/** Writes the current state to the URL and localStorage */
export function save() {
    const qs = toQuery(state);
    if (location.search.replace(/^\?/, "") !== qs)
        history.replaceState(null, "", qs ? `?${qs}` : location.pathname);
    try {
        localStorage.setItem(STORAGE_KEY, qs);
    } catch { /* storage blocked or full */ }
}
