// Shelf 2.0 core (vNext initiative 19). Pure: collections of REFERENCES (file URIs, URLs, text snippets, images by URI). A shelf holds
// pointers: removing, moving or "deleting" an item only changes the reference list and can never touch the original file. Batch plans
// contain only move/copy/remove-reference steps. Text snippets share a byte quota. Time is passed in; nothing is scheduled.
// Today's island shelf (crates/island-shelf) is a flat list of 6 local files `{uri, name}`; `fromLegacy` imports that shape.

export const ITEM_KINDS = ['file', 'url', 'text', 'image'];
export const DEFAULTS = {quotaBytes: 64 * 1024, maxCollections: 50, maxItems: 100, snippetMax: 8 * 1024, defaultTtlMs: 24 * 3600 * 1000, maxUnpinned: 20};
const enc = new TextEncoder();
const bytes = s => enc.encode(s).length;

function validateRef(ref, o) {
    if (!ITEM_KINDS.includes(ref?.kind))
        return 'unknown kind';
    if (ref.kind === 'text') {
        if (typeof ref.text !== 'string' || !ref.text.trim())
            return 'empty text';
        return bytes(ref.text) > o.snippetMax ? 'snippet too large' : null;
    }
    // No `URL` class: GNOME Shell's JavaScript does not have one. A scheme, then what that scheme needs, and no spaces or control characters.
    const uri = typeof ref.uri === 'string' ? ref.uri : '';
    const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(uri)?.[1].toLowerCase();
    if (!scheme || uri.length > 4096 || /[\s\u0000-\u001f]/.test(uri))
        return 'invalid uri';
    const web = /^https?:\/\/[^/?#\s]+/i.test(uri), local = /^file:\/\/[^?#]*[^/?#]/i.test(uri) && /^file:\/\/[^/]*\//i.test(uri);
    if (ref.kind === 'file' && !local)
        return scheme === 'file' ? 'invalid uri' : 'file references must be file:// URIs';
    if (ref.kind === 'url' && !web)
        return ['http', 'https'].includes(scheme) ? 'invalid uri' : 'url references must be http(s)';
    if (ref.kind === 'image' && !web && !local)
        return ['file', 'http', 'https'].includes(scheme) ? 'invalid uri' : 'image references must be file or http(s)';
    return null;
}

export function createShelf(options = {}) {
    const o = {...DEFAULTS, ...options};
    let seq = 0;
    let cols = [];

    const col = id => cols.find(c => c.id === id);
    const textBytes = () => cols.reduce((n, c) => n + c.items.reduce((m, i) => m + (i.kind === 'text' ? bytes(i.text) : 0), 0), 0);
    const nameTaken = (name, except) => cols.some(c => c.id !== except && c.name.toLowerCase() === name.toLowerCase());
    const cleanName = n => typeof n === 'string' ? n.trim().slice(0, 60) : '';

    const api = {
        get collections() { return cols; },
        get quota() { return {used: textBytes(), limit: o.quotaBytes}; },

        create(name, {ttlMs = null, now = 0} = {}) {
            const n = cleanName(name);
            if (!n)
                return {ok: false, reason: 'empty name'};
            if (nameTaken(n))
                return {ok: false, reason: 'name taken'};
            if (cols.length >= o.maxCollections)
                return {ok: false, reason: 'too many collections'};
            const c = {id: `c${++seq}`, name: n, pinned: false, createdAt: now, expiresAt: ttlMs === null ? null : now + (ttlMs === true ? o.defaultTtlMs : ttlMs), items: []};
            cols.push(c);
            return {ok: true, id: c.id};
        },
        rename(id, name) {
            const c = col(id), n = cleanName(name);
            if (!c)
                return {ok: false, reason: 'unknown collection'};
            if (!n || nameTaken(n, id))
                return {ok: false, reason: n ? 'name taken' : 'empty name'};
            c.name = n;
            return {ok: true};
        },
        /** Pinning also removes any expiry: a pinned collection never expires. */
        pin(id, on = true) {
            const c = col(id);
            if (!c)
                return {ok: false, reason: 'unknown collection'};
            c.pinned = on === true;
            if (c.pinned)
                c.expiresAt = null;
            return {ok: true};
        },
        add(id, ref, now = 0) {
            const c = col(id);
            if (!c)
                return {ok: false, reason: 'unknown collection'};
            const bad = validateRef(ref, o);
            if (bad)
                return {ok: false, reason: bad};
            if (c.items.length >= o.maxItems)
                return {ok: false, reason: 'collection full'};
            const same = i => i.kind === ref.kind && (ref.kind === 'text' ? i.text === ref.text : i.uri === ref.uri);
            if (c.items.some(same))
                return {ok: false, reason: 'duplicate'};
            if (ref.kind === 'text' && textBytes() + bytes(ref.text) > o.quotaBytes)
                return {ok: false, reason: 'quota'};
            const item = {id: `i${++seq}`, kind: ref.kind, name: String(ref.name ?? (ref.kind === 'text' ? ref.text.slice(0, 30) : ref.uri.split('/').pop() || ref.uri)).slice(0, 120), addedAt: now};
            if (ref.kind === 'text')
                item.text = ref.text;
            else
                item.uri = ref.uri;
            c.items.push(item);
            return {ok: true, id: item.id};
        },
        /** Removes the REFERENCE only. */
        remove(id, itemId) {
            const c = col(id);
            if (!c)
                return {ok: false, reason: 'unknown collection'};
            const before = c.items.length;
            c.items = c.items.filter(i => i.id !== itemId);
            return {ok: c.items.length < before, touchesOriginals: false};
        },
        removeCollection(id) {
            const before = cols.length;
            cols = cols.filter(c => c.id !== id);
            return {ok: cols.length < before, touchesOriginals: false};
        },
        /** Case-insensitive search over collection names, item names, URIs and snippet text. Returns `[{collection, item}]` (item null for a name hit). */
        search(query) {
            const q = String(query ?? '').trim().toLowerCase();
            if (!q)
                return [];
            const hits = [];
            for (const c of cols) {
                if (c.name.toLowerCase().includes(q))
                    hits.push({collection: c.id, item: null});
                for (const i of c.items)
                    if ([i.name, i.uri, i.text].some(s => typeof s === 'string' && s.toLowerCase().includes(q)))
                        hits.push({collection: c.id, item: i.id});
            }
            return hits.slice(0, 200);
        },

        /**
         * Batch plan from `[{op: 'move'|'copy'|'remove', from, to?, items: [ids]}]`. Any other op (for example 'delete-file') is rejected.
         * Returns `{steps, rejected, touchesOriginals: false, quotaAfter}`; nothing changes until `apply(plan)`.
         */
        plan(actions) {
            const steps = [], rejected = [];
            let extra = 0;
            for (const a of actions ?? []) {
                if (!['move', 'copy', 'remove'].includes(a?.op)) {
                    rejected.push({action: a, reason: 'only move, copy and remove (reference) are allowed'});
                    continue;
                }
                const from = col(a.from), to = a.op === 'remove' ? null : col(a.to);
                if (!from || (a.op !== 'remove' && !to)) {
                    rejected.push({action: a, reason: 'unknown collection'});
                    continue;
                }
                for (const itemId of a.items ?? []) {
                    const item = from.items.find(i => i.id === itemId);
                    if (!item)
                        rejected.push({action: a, item: itemId, reason: 'unknown item'});
                    else if (a.op !== 'remove' && to.items.length + steps.filter(s => s.to === to.id && s.op !== 'remove').length >= o.maxItems)
                        rejected.push({action: a, item: itemId, reason: 'collection full'});
                    else if (a.op === 'copy' && item.kind === 'text' && textBytes() + extra + bytes(item.text) > o.quotaBytes)
                        rejected.push({action: a, item: itemId, reason: 'quota'});
                    else {
                        if (a.op === 'copy' && item.kind === 'text')
                            extra += bytes(item.text);
                        steps.push({op: a.op, from: from.id, to: to?.id ?? null, item: itemId});
                    }
                }
            }
            return {steps, rejected, touchesOriginals: false, quotaAfter: textBytes() + extra};
        },
        apply(plan) {
            let done = 0;
            for (const s of plan.steps ?? []) {
                const from = col(s.from), item = from?.items.find(i => i.id === s.item);
                if (!item)
                    continue;
                if (s.op === 'remove')
                    from.items = from.items.filter(i => i !== item);
                else {
                    const to = col(s.to);
                    if (!to)
                        continue;
                    if (s.op === 'move') {
                        from.items = from.items.filter(i => i !== item);
                        to.items.push(item);
                    } else
                        to.items.push({...item, id: `i${++seq}`});
                }
                done++;
            }
            return {applied: done, touchesOriginals: false};
        },

        /** Which collections the cleanup policy would remove at `now`: expired unpinned ones, then the oldest unpinned beyond `maxUnpinned`. */
        previewCleanup(now) {
            const unpinned = cols.filter(c => !c.pinned);
            const expired = unpinned.filter(c => c.expiresAt !== null && c.expiresAt <= now);
            const rest = unpinned.filter(c => !expired.includes(c)).sort((a, b) => a.createdAt - b.createdAt);
            const over = rest.slice(0, Math.max(0, rest.length - o.maxUnpinned));
            return [...expired.map(c => ({id: c.id, name: c.name, reason: 'expired'})), ...over.map(c => ({id: c.id, name: c.name, reason: 'over-limit'}))];
        },
        cleanup(now) {
            const gone = api.previewCleanup(now);
            cols = cols.filter(c => !gone.some(g => g.id === c.id));
            return {removed: gone, touchesOriginals: false};
        },

        /** Imports the current flat shelf `[{uri, name}]` into one collection (non-file URIs are skipped). */
        fromLegacy(items, name = 'Shelf', now = 0) {
            let c = cols.find(x => x.name === name);
            const id = c?.id ?? api.create(name, {now}).id;
            let added = 0;
            for (const it of items ?? [])
                if (id && api.add(id, {kind: 'file', uri: it?.uri, name: it?.name}, now).ok)
                    added++;
            return {collection: id, added};
        },
        snapshot() { return JSON.parse(JSON.stringify(cols)); },
        /** Restores what `snapshot()` gave (a file is untrusted: every name and reference is checked again; what fails is skipped). */
        load(data) {
            cols = [];
            const num = id => Number(String(id ?? '').slice(1)) || 0;
            let top = 0;
            for (const c of Array.isArray(data) ? data.slice(0, o.maxCollections) : []) {
                const name = cleanName(c?.name);
                if (!name || nameTaken(name) || !/^c\d+$/.test(String(c?.id)) || cols.some(x => x.id === c.id))
                    continue;
                const col = {id: c.id, name, pinned: c.pinned === true, createdAt: Number(c.createdAt) || 0,
                    expiresAt: c.pinned === true || !Number.isFinite(c.expiresAt) ? null : c.expiresAt, items: []};
                for (const i of Array.isArray(c.items) ? c.items.slice(0, o.maxItems) : []) {
                    const ref = i?.kind === 'text' ? {kind: 'text', text: i.text} : {kind: i?.kind, uri: i?.uri};
                    if (validateRef(ref, o) || !/^i\d+$/.test(String(i?.id)) || (i.kind === 'text' && textBytes() + col.items.reduce((m, x) => m + (x.kind === 'text' ? bytes(x.text) : 0), 0) + bytes(i.text) > o.quotaBytes))
                        continue;
                    col.items.push({id: i.id, kind: ref.kind, name: String(i.name ?? '').slice(0, 120), addedAt: Number(i.addedAt) || 0, ...(ref.kind === 'text' ? {text: ref.text} : {uri: ref.uri})});
                    top = Math.max(top, num(i.id));
                }
                cols.push(col);
                top = Math.max(top, num(c.id));
            }
            seq = top;
            return {collections: cols.length};
        },
    };
    return api;
}
