// Talks to the in-game server. Every call reports the connection status, which drives the header pill.
// pollAlive() keeps polling /alive so the page notices the game going away, coming back, or patching at runtime.

const statusListeners = new Set();
let status = "connecting";

export function getStatus() {
    return status;
}

export function onStatus(fn) {
    statusListeners.add(fn);
    fn(status);
    return () => statusListeners.delete(fn);
}

function setStatus(s) {
    if (s === status) return;
    status = s;
    for (const fn of statusListeners) fn(s);
}

async function request(path, init) {
    let res;
    try {
        res = await fetch(path, { cache: "no-store", ...init });
    } catch (e) {
        // Only a network error means the game isn't there
        setStatus("offline");
        throw e;
    }
    setStatus("connected");

    const text = await res.text();
    let json;
    try {
        json = text ? JSON.parse(text) : {};
    } catch {
        throw new Error(`${path}: HTTP ${res.status}, not JSON`);
    }
    // The server answers 500 with { exception } when a handler throws
    if (!res.ok && !json.exception)
        throw new Error(`${path}: HTTP ${res.status}`);
    return json;
}

function post(path, body) {
    return request(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body ?? {}),
    });
}

/** @returns {Promise<{instance: string, patchVersion: number}>} */
export const alive = () => request("/alive");

const POLL_MS = 2000;
const OFFLINE_POLL_MS = 5000;

/**
 * Polls /alive forever, one request at a time, calling onAlive(reply) for each answer. The server is single-threaded,
 * so a reply can be slow while a method decompiles; that still counts as alive. Only a network error is offline,
 * which slows polling down.
 */
export function pollAlive(onAlive) {
    const tick = async () => {
        let delay = POLL_MS;
        try {
            onAlive(await alive());
        } catch {
            if (status === "offline") delay = OFFLINE_POLL_MS;
        }
        setTimeout(tick, delay);
    };
    tick();
}

/** @returns {Promise<{instance: string, patchVersion: number, methods: CatalogMethod[]}>} */
export const patches = () => post("/patches");

/** source: omitted = build through Harmony with patchKeys; "compiled" = decompile from the assembly file (patches ignored)
 *  @returns {Promise<{code?: string, exception?: string, unsupported?: boolean, file?: string, source?: string, warnings: string[]}>} */
export const code = (method, patchKeys, lang, source) => post("/code", { method, patches: patchKeys, lang, source });

// Successful /code responses, shared by both tabs (the Patches "Original" side and lookup's "As loaded" are the same request)
const codeCache = new Map(); // `${method}|${lang}|${source}|${patch keys}` -> response

/** code(), cached until clearCodeCache() */
export function cachedCode(method, patchKeys, lang, source) {
    const cacheKey = `${method}|${lang}|${source ?? ""}|${patchKeys.join(",")}`;
    const hit = codeCache.get(cacheKey);
    if (hit) return Promise.resolve(hit);
    return code(method, patchKeys, lang, source).then(r => {
        if (!r.exception) codeCache.set(cacheKey, r);
        return r;
    });
}

/** Drops the cached code of one method, or of every method */
export function clearCodeCache(method) {
    if (method == null) return codeCache.clear();
    for (const k of codeCache.keys()) if (k.startsWith(`${method}|`)) codeCache.delete(k);
}

export const types = (query) => post("/types", { query });
export const methods = (type, assembly) => post("/methods", { type, assembly });
export const resolve = (text) => post("/resolve", { text });

/**
 * @typedef {{ key: string, name: string, type: string, signature: string, targetAssembly: string, erroring: boolean,
 *             patches: CatalogPatch[] }} CatalogMethod
 * @typedef {{ key: string, type: string, name: string, declaringType: string, patchAssembly: string, owner: string,
 *             priority: number, before: string[], after: string[], order: number, erroring: boolean, error: ?string }} CatalogPatch
 */
