// The panel's pure logic (no GTK): search, dependencies, shortcut conflicts. Tested with node.
import type {Item} from './types.js';

/** HTML entities in a text the schemas hand us (`&quot;`) turned into what they stand for. */
export function decodeEntities(text: string): string {
    return text.replace(/&(apos|quot|amp|lt|gt|#39);/g, (_m, name) =>
        ({apos: "'", '#39': "'", quot: '"', amp: '&', lt: '<', gt: '>'} as Record<string, string>)[name]);
}

const haystack = (item: Item) => [item.title, item.help, item.group, item.menu, item.key, ...(item.options ?? []).map(o => o.label)]
    .join(' ').toLowerCase();

/** Items matching every word of `query`, best first: a title hit beats a help hit beats a key or group hit. */
export function searchItems(catalog: Item[], query: string): Item[] {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (!words.length)
        return [];
    const scored: [number, number, Item][] = [];
    catalog.forEach((item, order) => {
        const all = haystack(item);
        if (!words.every(w => all.includes(w)))
            return;
        const title = item.title.toLowerCase();
        let score = 0;
        for (const w of words) {
            if (title.startsWith(w)) score += 4;
            else if (title.includes(w)) score += 3;
            else if (item.help.toLowerCase().includes(w)) score += 2;
            else score += 1;
        }
        scored.push([score, order, item]);
    });
    return scored.sort((a, b) => b[0] - a[0] || a[1] - b[1]).map(s => s[2]);
}

/** Whether `item`'s dependency holds, given a way to read the value of another item. */
export function dependencyMet(item: Item, valueOf: (id: string) => unknown): boolean {
    const dep = item.depends;
    if (!dep)
        return true;
    const value = valueOf(dep.id);
    switch (dep.op) {
    case 'on': return value === true;
    case 'off': return value === false;
    case 'eq': return String(value) === dep.value;
    case 'ne': return String(value) !== dep.value;
    }
}

// ---- Shortcuts

const MODIFIERS = ['Primary', 'Control', 'Alt', 'Shift', 'Super', 'Meta', 'Hyper'];

/** `<Alt><Super>m` and `<Super><Alt>M` are the same shortcut: modifiers sorted, the key lower-cased. */
export function normalizeAccel(accel: string): string {
    const mods = [...accel.matchAll(/<([^>]+)>/g)].map(m => m[1].replace('Ctrl', 'Control'));
    const key = accel.replace(/<[^>]+>/g, '').trim().toLowerCase();
    return [...mods.map(m => m.toLowerCase())].sort().map(m => `<${m}>`).join('') + key;
}

export interface Binding {owner: string; accel: string}

/** The first of `taken` that uses `accel` (an item's own current shortcut excluded by the caller), or null. */
export function findConflict(accel: string, taken: Binding[]): Binding | null {
    const wanted = normalizeAccel(accel);
    if (!wanted)
        return null;
    return taken.find(t => normalizeAccel(t.accel) === wanted) ?? null;
}

/** A shortcut needs a modifier, unless it is a function key. */
export function hasModifier(accel: string): boolean {
    return MODIFIERS.some(m => accel.includes(`<${m}>`)) || /^(F\d{1,2}|XF86\w+)$/.test(accel.replace(/<[^>]+>/g, ''));
}

const ORDER = ['Primary', 'Control', 'Super', 'Alt', 'Shift', 'Meta', 'Hyper'];

/** The way the schemas write a shortcut (`<Super><Alt>m`), whatever order GTK names the modifiers in. */
export function canonicalAccel(accel: string): string {
    const mods = [...accel.matchAll(/<([^>]+)>/g)].map(m => m[1]);
    const key = accel.replace(/<[^>]+>/g, '');
    return [...mods].sort((a, b) => ORDER.indexOf(a) - ORDER.indexOf(b)).map(m => `<${m}>`).join('') + key;
}
