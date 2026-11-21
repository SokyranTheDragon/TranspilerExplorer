// Sidebar: search box, filters and the result list of patched methods.

import { $, $$, el, debounce } from "./dom.js";
import { state, data, update, setFilters, resetFilters, selectMethod, hasActiveFilters } from "./state.js";
import { PATCH_TYPES, apply, facetOptions, typeCounts, shortTypeName, namespaceOf } from "./filter.js";

const MAX_ROWS = 500;

const MULTI_FACETS = [
    { id: "targetAsm", label: "Target assembly", hint: "Assemblies containing the patched methods (patches in)" },
    { id: "patchAsm", label: "Patch assembly", hint: "Assemblies containing the patch methods (patches from)" },
    { id: "owners", label: "Harmony ID", hint: "Owner the patch was registered under" },
];

let result = { listed: [], counts: null };
let facetEls = {}; // facet id -> { summary, options: Map<value, { row, input, count }> }

export function initSidebar() {
    const search = $("#search");
    search.value = state.q;
    const onSearch = debounce(() => update({ q: search.value }), 150);
    search.addEventListener("input", onSearch);
    search.addEventListener("keydown", e => {
        if (e.key === "ArrowDown") {
            e.preventDefault();
            moveSelection(1, true);
        } else if (e.key === "Enter") {
            update({ q: search.value });
        }
    });

    const list = $("#list");
    list.addEventListener("click", e => {
        const row = e.target.closest(".row");
        if (row) selectMethod(row.dataset.key);
    });
    list.addEventListener("keydown", e => {
        if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            moveSelection(e.key === "ArrowDown" ? 1 : -1, false);
        }
    });
}

function moveSelection(dir, fromSearch) {
    const rows = $$(".row", $("#list"));
    if (!rows.length) return;
    let i = rows.findIndex(r => r.dataset.key === state.method);
    i = fromSearch && i < 0 ? 0 : Math.max(0, Math.min(rows.length - 1, i + dir));
    selectMethod(rows[i].dataset.key);
    rows[i].scrollIntoView({ block: "nearest" });
    $("#list").focus();
}

/** Builds the filter controls for a new catalog. Options are fixed per catalog, only their counts change. */
export function buildFilters() {
    const options = facetOptions(data.catalog.methods);
    // A restored selection may name values this catalog doesn't have; list them so they can be unchecked
    for (const f of MULTI_FACETS)
        for (const v of state.filters[f.id])
            if (!options[f.id].includes(v)) options[f.id].push(v);
    const root = $("#filters");
    // Rebuilt on every catalog reload: keep the facets the user had open, and the scroll position
    const wasOpen = new Set($$("details.facet[data-facet]", root).filter(d => d.open).map(d => d.dataset.facet));
    const scrollTop = root.scrollTop;
    root.replaceChildren();
    facetEls = {};

    // Patch types: always all 7, as a checkbox grid
    const typeOpts = new Map();
    const typeGrid = el("div.type-grid");
    for (const t of PATCH_TYPES) {
        const o = optionRow("types", t.id, `${t.label}`, t.short);
        typeOpts.set(t.id, o);
        typeGrid.append(o.row);
    }
    const typesBox = el("details.facet", { open: true },
        el("summary", {}, el("span", {}, "Patch type"), el("span.facet-sel")),
        typeGrid);
    facetEls.types = { summary: typesBox.querySelector(".facet-sel"), options: typeOpts };
    root.append(typesBox);

    for (const f of MULTI_FACETS) {
        const opts = new Map();
        const listEl = el("div.facet-options");
        for (const v of options[f.id]) {
            const o = optionRow(f.id, v, v || "(none)");
            opts.set(v, o);
            listEl.append(o.row);
        }

        const box = el("details.facet", { title: f.hint, dataset: { facet: f.id } },
            el("summary", {}, el("span", {}, f.label), el("span.facet-sel")));
        if (options[f.id].length > 8) {
            const filterInput = el("input.facet-filter", { type: "search", placeholder: `Filter ${f.label.toLowerCase()}`, spellcheck: "false" });
            filterInput.addEventListener("input", () => {
                const q = filterInput.value.trim().toLowerCase();
                for (const [v, o] of opts) o.row.hidden = q !== "" && !v.toLowerCase().includes(q);
            });
            box.append(filterInput);
        }
        box.append(listEl);
        if (state.filters[f.id].length || wasOpen.has(f.id)) box.open = true;
        facetEls[f.id] = { summary: box.querySelector(".facet-sel"), options: opts };
        root.append(box);
    }

    const erroring = el("input", { type: "checkbox", checked: state.filters.erroringOnly });
    erroring.addEventListener("change", () => setFilters({ erroringOnly: erroring.checked }));
    const erroringCount = el("span.count");
    facetEls.erroringOnly = { input: erroring, count: erroringCount };

    const clear = el("button.link", { type: "button", onclick: () => resetFilters() }, "Clear filters");
    facetEls.clear = clear;
    root.append(el("div.filter-footer", {},
        el("label.check", {}, erroring, el("span", {}, "Erroring only"), erroringCount),
        clear));
    root.scrollTop = scrollTop;
}

function optionRow(facet, value, label, badge) {
    const input = el("input", { type: "checkbox" });
    input.addEventListener("change", () => {
        const cur = state.filters[facet];
        const next = input.checked ? [...cur, value] : cur.filter(v => v !== value);
        setFilters({ [facet]: next });
    });
    const count = el("span.count");
    const row = el("label.check", { title: value },
        input,
        badge ? el(`span.badge.t-${value}`, {}, badge) : null,
        el("span.opt-label", {}, label),
        count);
    return { row, input, count };
}

/** Re-applies search and filters, then redraws the counts and the list */
export function refreshList() {
    if (!data.catalog) return;
    result = apply(data.catalog.methods, state.filters, state.q);
    renderCounts();
    renderList();
}

function renderCounts() {
    for (const [facet, f] of Object.entries(facetEls)) {
        if (!f.options) continue;
        const selected = new Set(state.filters[facet]);
        const counts = result.counts[facet];
        for (const [v, o] of f.options) {
            const n = counts.get(v) ?? 0;
            o.input.checked = selected.has(v);
            o.count.textContent = n;
            o.row.classList.toggle("zero", n === 0 && !selected.has(v));
        }
        f.summary.textContent = selected.size ? `${selected.size} selected` : "";
    }
    facetEls.erroringOnly.input.checked = state.filters.erroringOnly;
    facetEls.erroringOnly.count.textContent = result.counts.erroringOnly;
    facetEls.clear.hidden = !hasActiveFilters();
}

export function renderList() {
    const list = $("#list");
    const total = data.catalog.methods.length;
    const shown = result.listed.slice(0, MAX_ROWS);

    const frag = document.createDocumentFragment();
    for (const m of shown) frag.append(methodRow(m));
    if (result.listed.length > MAX_ROWS)
        frag.append(el("p.more", {}, `${result.listed.length - MAX_ROWS} more, refine your search`));
    if (!result.listed.length)
        frag.append(el("p.more", {}, total ? "No patched methods match." : "No patched methods."));
    list.replaceChildren(frag);

    $("#list-summary").textContent = result.listed.length === total
        ? `${total} patched methods`
        : `${result.listed.length} of ${total} patched methods`;
}

function methodRow(m) {
    const counts = typeCounts(m);
    const erroring = m.patches.filter(p => p.erroring).length;
    const ns = namespaceOf(m.type);
    return el("div.row", {
        role: "option",
        dataset: { key: m.key },
        "aria-selected": String(m.key === state.method),
        title: m.signature || `${m.type}::${m.name}`,
    },
        el("div.row-name", {}, el("span.row-type", {}, shortTypeName(m.type)), "::", el("b", {}, m.name)),
        el("div.row-meta", {},
            el("span.row-asm", {}, ns ? `${m.targetAssembly} · ${ns}` : m.targetAssembly),
            el("span.badges", {},
                PATCH_TYPES.map((t, i) => counts[i] ? el(`span.badge.t-${t.id}`, { title: `${counts[i]} ${t.label.toLowerCase()}(s)` }, `${t.short} ${counts[i]}`) : null),
                erroring ? el("span.badge.err", { title: `${erroring} erroring patch(es)` }, `! ${erroring}`) : null)));
}

/** Scrolls the list to the selected method's row, if it's listed */
export function scrollSelectedIntoView() {
    const row = $$(".row", $("#list")).find(r => r.dataset.key === state.method);
    row?.scrollIntoView({ block: "center" });
}

/** Updates the selected row without redrawing the list */
export function markSelected() {
    for (const row of $$(".row", $("#list")))
        row.setAttribute("aria-selected", String(row.dataset.key === state.method));
}
