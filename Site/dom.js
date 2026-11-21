export const $ = (selector, container) => (container || document).querySelector(selector);
export const $$ = (selector, container) => Array.from((container || document).querySelectorAll(selector));

/** el("div.a.b", { title: "x", onclick }, child, "text", ...) */
export function el(tag, attrs, ...children) {
    const [name, ...classes] = tag.split(".");
    const e = document.createElement(name || "div");
    if (classes.length) e.className = classes.join(" ");
    for (const [k, v] of Object.entries(attrs ?? {})) {
        if (v == null || v === false) continue;
        if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
        else if (k === "dataset") Object.assign(e.dataset, v);
        else if (k in e && typeof v !== "string") e[k] = v;
        else e.setAttribute(k, v === true ? "" : v);
    }
    for (const c of children.flat()) if (c != null && c !== false) e.append(c);
    return e;
}

export function debounce(fn, ms) {
    let t;
    return (...args) => {
        clearTimeout(t);
        t = setTimeout(() => fn(...args), ms);
    };
}

/** Shows a dismissable notice in `container` (a .notice element); null hides it */
export function showNotice(container, text) {
    container.hidden = !text;
    container.replaceChildren(...(text ? [
        el("span", {}, text),
        el("button.link", { type: "button", title: "Dismiss", onclick: () => showNotice(container, null) }, "Dismiss"),
    ] : []));
}

/** Sets the Prism language class (C# or CIL) on code elements */
export function setLanguageClass(elements, isIL) {
    for (const e of elements) {
        e.classList.remove("language-cil", "language-csharp");
        e.classList.add(isIL ? "language-cil" : "language-csharp");
    }
}

/** The method header: Type::Name, signature, assembly */
export const methodHeader = (type, name, signature, assembly) => [
    el("h2.method-title", {}, el("span.row-type", {}, type), "::", el("b", {}, name)),
    el("p.muted.mono", {}, signature),
    el("p.muted", {}, `in ${assembly}`),
];

/** Yields to the browser so a status text can paint before heavy work */
export const breath = () => new Promise(r => setTimeout(r, 0));
