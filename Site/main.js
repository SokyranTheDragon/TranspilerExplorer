// Entry point: wires state changes to the sidebar, the tabs and the code view, persists the state, and keeps the
// catalog in sync with the game through the /alive poll.

import { $, $$, el, debounce } from "./dom.js";
import { state, data, update, subscribe, restore, setCatalog } from "./state.js";
import * as api from "./api.js";
import * as persist from "./persist.js";
import * as list from "./list.js";
import * as codeview from "./codeview.js";
import * as diffview from "./diffview.js";
import * as lookup from "./lookup.js";

const STATUS_TEXT = { connecting: "Connecting…", connected: "Connected", offline: "Game not running, waiting…" };

function init() {
    // Restore before anything renders, so the inputs show the saved view right away
    restore(persist.load());
    persist.save();
    subscribe(() => persist.save());

    let wasOffline = false;
    api.onStatus(s => {
        const pill = $("#status");
        pill.dataset.status = s;
        pill.textContent = STATUS_TEXT[s] ?? s;
        if (s === "offline") wasOffline = true;
    });

    for (const b of $$(".tab")) b.addEventListener("click", () => update({ tab: b.dataset.tab }));
    for (const b of $$(".lang-button")) b.addEventListener("click", () => update({ lang: b.dataset.lang }));

    list.initSidebar();
    lookup.init();
    diffview.reset();
    renderTabs();
    renderLang();

    // Filter clicks can come in quick succession; each may change the right side's checked patches
    const showDebounced = debounce(() => codeview.show(), 250);

    subscribe(changed => {
        if (changed.has("tab")) renderTabs();
        if (changed.has("lang")) renderLang();
        if (changed.has("q") || changed.has("filters")) list.refreshList();
        else if (changed.has("method")) list.markSelected();
        if (changed.has("method")) codeview.setNotice(null);
        if (changed.has("lookup")) lookup.setNotice(null);
        // The lookup only fetches while its tab is shown (the server is single-threaded)
        if (changed.has("lookup") || changed.has("lang") || changed.has("tab")) lookup.show();

        if (changed.has("method") || changed.has("lang") || changed.has("baseline")) codeview.show();
        else if (changed.has("filters")) showDebounced();
        else if (changed.has("patches")) codeview.show();
    });

    window.addEventListener("resize", debounce(() => diffview.rerender(), 200));

    // Reload code: button and the R shortcut (not while typing in a field), for the tab that's shown
    $("#reload").addEventListener("click", () => codeview.reload());
    document.addEventListener("keydown", e => {
        if (e.key !== "r" && e.key !== "R") return;
        if (e.ctrlKey || e.metaKey || e.altKey || e.repeat) return;
        if (e.target.closest?.("input[type=search], input[type=text], textarea, [contenteditable]")) return;
        e.preventDefault();
        if (state.tab === "lookup") lookup.reload();
        else codeview.reload();
    });

    $("#list-summary").textContent = "Loading patches…";

    // The first reply loads the catalog. A new instance (game restarted) or patchVersion (patched at runtime) reloads it.
    api.pollAlive(alive => {
        const version = versionOf(alive);
        if (!data.catalog || version !== versionOf(data.catalog)) {
            if (version !== failedVersion) loadCatalog(version);
        } else if (wasOffline) {
            // Back after a blip with nothing changed: fetch whatever failed while offline
            codeview.show();
            lookup.show();
        }
        wasOffline = false;
    });
}

const versionOf = (r) => `${r.instance}|${r.patchVersion}`;

let loading = false;
let failedVersion = null; // version whose /patches failed with a server error, so the poll doesn't retry it every 2 s

async function loadCatalog(version) {
    if (loading) return;
    loading = true;
    const first = !data.catalog;
    let catalog;
    try {
        catalog = await api.patches();
        if (catalog.exception) throw new Error(catalog.exception);
    } catch (e) {
        // Offline: the poll retries when the game is back. Otherwise wait for a new version or the Retry button.
        failedVersion = api.getStatus() === "offline" ? null : version;
        const retry = el("button.link", { type: "button", onclick: () => { failedVersion = null; loadCatalog(version); } }, "Retry");
        if (first) {
            $("#list-summary").textContent = "";
            $("#list").replaceChildren(el("p.more", {}, `Couldn't load patches: ${e.message}`), retry);
        } else {
            $("#list-summary").replaceChildren(`Couldn't reload patches: ${e.message} `, retry);
        }
        return;
    } finally {
        loading = false;
    }
    failedVersion = null;

    const { missingPatches } = setCatalog(catalog);
    persist.save();
    api.clearCodeCache();
    codeview.clearCache();
    list.buildFilters();
    list.refreshList();
    if (first) list.scrollSelectedIntoView();
    if (missingPatches)
        codeview.setNotice(`${missingPatches} previously selected patch${missingPatches === 1 ? " is" : "es are"} no longer present.`);
    codeview.show(true);
    // A new instance may have lost the looked-up method (or renumbered its compiler-generated type)
    lookup.clearCache();
    lookup.show();
}

function renderTabs() {
    for (const b of $$(".tab")) b.setAttribute("aria-selected", String(b.dataset.tab === state.tab));
    $("#tab-patches").hidden = state.tab !== "patches";
    $("#tab-lookup").hidden = state.tab !== "lookup";
    // The diff's line-height equalisation is measured while visible
    if (state.tab === "patches") diffview.rerender();
}

function renderLang() {
    for (const b of $$(".lang-button")) b.setAttribute("aria-pressed", String(b.dataset.lang === state.lang));
}

init();
