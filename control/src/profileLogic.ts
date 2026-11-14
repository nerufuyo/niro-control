// Profiles, the pure part (no GLib/GTK, tested with node): the file format, validation of a value against the catalog,
// resolving `extends`, and the difference between two sets of settings.
import {dependencyMet} from './logic.js';
import type {Item} from './types.js';

export const FORMAT = 'niro-profile';
export const BACKUP_FORMAT = 'niro-backup';
export const VERSION = 1;

export type Value = boolean | number | string | string[] | string[][] | Record<string, number>[];
export type Settings = Record<string, Value>;

export interface Profile {
    format: typeof FORMAT;
    version: number;
    id: string;
    name: string;
    description: string;
    extends?: string;
    createdAt: string;
    builtin?: boolean;      // set by the app for what it ships, never read from a file
    settings: Settings;
}

export interface Change {id: string; title: string; menu: string; group: string; from: Value | undefined; to: Value}

export const slugify = (name: string) =>
    name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'profile';

/** `base`, or `base-2`, `base-3`… when that id is taken. */
export function uniqueId(base: string, taken: Iterable<string>): string {
    const used = new Set(taken);
    let id = base, n = 2;
    while (used.has(id))
        id = `${base}-${n++}`;
    return id;
}

export function deepEqual(a: unknown, b: unknown): boolean {
    if (a === b) return true;
    if (typeof a === 'number' && typeof b === 'number') return Math.abs(a - b) < 1e-9;
    if (typeof a === 'string' && typeof b === 'string') return a.toLowerCase() === b.toLowerCase() && /^#[0-9a-f]{6}$/i.test(a) || a === b;
    if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => deepEqual(x, b[i]));
    if (a && b && typeof a === 'object' && typeof b === 'object') {
        const ka = Object.keys(a as object), kb = Object.keys(b as object);
        return ka.length === kb.length && ka.every(k => deepEqual((a as any)[k], (b as any)[k]));
    }
    return false;
}

const isStrings = (v: unknown): v is string[] => Array.isArray(v) && v.every(x => typeof x === 'string');

/** What is wrong with `value` as a value of `item`, or null when it is fine. */
export function validateValue(item: Item, value: unknown): string | null {
    switch (item.kind) {
    case 'switch':
        return typeof value === 'boolean' ? null : 'must be true or false';
    case 'slider':
    case 'stepper': {
        if (typeof value !== 'number' || !Number.isFinite(value)) return 'must be a number';
        if (item.min !== undefined && value < item.min) return `must be at least ${item.min}`;
        if (item.max !== undefined && value > item.max) return `must be at most ${item.max}`;
        if (!item.digits && !Number.isInteger(value)) return 'must be a whole number';
        return null;
    }
    case 'select':
        return (item.options ?? []).some(o => String(o.value) === String(value)) ? null
            : `must be one of ${(item.options ?? []).map(o => o.value).join(', ')}`;
    case 'color':
        return typeof value === 'string' && /^#[0-9a-fA-F]{6}$/.test(value) ? null : 'must be a colour like #RRGGBB';
    case 'text':
    case 'textarea':
        return typeof value === 'string' ? null : 'must be text';
    case 'list':
    case 'shortcut':
        return isStrings(value) ? null : 'must be a list of text';
    case 'shortcuts':
        return Array.isArray(value) && value.length === item.count && value.every(isStrings) ? null : `must be ${item.count} lists of text`;
    case 'dict':
        return Array.isArray(value) && value.length === (item.keys?.length ?? 0) && value.every(v => v && typeof v === 'object' &&
            (item.fields ?? []).every(f => Number.isFinite((v as any)[f]))) ? null : 'must be one set of numbers per shadow';
    }
    return 'unknown kind';
}

export interface Checked {ok: boolean; profile?: Profile; errors: string[]; warnings: string[]}

/** Reads a profile from parsed JSON: checks the format and version, every value, drops what this version does not know. */
export function validateProfile(raw: unknown, catalog: Item[]): Checked {
    const errors: string[] = [], warnings: string[] = [];
    const fail = (m: string): Checked => ({ok: false, errors: [m, ...errors], warnings});
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return fail('not a profile: the file does not hold an object');
    const r = raw as Record<string, any>;
    if (r.format !== FORMAT) return fail(`not a Niro profile (format is "${r.format ?? 'missing'}")`);
    if (!Number.isInteger(r.version) || r.version < 1) return fail('the profile has no valid version');
    if (r.version > VERSION) return fail(`made by a newer Niro Control (profile version ${r.version}, this one reads up to ${VERSION})`);
    if (typeof r.name !== 'string' || !r.name.trim()) return fail('the profile has no name');
    if (!r.settings || typeof r.settings !== 'object' || Array.isArray(r.settings)) return fail('the profile has no settings');
    const byId = new Map(catalog.map(i => [i.id, i]));
    const settings: Settings = {};
    for (const [id, value] of Object.entries(r.settings)) {
        const item = byId.get(id);
        if (!item) { warnings.push(`unknown setting "${id}" was left out`); continue; }
        if (item.managed) { warnings.push(`"${item.title}" follows ${item.managed}, so it was left out`); continue; }
        const problem = validateValue(item, value);
        if (problem) errors.push(`${item.title}: ${problem}`);
        else settings[id] = value as Value;
    }
    if (errors.length) return {ok: false, errors, warnings};
    const profile: Profile = {format: FORMAT, version: VERSION, id: slugify(String(r.id ?? r.name)), name: r.name.trim().slice(0, 60),
        description: typeof r.description === 'string' ? r.description.slice(0, 200) : '',
        createdAt: typeof r.createdAt === 'string' ? r.createdAt : new Date(0).toISOString(), settings};
    if (typeof r.extends === 'string' && r.extends) profile.extends = r.extends;
    return {ok: true, profile, errors, warnings};
}

/** The settings of `profile` with the ones it extends underneath (its own win). Cycles and long chains are cut. */
export function resolve(profile: Profile, find: (id: string) => Profile | undefined): Settings {
    const chain: Profile[] = [];
    const seen = new Set<string>();
    for (let p: Profile | undefined = profile; p && !seen.has(p.id) && chain.length < 6; p = p.extends ? find(p.extends) : undefined) {
        seen.add(p.id);
        chain.push(p);
    }
    return Object.assign({}, ...chain.reverse().map(p => p.settings));
}

/** Where applying `target` to `current` changes something: only the settings `target` names, only those that differ. */
export function diff(current: Settings, target: Settings, catalog: Item[]): Change[] {
    const out: Change[] = [];
    for (const item of catalog) {
        if (!(item.id in target)) continue;
        if (deepEqual(current[item.id], target[item.id])) continue;
        out.push({id: item.id, title: item.title, menu: item.menu, group: item.group, from: current[item.id], to: target[item.id]});
    }
    return out;
}

/** A value as a short text for the preview of a change. */
export function describeValue(item: Item | undefined, v: Value | undefined): string {
    if (v === undefined) return '—';
    if (!item) return JSON.stringify(v);
    switch (item.kind) {
    case 'switch': return v ? 'On' : 'Off';
    case 'select': return (item.options ?? []).find(o => String(o.value) === String(v))?.label ?? String(v);
    case 'slider': case 'stepper': return `${v}${item.unit ? ' ' + item.unit : ''}`;
    case 'list': case 'shortcut': return (v as string[]).length ? (v as string[]).join(', ') : 'none';
    case 'shortcuts': return `${(v as string[][]).filter(x => x.length).length} of ${(v as string[][]).length} set`;
    case 'dict': return 'shadow numbers';
    case 'textarea': return (v as string).length > 24 ? `${(v as string).slice(0, 24)}…` : (v as string) || 'empty';
    default: return String(v) || 'empty';
    }
}

/** The menus a partial profile covers (Look, Island…): which of `settings` fall in them. */
export function pick(settings: Settings, menus: string[], catalog: Item[]): Settings {
    const keep = new Set(catalog.filter(i => menus.includes(i.menu)).map(i => i.id));
    return Object.fromEntries(Object.entries(settings).filter(([id]) => keep.has(id)));
}

export function makeProfile(name: string, settings: Settings, opts: {id?: string; description?: string; extends?: string} = {}): Profile {
    const p: Profile = {format: FORMAT, version: VERSION, id: opts.id ?? slugify(name), name: name.trim(), description: opts.description ?? '',
        createdAt: new Date().toISOString(), settings};
    if (opts.extends) p.extends = opts.extends;
    return p;
}

// ---- Dependencies: metadata checks, and what a profile would set that has no effect

/** What is wrong with the dependency metadata of the catalog (empty when it is sound). */
export function validateDependencies(catalog: Item[]): string[] {
    const byId = new Map(catalog.map(i => [i.id, i]));
    const problems: string[] = [];
    for (const item of catalog) {
        const dep = item.depends;
        if (!dep) continue;
        const target = byId.get(dep.id);
        if (!target) { problems.push(`${item.id} depends on ${dep.id}, which does not exist`); continue; }
        if (dep.id === item.id) problems.push(`${item.id} depends on itself`);
        if ((dep.op === 'on' || dep.op === 'off') && target.kind !== 'switch') problems.push(`${item.id}: "${dep.op}" needs a switch, ${dep.id} is a ${target.kind}`);
        if ((dep.op === 'eq' || dep.op === 'ne') && !(target.options ?? []).some(o => String(o.value) === dep.value))
            problems.push(`${item.id}: ${dep.id} has no choice "${dep.value}"`);
        // a cycle: following the chain comes back
        const seen = new Set([item.id]);
        for (let t: Item | undefined = target; t?.depends; t = byId.get(t.depends.id)) {
            if (seen.has(t.id)) { problems.push(`${item.id} is in a dependency cycle through ${t.id}`); break; }
            seen.add(t.id);
        }
    }
    return problems;
}

export interface Note {id: string; title: string; text: string}

/** Changes that would have no effect once applied, because what they depend on stays off: `after` is every setting as it will be. */
export function inactiveNotes(changes: Change[], after: Settings, catalog: Item[]): Note[] {
    const byId = new Map(catalog.map(i => [i.id, i]));
    const notes: Note[] = [];
    for (const c of changes) {
        const item = byId.get(c.id);
        if (!item?.depends || item.depends.unverified || dependencyMet(item, id => after[id])) continue;
        const target = byId.get(item.depends.id);
        const need = {on: 'is on', off: 'is off', eq: `is "${item.depends.value}"`, ne: `is not "${item.depends.value}"`}[item.depends.op];
        notes.push({id: c.id, title: item.title, text: `${item.title} has no effect until "${target?.title ?? item.depends.id}" ${need}`});
    }
    return notes;
}

// ---- Scope: which part of the desktop a change belongs to, so a note about a pending login names the right one
const PART: Record<string, string> = {island: 'Island', dock: 'Dock', blur: 'Blur', corners: 'Corners'};

/** The parts (of those updated on disk but not yet loaded) that the `changes` touch; Look settings touch every part. */
export function stalePartsAffected(changes: Change[], stale: string[], catalog: Item[]): string[] {
    if (!stale.length) return [];
    const byId = new Map(catalog.map(i => [i.id, i]));
    const touched = new Set<string>();
    for (const c of changes) {
        const item = byId.get(c.id);
        if (!item) continue;
        if (item.source === 'niro') (item.key === 'search-shortcut' ? ['Search'] : stale).forEach(p => touched.add(p));
        else if (PART[item.source]) touched.add(PART[item.source]);
    }
    return stale.filter(p => touched.has(p));
}

/** Readable text for JSON that does not parse: where it went wrong. Engines word it differently: SpiderMonkey gives the line
 * and column, V8 gives a position or only a snippet of the text around the bad token (found again in `text`). */
export function describeParseError(message: string, text: string): string {
    const at = (pos: number) => {
        const before = text.slice(0, Math.max(0, pos));
        return `${message.replace(/ in JSON at position \d+.*/s, '').replace(/ of the JSON data$/, '')} (line ${before.split('\n').length}, column ${pos - before.lastIndexOf('\n')})`;
    };
    const lc = /at line (\d+) column (\d+)/.exec(message);
    if (lc) return `${message.replace(/ of the JSON data$/, '')}`;
    const p = /position (\d+)/.exec(message);
    if (p) return at(Number(p[1]));
    const snippet = /^Unexpected token .*?, "?(?:\.\.\.)?(.*?)(?:\.\.\.)?"? is not valid JSON$/s.exec(message);
    if (snippet && snippet[1]) {
        const ctx = snippet[1].replace(/^"/, '').replace(/"$/, '');
        const i = text.indexOf(ctx);
        if (i >= 0) return at(i + ctx.length - 1);
    }
    return message;
}
