// Appearance transaction (vNext S1): a preview over a copy; nothing is written until commit, cancel restores the original, and
// settings that this system cannot apply are reported as unavailable instead of being forced.

/** `current`: {key: value}; `supported`: keys that can be applied here; `write(key, value)` does the real write (GSettings in the shell). */
export function beginTransaction(current, supported) {
    const original = {...current};
    let draft = {...current};
    const unavailable = new Set();
    return {
        set(key, value) {
            if (!(key in original))
                throw new Error(`unknown setting "${key}"`);
            if (!supported.includes(key)) {
                unavailable.add(key);
                return false;
            }
            draft[key] = value;
            return true;
        },
        /** The draft, for a live preview. The real settings are untouched. */
        preview: () => ({...draft}),
        changes: () => Object.keys(draft).filter(k => draft[k] !== original[k]).map(k => ({key: k, before: original[k], after: draft[k]})),
        unavailable: () => [...unavailable],
        /** Writes the changes; if one write fails, the ones already made are put back and the error is returned. */
        commit(write) {
            const done = [];
            for (const c of this.changes()) {
                try {
                    write(c.key, c.after);
                    done.push(c);
                } catch (e) {
                    for (const d of done.reverse()) {
                        try { write(d.key, d.before); } catch (_e) { /* best effort */ }
                    }
                    return {ok: false, error: `${c.key}: ${e.message}`, rolledBack: done.length};
                }
            }
            return {ok: true, written: done.length};
        },
        cancel() { draft = {...original}; },
        reset(key) { if (key in original) draft[key] = original[key]; },
        /** Before/after views for the compare mode. */
        before: () => ({...original}),
        after: () => ({...draft}),
    };
}
