// Method lookup tab: find any method (type search + method list, or free text through /resolve) and show its code in a
// single pane, from one of the sources in sources.js ("as loaded", "with current Harmony patches").
// Only state.lookup ({ method, mode }) is persisted. The type browser follows the shown method's outer type, so it
// comes back after a refresh too.

import { $, $$, el, debounce, breath, showNotice, setLanguageClass, methodHeader } from "./dom.js";
import { state, data, update, selectMethod, setPatches } from "./state.js";
import { SOURCES, sourceById, appliedPatches } from "./sources.js";
import { shortTypeName } from "./filter.js";
import * as api from "./api.js";

let seq = 0;
let shownKey = null;        // `${method}|${mode}|${lang}` on screen (or loading)
let renderedMethod = null;  // method key whose code is in the pane
let info = null;            // { key, m } from /resolve for state.lookup.method (m = null: not found)

// Type browser: the type whose methods are listed
let browse = null;          // { type, assembly, methods: null (loading) | [...], error, stale }
let browseSeq = 0;

// ---------------------------------------------------------------------------------------------------------------
// Setup

export function init() {
    const sources = $("#lookup-sources");
    sources.replaceChildren(...SOURCES.map(s =>
        el("button", { type: "button", dataset: { source: s.id }, title: s.title, onclick: () => update({ lookup: { mode: s.id } }) }, s.label)));

    $("#lookup-reload").addEventListener("click", () => reload());
    initSearch();

    const filter = $("#browser-filter");
    filter.addEventListener("input", () => renderBrowser());
}

export function clearCache() {
    shownKey = null;
    info = null;
    // The "patched" badges (and in a new instance the methods themselves) may have changed. Refetched by show(), so
    // only while the tab is shown.
    if (browse) browse.stale = true;
}

/** Rebuilds the shown method from scratch (re-runs its transpilers) */
export function reload() {
    if (!state.lookup.method) return;
    api.clearCodeCache(state.lookup.method);
    show(true);
}

export function setNotice(text) {
    showNotice($("#lookup-notice"), text);
}

// ---------------------------------------------------------------------------------------------------------------
// Search box with suggestions: methods from /resolve, types from /types

let suggestSeq = 0;
let suggestions = [];       // [{ kind: "method" | "type", item }]
let active = -1;
let pickedText = null;      // input text a suggestion was picked for; a late reply for it doesn't reopen the panel

function initSearch() {
    const input = $("#lookup-input");
    const panel = $("#lookup-suggest");

    const run = debounce(() => suggest(input.value), 200);
    input.addEventListener("input", () => { pickedText = null; run(); });
    input.addEventListener("focus", () => { if (suggestions.length) panel.hidden = false; });
    input.addEventListener("blur", () => { panel.hidden = true; });
    // Keep focus in the input while clicking a suggestion
    panel.addEventListener("mousedown", e => e.preventDefault());
    panel.addEventListener("click", e => {
        const row = e.target.closest("[data-index]");
        if (row) pick(Number(row.dataset.index));
    });

    input.addEventListener("keydown", async e => {
        if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            if (!suggestions.length) return;
            panel.hidden = false;
            active = (active + (e.key === "ArrowDown" ? 1 : -1) + suggestions.length) % suggestions.length;
            renderSuggestions();
        } else if (e.key === "Escape") {
            panel.hidden = true;
        } else if (e.key === "Enter") {
            e.preventDefault();
            if (active >= 0 && !panel.hidden) return pick(active);
            // Free text: wait for this exact text's results, then open a unique match or show the pick list
            await suggest(input.value);
            const methods = suggestions.filter(s => s.kind === "method");
            const types = suggestions.filter(s => s.kind === "type");
            if (methods.length === 1) return pickItem(methods[0]);
            if (!methods.length && types.length === 1) return pickItem(types[0]);
            const exact = !methods.length && types.find(t => sameType(t.item.name, input.value));
            if (exact) return pickItem(exact);
            panel.hidden = false;
        }
    });
}

const sameType = (name, text) => name.replaceAll("+", ".").toLowerCase() === text.trim().replaceAll("::", ".").replaceAll("+", ".").toLowerCase();

async function suggest(text) {
    const q = text.trim();
    const my = ++suggestSeq;
    const panel = $("#lookup-suggest");
    if (!q) {
        suggestions = [];
        panel.hidden = true;
        return;
    }

    // A type query only makes sense without a method part or parameter list
    const typeQuery = !/[:(|]/.test(q);
    let methods = [], types = [];
    try {
        [methods, types] = await Promise.all([api.resolve(q), typeQuery ? api.types(q) : []]);
    } catch (e) {
        if (my !== suggestSeq) return;
        suggestions = [];
        panel.hidden = false;
        panel.replaceChildren(el("p.more", {}, api.getStatus() === "offline" ? "Game not running." : `Search failed: ${e.message}`));
        return;
    }
    if (my !== suggestSeq) return;
    if (!Array.isArray(methods)) methods = [];
    if (!Array.isArray(types)) types = [];

    suggestions = [...methods.map(item => ({ kind: "method", item })), ...types.map(item => ({ kind: "type", item }))];
    active = -1;
    renderSuggestions();
    panel.hidden = document.activeElement !== $("#lookup-input") || text === pickedText;
}

function renderSuggestions() {
    const panel = $("#lookup-suggest");
    const methods = suggestions.filter(s => s.kind === "method");
    const types = suggestions.filter(s => s.kind === "type");
    const row = (s) => {
        const i = suggestions.indexOf(s);
        const attrs = { dataset: { index: i }, "aria-selected": String(i === active), role: "option" };
        if (s.kind === "method") {
            const m = s.item;
            return el("div.suggest-row", { ...attrs, title: m.signature },
                el("span.mono", {}, el("span.row-type", {}, shortTypeName(m.declaringType)), "::", el("b", {}, methodLabel(m))),
                methodBadges(m),
                el("span.muted.suggest-asm", {}, assemblyOf(m.key)));
        }
        const t = s.item;
        return el("div.suggest-row", { ...attrs, title: `${t.name} (${t.assembly})` },
            el("span.mono", {}, t.name),
            el("span.muted.suggest-asm", {}, t.assembly));
    };

    const parts = [];
    if (methods.length) parts.push(el("div.suggest-group", {}, methods.length > 1 ? `Methods (${methods.length}), pick one` : "Method"), methods.map(row));
    if (types.length) parts.push(el("div.suggest-group", {}, `Types (${types.length}), pick one to list its methods`), types.map(row));
    if (!parts.length) parts.push(el("p.more", {}, "No matching types or methods. Try Namespace.Type:Method, Type.Method or Type:Method(int, string)."));
    panel.replaceChildren(...parts.flat());
    panel.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
}

function pick(i) {
    if (suggestions[i]) pickItem(suggestions[i]);
}

function pickItem(s) {
    $("#lookup-suggest").hidden = true;
    pickedText = $("#lookup-input").value;
    if (s.kind === "method") {
        update({ lookup: { method: s.item.key } });
    } else {
        openBrowser(s.item.name, s.item.assembly);
    }
}

// ---------------------------------------------------------------------------------------------------------------
// Type browser: every method of a type and its compiler-generated nested types

/** Outer type of a declaring type: compiler-generated nested types (<>c, <Foo>d__12) belong to the type around them */
const outerType = (declaringType) => {
    const i = declaringType.indexOf("+<");
    return i < 0 ? declaringType : declaringType.slice(0, i);
};
const assemblyOf = (key) => key.slice(0, key.indexOf("|"));

async function openBrowser(type, assembly, keepFilter = false) {
    if (browse && browse.type === type && browse.assembly === assembly && browse.methods && !browse.stale) {
        $("#lookup-browser").open = true;
        return;
    }
    const my = ++browseSeq;
    browse = { type, assembly, methods: null, error: null };
    if (!keepFilter) $("#browser-filter").value = "";
    $("#lookup-browser").open = true;
    renderBrowser();
    try {
        const r = await api.methods(type, assembly);
        if (my !== browseSeq) return;
        if (Array.isArray(r)) browse.methods = r;
        else browse.error = r.exception ?? "No methods";
    } catch (e) {
        if (my !== browseSeq) return;
        browse = api.getStatus() === "offline" ? null : { ...browse, error: e.message };
    }
    renderBrowser();
}

const KIND_ORDER = (m) => m.name === ".cctor" ? 0 : m.name === ".ctor" ? 1 : 2;

function renderBrowser() {
    const box = $("#lookup-browser");
    box.hidden = !browse;
    if (!browse) return;
    const summary = $("#browser-summary");
    const listEl = $("#browser-list");

    if (!browse.methods) {
        summary.replaceChildren(el("span", {}, "Methods of "), el("span.mono", {}, browse.type), el("span.muted", {}, browse.error ? "" : " (loading…)"));
        listEl.replaceChildren(browse.error ? el("p.more", {}, `Couldn't list methods: ${browse.error}`) : el("p.more", {}, "Loading…"));
        return;
    }

    const q = $("#browser-filter").value.trim().toLowerCase();
    const groups = new Map();
    for (const m of browse.methods) {
        const g = m.declaringType === browse.type ? "" : m.declaringType.startsWith(browse.type + "+") ? m.declaringType.slice(browse.type.length + 1) : m.declaringType;
        if (q && !`${g}.${m.name}`.toLowerCase().includes(q)) continue;
        if (!groups.has(g)) groups.set(g, []);
        groups.get(g).push(m);
    }

    const total = browse.methods.length;
    const shown = [...groups.values()].reduce((n, ms) => n + ms.length, 0);
    summary.replaceChildren(el("span", {}, "Methods of "), el("span.mono", {}, browse.type),
        el("span.muted", {}, ` · ${browse.assembly} · ${shown === total ? total : `${shown} of ${total}`}`));

    const frag = document.createDocumentFragment();
    for (const [g, ms] of groups) {
        ms.sort((a, b) => KIND_ORDER(a) - KIND_ORDER(b) || a.name.localeCompare(b.name));
        if (g) frag.append(el("div.browser-group.mono", { title: `${browse.type}+${g}` }, g));
        for (const m of ms)
            frag.append(el("div.browser-row", {
                dataset: { key: m.key },
                role: "option",
                "aria-selected": String(m.key === state.lookup.method),
                title: m.signature,
                onclick: () => update({ lookup: { method: m.key } }),
            }, el("span.mono", {}, methodLabel(m)), methodBadges(m)));
    }
    if (!shown) frag.append(el("p.more", {}, q ? "No methods match." : "This type has no methods."));
    listEl.replaceChildren(frag);
}

function markBrowserSelection() {
    for (const row of $$(".browser-row", $("#browser-list")))
        row.setAttribute("aria-selected", String(row.dataset.key === state.lookup.method));
}

// ---------------------------------------------------------------------------------------------------------------
// Labels

/** name(ShortParam, ...) from the parameter segment of the method key */
function methodLabel(m) {
    const params = m.key.slice(m.key.lastIndexOf("|") + 1);
    return `${m.name}(${params.replace(/[\w.`]+\.(?=[\w<])/g, "").replaceAll(",", ", ")})`;
}

function methodBadges(m) {
    return el("span.badges", {},
        m.patched ? el("span.badge.t-Transpiler", { title: "Has Harmony patches" }, "patched") : null,
        m.hasBody === false ? el("span.badge", { title: "Abstract, extern, interface or runtime-implemented" }, "no body") : null,
        m.openGeneric ? el("span.badge", { title: "Open generic method or method of a generic type: only \"As compiled\" can show it" }, "generic") : null);
}

// ---------------------------------------------------------------------------------------------------------------
// The shown method

/** Shows state.lookup; does nothing off the Lookup tab or when the same code is already shown, unless forced. */
export async function show(force = false) {
    for (const b of $$("[data-source]", $("#lookup-sources")))
        b.setAttribute("aria-pressed", String(b.dataset.source === state.lookup.mode));
    const key = state.lookup.method;
    $("#lookup-reload").disabled = !key;
    markBrowserSelection();
    if (state.tab !== "lookup") return;
    if (browse?.stale) openBrowser(browse.type, browse.assembly, true);

    if (!key) {
        ++seq;
        shownKey = renderedMethod = null;
        renderHeader(null);
        setStatus("");
        setWarnings([]);
        setCode("// Look up a method above, or pick \"view source\" on a patch in the Patches view.");
        return;
    }
    // The catalog says which patches are applied; main.js calls show() once it's loaded
    if (!data.catalog) {
        setStatus("Loading patches…");
        return;
    }

    const source = sourceById(state.lookup.mode);
    const lang = state.lang;
    const viewKey = `${key}|${source.id}|${lang}`;
    if (!force && viewKey === shownKey) return;
    shownKey = viewKey;
    const my = ++seq;

    try {
        if (!info || info.key !== key) {
            setStatus("Resolving…");
            const r = await api.resolve(key);
            if (my !== seq) return;
            info = { key, m: (Array.isArray(r) ? r : []).find(x => x.key === key) ?? null };
        }
        const m = info.m;
        const catalogMethod = data.methodsByKey.get(key);
        renderHeader(m, catalogMethod);

        if (!m) {
            renderedMethod = null;
            setNotice("The looked-up method is no longer present.");
            setStatus("");
            setWarnings([]);
            setCode("// Method not found: " + key);
            return;
        }
        if (!browse || browse.type !== outerType(m.declaringType)) openBrowser(outerType(m.declaringType), assemblyOf(key));

        // No body / open generic: the server answers { exception, unsupported } with the reason
        setStatus("Decompiling…");
        const ctx = { key, catalogMethod, lang, code: (keys, from) => api.cachedCode(key, keys, lang, from) };
        const r = await source.load(ctx);
        if (my !== seq) return;

        setWarnings(r.warnings ?? [], r.unsupported ? [] : source.notes(ctx, r));
        setStatus("Highlighting…");
        await breath();
        if (my !== seq) return;

        // Re-rendering the same method (reload, reconnect, switching source or language) keeps the scroll position
        const content = $(".content");
        const scrollTop = renderedMethod === key ? content.scrollTop : null;
        if (r.exception) setCode(r.unsupported ? "// " + r.exception : r.exception);
        else setCode(r.code ?? "", lang === "il");
        renderedMethod = key;
        if (scrollTop != null) content.scrollTop = scrollTop;
        setStatus("");
    } catch (e) {
        if (my !== seq) return;
        shownKey = null;
        // Game closed: keep the old code on screen; main.js re-runs show() once the game is back
        if (api.getStatus() === "offline") {
            setStatus("Game not running. The code reloads when it's back.");
            return;
        }
        setStatus("");
        setWarnings([`Request failed: ${e.message}`]);
        setCode("// Request failed");
    }
}

function renderHeader(m, catalogMethod) {
    const header = $("#lookup-header");
    if (!m) {
        header.replaceChildren(state.lookup.method
            ? el("p.muted", {}, "The looked-up method couldn't be found in this game instance.")
            : el("p.muted", {}, "Type a type name and pick one of its methods, or enter Namespace.Type:Method, Type.Method or Type:Method(int, string)."));
        return;
    }

    const applied = appliedPatches(catalogMethod).length;
    const erroring = (catalogMethod?.patches.length ?? 0) - applied;
    header.replaceChildren(
        ...methodHeader(m.declaringType, m.name, m.signature, assemblyOf(m.key)),
        catalogMethod
            ? el("p.patched-link", {},
                `${applied} Harmony patch${applied === 1 ? "" : "es"}${erroring ? ` (+${erroring} erroring)` : ""} → `,
                el("button.link", { type: "button", onclick: () => openInPatches(catalogMethod) }, "open in Patches view"))
            : el("p.muted", {}, "No Harmony patches."));
}

/** Switches to the Patches tab with this method selected. If the sidebar filters match none of its patches, all are checked. */
function openInPatches(catalogMethod) {
    update({ tab: "patches" });
    selectMethod(catalogMethod.key);
    if (!state.patches.length) setPatches(catalogMethod.patches.map(p => p.key));
}

function setStatus(text) {
    $("#lookup-status").textContent = text;
}

function setWarnings(lines, notes = []) {
    $("#lookup-warnings").replaceChildren(...lines.map(w => el("div.warning", {}, w)), ...notes.map(n => el("p.hint", {}, n)));
}

function setCode(text, isIL = false) {
    const code = $("#lookup-pre code");
    setLanguageClass([$("#lookup-pre"), code], isIL);
    code.textContent = text;
    Prism.highlightElement(code);
}
