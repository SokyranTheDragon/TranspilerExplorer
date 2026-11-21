// Patches tab: header and patch checklist for the selected method, and the diff.
// Baseline "original": left = /code without patches, right = /code with the checked patches.
// Baseline "others":   left = /code with every patch except the checked ones, right = /code with every patch, which shows
//                      what the checked patches add on top of everything else.

import { $, $$, el, breath, showNotice, methodHeader } from "./dom.js";
import { state, data, update, setPatches, openLookup } from "./state.js";
import { PATCH_TYPES, matchingPatches, sortPatches, shortTypeName } from "./filter.js";
import * as api from "./api.js";
import * as diffview from "./diffview.js";

let seq = 0;
let shownKey = null;         // `${method}|${lang}|${left keys}|${right keys}` currently on screen (or loading)
let checklistFor = null;     // method key the checklist DOM was built for
let renderedMethod = null;   // method key whose code is in the panes

/** Re-runs the current view from scratch (HotSwap can change transpiler code without bumping patchVersion) */
export function reload() {
    if (!state.method) return;
    api.clearCodeCache(state.method);
    show(true);
}

export function clearCache() {
    shownKey = null;
    checklistFor = null;
}

/** Shows the selected method; does nothing if the same code is already shown, unless forced. */
export async function show(force = false) {
    const method = state.method && data.methodsByKey.get(state.method);
    const lang = state.lang;
    diffview.setLanguage(lang === "il");
    $("#reload").disabled = !method;
    $("#il-diff-note").hidden = lang !== "il";

    if (!method) {
        shownKey = null;
        checklistFor = null;
        ++seq;
        renderHeader(null);
        $("#warnings").replaceChildren();
        $("#code-status").textContent = "";
        renderedMethod = null;
        diffview.reset(state.method && data.catalog ? "// This method is no longer patched" : "// Nothing selected");
        return;
    }

    renderHeader(method);
    renderChecklist(method);

    // Execution order, and only keys this method still has
    const all = sortPatches(method.patches);
    const checked = new Set(state.patches);
    const checkedKeys = all.filter(p => checked.has(p.key)).map(p => p.key);
    const others = state.baseline === "others";
    const leftKeys = others ? all.filter(p => !checked.has(p.key)).map(p => p.key) : [];
    const rightKeys = others ? all.map(p => p.key) : checkedKeys;

    $("#code1title").textContent = others
        ? `Everything else (${leftKeys.length} of ${all.length} patches)`
        : "Original";
    $("#code2title").textContent = others
        ? `All patches (${all.length}), adds the ${checkedKeys.length} checked`
        : `Patched (${checkedKeys.length} of ${all.length} patches)`;

    const viewKey = `${method.key}|${lang}|${leftKeys.join(",")}|${rightKeys.join(",")}`;
    if (!force && viewKey === shownKey) return;
    shownKey = viewKey;
    const my = ++seq;

    $("#warnings").replaceChildren();
    $("#code-status").textContent = "Decompiling…";

    // Only the unpatched side is cached: the patched sides change with every toggle
    const fetchSide = (keys) => keys.length ? api.code(method.key, keys, lang) : api.cachedCode(method.key, [], lang);

    let left, right;
    try {
        const leftReq = fetchSide(leftKeys);
        const rightReq = rightKeys.join(",") === leftKeys.join(",") ? leftReq : fetchSide(rightKeys);
        [left, right] = await Promise.all([leftReq, rightReq]);
    } catch (e) {
        if (my !== seq) return;
        shownKey = null;
        // Game closed: keep the old code on screen; main.js re-runs show() once the game is back
        if (api.getStatus() === "offline") {
            $("#code-status").textContent = "Game not running. The code reloads when it's back.";
            return;
        }
        $("#code-status").textContent = "";
        renderWarnings([`Request failed: ${e.message}`]);
        diffview.reset("// Request failed");
        return;
    }
    if (my !== seq) return;

    renderWarnings([...new Set([...(left.warnings ?? []), ...(right.warnings ?? [])])]);
    $("#code-status").textContent = "Diffing and highlighting…";
    await breath();
    if (my !== seq) return;

    // Re-rendering the same method (reload, reconnect, toggling a patch) keeps the scroll position
    const content = $(".content");
    const scrollTop = renderedMethod === method.key ? content.scrollTop : null;
    if (left.exception || right.exception) {
        diffview.setPlain(left.exception ?? left.code, right.exception ?? right.code);
    } else {
        diffview.diffAndSetCode(left.code, right.code, lang === "il");
    }
    renderedMethod = method.key;
    if (scrollTop != null) content.scrollTop = scrollTop;
    $("#code-status").textContent = "";
}

/** Shows an inline notice above the method (null hides it) */
export function setNotice(text) {
    showNotice($("#notice"), text);
}

function viewSource(e, p) {
    // The button sits inside the row's <label>; don't toggle the checkbox
    e.preventDefault();
    e.stopPropagation();
    // As compiled: patch methods are mostly iterators (transpilers) or pass-through postfixes, which only read well
    // when decompiled in their own module
    openLookup(p.methodKey, "compiled");
}

function renderHeader(method) {
    const header = $("#method-header");
    if (!method) {
        header.replaceChildren(el("p.muted", {}, state.method ? "The selected method is no longer patched." : "Select a patched method on the left."));
        $("#patch-panel").replaceChildren();
        $("#code1title").textContent = "Original";
        $("#code2title").textContent = "Patched";
        return;
    }

    header.replaceChildren(...methodHeader(method.type, method.name, method.signature, method.targetAssembly));
}

/** Builds the checklist once per method, then only syncs checkboxes and buttons, so focus survives a toggle */
function renderChecklist(method) {
    const panel = $("#patch-panel");
    if (checklistFor !== method.key) {
        checklistFor = method.key;
        panel.replaceChildren(buildChecklist(method));
    }

    const checked = new Set(state.patches);
    const matching = new Set(matchingPatches(method, state.filters).map(p => p.key));
    for (const input of $$("input[data-patch]", panel)) {
        input.checked = checked.has(input.dataset.patch);
        input.closest(".patch-row").classList.toggle("unmatched", !matching.has(input.dataset.patch));
    }
    for (const b of $$("[data-baseline]", panel))
        b.setAttribute("aria-pressed", String(b.dataset.baseline === state.baseline));
    const n = method.patches.filter(p => checked.has(p.key)).length;
    $(".checked-count", panel).textContent = `${n} of ${method.patches.length} checked`;
}

function buildChecklist(method) {
    const all = sortPatches(method.patches);
    const groups = PATCH_TYPES.map(t => ({ t, patches: all.filter(p => p.type === t.id) })).filter(g => g.patches.length);

    const onToggle = (e) => {
        const key = e.target.dataset.patch;
        const next = e.target.checked ? [...state.patches, key] : state.patches.filter(k => k !== key);
        setPatches(next);
    };

    return el("div.checklist", {},
        el("div.checklist-bar", {},
            el("span.checklist-title", {}, "Patches"),
            el("button.small", { type: "button", onclick: () => setPatches(all.map(p => p.key)) }, "All"),
            el("button.small", { type: "button", onclick: () => setPatches([]) }, "None"),
            el("button.small", { type: "button", onclick: () => setPatches(null, true), title: "Check the patches that pass the sidebar filters" }, "Matching filters"),
            el("span.checked-count.muted"),
            el("span.baseline", {},
                el("span.muted", {}, "Left side:"),
                el("span.segmented", { role: "group", "aria-label": "Baseline" },
                    el("button", { type: "button", dataset: { baseline: "original" }, title: "Left = no patches, right = the checked patches", onclick: () => update({ baseline: "original" }) }, "Original"),
                    el("button", { type: "button", dataset: { baseline: "others" }, title: "Left = every patch except the checked ones, right = every patch", onclick: () => update({ baseline: "others" }) }, "Everything else")))),
        groups.map(({ t, patches }) =>
            el("div.patch-group", {},
                el("div.group-title", {}, el(`span.badge.t-${t.id}`, {}, t.short), ` ${t.label} (${patches.length})`, patches.length > 1 ? el("span.muted", {}, " · execution order") : null),
                patches.map(p => el("label.patch-row", { title: p.erroring ? p.error ?? "Failed to apply in game" : `${p.declaringType}::${p.name}` },
                    el("input", { type: "checkbox", dataset: { patch: p.key }, onchange: onToggle }),
                    el("span.mono.patch-name", {}, `${shortTypeName(p.declaringType)}::${p.name}`),
                    el("span.muted", {}, p.owner),
                    el("span.muted", {}, p.patchAssembly),
                    el("span.muted", {}, `priority ${p.priority}`),
                    p.erroring ? el("span.badge.err", { title: p.error ?? "" }, "erroring") : null,
                    el("button.link.view-source", { type: "button", title: "Open the patch method itself in Method lookup", onclick: e => viewSource(e, p) }, "view source"))))),
        el("p.hint", {}, "Prefixes, postfixes and finalizers show up as calls in the patched method; \"view source\" shows their bodies. Dimmed patches don't match the sidebar filters. Original = the IL as loaded, which may already include Prepatcher changes."));
}


function renderWarnings(warnings) {
    $("#warnings").replaceChildren(...warnings.map(w => el("div.warning", {}, w)));
}
