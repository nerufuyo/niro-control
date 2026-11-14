// @ts-nocheck: GLib / Gio are untyped here
// The profile engine: captures the registered settings, applies a profile (with a backup first, and a rollback if a write
// fails), keeps profiles, backups and the active profile on disk. No GTK in here: the panel, the command line and the
// tests all use it.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {CATALOG} from './catalog.js';
import {BACKUP_FORMAT, deepEqual, diff, makeProfile, pick, resolve, slugify, uniqueId, validateProfile, VERSION} from './profileLogic.js';
import type {Change, Profile, Settings} from './profileLogic.js';
import {bindingFor} from './store.js';
import type {Stores} from './store.js';
import type {Item} from './types.js';

const BACKUPS_KEPT = 10;
const decoder = new TextDecoder();
const encoder = new TextEncoder();

export interface Backup {file: string; createdAt: string; label: string; count: number}
export interface ApplyResult {
    ok: boolean;
    changed: Change[];
    failed?: {id: string; title: string; error: string};
    rolledBack?: boolean;
    rollbackErrors?: string[];
}

const readJson = (path: string) => {
    const [ok, bytes] = GLib.file_get_contents(path);
    if (!ok) throw new Error(`can't read ${path}`);
    return JSON.parse(decoder.decode(bytes));
};

/** Written whole or not at all: to a temporary file, then renamed over the real one. */
function writeJson(path: string, value: unknown) {
    GLib.mkdir_with_parents(GLib.path_get_dirname(path), 0o755);
    const tmp = `${path}.tmp`;
    GLib.file_set_contents(tmp, encoder.encode(JSON.stringify(value, null, 2) + '\n'));
    GLib.rename(tmp, path);
}

const jsonFiles = (dir: string): string[] => {
    const out = [];
    try {
        const it = Gio.File.new_for_path(dir).enumerate_children('standard::name', 0, null);
        for (let info = it.next_file(null); info; info = it.next_file(null))
            if (info.get_name().endsWith('.json')) out.push(`${dir}/${info.get_name()}`);
    } catch (_e) {
        // no such folder yet
    }
    return out.sort();
};

export class ProfileEngine {
    stores: Stores;
    root: string;
    builtinDir: string;

    constructor(stores: Stores, opts: {root?: string; builtinDir?: string} = {}) {
        this.stores = stores;
        this.root = opts.root ?? GLib.getenv('NIRO_CONFIG_DIR') ?? `${GLib.get_user_config_dir()}/niro-control`;
        this.builtinDir = opts.builtinDir ?? GLib.getenv('NIRO_BUILTIN_DIR') ?? '/usr/share/niro-control/profiles';
        this.bindings = new Map();
    }

    // ---- Settings
    /** The settings a profile is made of: every registered one that has an owner of its own (the ones Look writes are its). */
    get items(): Item[] {
        return CATALOG.filter(i => !i.managed);
    }

    binding(item: Item) {
        if (!this.bindings.has(item.id))
            this.bindings.set(item.id, bindingFor(item, this.stores));
        return this.bindings.get(item.id);
    }

    readItem(item: Item) {
        const b = this.binding(item);
        if (!b) return undefined;
        return Array.isArray(b) ? b.map(x => x.read()) : b.read();
    }

    /** The current value of every setting (or of the `ids` given); settings whose extension is missing are left out. */
    capture(ids?: string[]): Settings {
        const out: Settings = {};
        for (const item of this.items) {
            if (ids && !ids.includes(item.id)) continue;
            try {
                const v = this.readItem(item);
                if (v !== undefined) out[item.id] = v;
            } catch (_e) {
                // unreadable: not part of the capture
            }
        }
        return out;
    }

    writeItem(item: Item, value) {
        const b = this.binding(item);
        if (!b) throw new Error(`${item.title} is not available (its extension is not installed)`);
        if (Array.isArray(b)) b.forEach((one, i) => one.write(item.kind === 'shortcuts' ? value[i] : value[i]));
        else b.write(value);
    }

    // ---- Applying
    preview(target: Settings): Change[] {
        return diff(this.capture(Object.keys(target)), target, this.items);
    }

    /** Writes `target` (only what differs). A failed write puts back what was already written; the report says so. */
    applySettings(target: Settings, backupLabel?: string): ApplyResult {
        const changes = this.preview(target);
        if (!changes.length) return {ok: true, changed: []};
        if (backupLabel) this.backup(backupLabel);
        const byId = new Map(this.items.map(i => [i.id, i]));
        const before = this.capture(changes.map(c => c.id));
        // Look first: the island, dock and windows copy from it, and what a profile sets for them wins afterwards
        const order = [...changes].sort((a, b) => Number(b.id.startsWith('niro.')) - Number(a.id.startsWith('niro.')));
        const done: Change[] = [];
        for (const change of order) {
            try {
                this.writeItem(byId.get(change.id), target[change.id]);
                done.push(change);
            } catch (e) {
                const rollbackErrors = [];
                for (const w of done.reverse()) {
                    try {
                        this.writeItem(byId.get(w.id), before[w.id]);
                    } catch (e2) {
                        rollbackErrors.push(`${w.title}: ${e2.message}`);
                    }
                }
                Gio.Settings.sync();
                return {ok: false, changed: [], failed: {id: change.id, title: change.title, error: e.message}, rolledBack: !rollbackErrors.length, rollbackErrors};
            }
        }
        Gio.Settings.sync();   // dconf writes are queued: a process that ends right after (the command line) must flush them
        return {ok: true, changed: done};
    }

    // ---- Profiles on disk
    get profilesDir() { return `${this.root}/profiles`; }
    get backupsDir() { return `${this.root}/backups`; }
    get statePath() { return `${this.root}/state.json`; }

    private load(dir: string, builtin: boolean): Profile[] {
        const out = [];
        for (const file of jsonFiles(dir)) {
            try {
                const checked = validateProfile(readJson(file), CATALOG);
                if (!checked.ok) continue;
                const p = checked.profile;
                if (builtin) p.builtin = true;
                out.push(p);
            } catch (_e) {
                // a file that is not a profile is not listed
            }
        }
        return out;
    }

    /** Built-in profiles first (the order of their files), then yours by name. */
    list(): Profile[] {
        const builtin = this.load(this.builtinDir, true);
        const ids = new Set(builtin.map(p => p.id));
        const mine = this.load(this.profilesDir, false).filter(p => !ids.has(p.id)).sort((a, b) => a.name.localeCompare(b.name));
        return [...builtin, ...mine];
    }

    get(id: string): Profile | undefined {
        return this.list().find(p => p.id === id);
    }

    settingsOf(profile: Profile): Settings {
        const all = this.list();
        return resolve(profile, id => all.find(p => p.id === id));
    }

    private save(profile: Profile) {
        const {builtin: _b, ...clean} = profile;
        writeJson(`${this.profilesDir}/${profile.id}.json`, clean);
    }

    private guardBuiltin(profile: Profile, what: string) {
        if (profile.builtin) throw new Error(`"${profile.name}" is a built-in profile and can't be ${what}. Duplicate it to make your own.`);
    }

    /** A new profile from the settings now in force (all of them, or those of the `menus` given: a partial profile). */
    create(name: string, opts: {menus?: string[]; description?: string; extends?: string} = {}): Profile {
        if (!name.trim()) throw new Error('Give the profile a name');
        const taken = this.list().map(p => p.id);
        let settings = this.capture();
        if (opts.menus?.length) settings = pick(settings, opts.menus, this.items);
        const p = makeProfile(name, settings, {id: uniqueId(slugify(name), taken), description: opts.description, extends: opts.extends});
        this.save(p);
        return p;
    }

    rename(id: string, name: string) {
        const p = this.get(id);
        if (!p) throw new Error('No such profile');
        this.guardBuiltin(p, 'renamed');
        if (!name.trim()) throw new Error('Give the profile a name');
        p.name = name.trim().slice(0, 60);
        this.save(p);
    }

    duplicate(id: string): Profile {
        const p = this.get(id);
        if (!p) throw new Error('No such profile');
        const name = `${p.name} copy`;
        const copy = makeProfile(name, {...this.settingsOf(p)}, {id: uniqueId(slugify(name), this.list().map(x => x.id)), description: p.description});
        this.save(copy);
        return copy;
    }

    remove(id: string) {
        const p = this.get(id);
        if (!p) throw new Error('No such profile');
        this.guardBuiltin(p, 'deleted');
        Gio.File.new_for_path(`${this.profilesDir}/${id}.json`).delete(null);
        if (this.active() === id) this.setActive(null);
    }

    /** Puts the settings now in force into the profile (the ones it names, or all of them). */
    updateFromCurrent(id: string, menus?: string[]) {
        const p = this.get(id);
        if (!p) throw new Error('No such profile');
        this.guardBuiltin(p, 'changed');
        const ids = menus?.length ? Object.keys(pick(this.capture(), menus, this.items)) : Object.keys(p.settings).length ? Object.keys(p.settings) : undefined;
        p.settings = {...p.settings, ...this.capture(ids)};
        this.save(p);
    }

    // ---- Import and export
    exportTo(id: string, path: string) {
        const p = this.get(id);
        if (!p) throw new Error('No such profile');
        const {builtin: _b, ...clean} = p;
        writeJson(path, {...clean, settings: this.settingsOf(p), extends: undefined});
    }

    importFrom(path: string): {profile: Profile; warnings: string[]} {
        let raw;
        try {
            raw = readJson(path);
        } catch (e) {
            throw new Error(`Can't read the file as a profile: ${e.message}`);
        }
        const checked = validateProfile(raw, CATALOG);
        if (!checked.ok) throw new Error(`Not imported:\n${checked.errors.join('\n')}`);
        const p = checked.profile;
        const taken = this.list().map(x => x.id);
        p.id = uniqueId(p.id, taken);
        delete p.extends;     // an imported profile stands alone: what it extended may not be here
        this.save(p);
        return {profile: p, warnings: checked.warnings};
    }

    // ---- Applying a profile, and which one is active
    apply(id: string): ApplyResult {
        const p = this.get(id);
        if (!p) throw new Error(`No profile "${id}"`);
        const result = this.applySettings(this.settingsOf(p), `Before applying ${p.name}`);
        if (result.ok) this.setActive(id);
        return result;
    }

    active(): string | null {
        try { return readJson(this.statePath).active ?? null; } catch (_e) { return null; }
    }

    setActive(id: string | null) {
        writeJson(this.statePath, {active: id});
    }

    /** What differs between the settings now and the active profile's: empty when they match. */
    modifications(): Change[] {
        const id = this.active();
        const p = id && this.get(id);
        return p ? this.preview(this.settingsOf(p)) : [];
    }

    // ---- Backups
    backup(label = 'Backup'): Backup {
        const now = new Date();
        const stamp = now.toISOString().replace(/[:.]/g, '-');
        const file = `${this.backupsDir}/${stamp}.json`;
        const settings = this.capture();
        writeJson(file, {format: BACKUP_FORMAT, version: VERSION, createdAt: now.toISOString(), label, settings});
        for (const old of jsonFiles(this.backupsDir).slice(0, -BACKUPS_KEPT))
            Gio.File.new_for_path(old).delete(null);
        return {file, createdAt: now.toISOString(), label, count: Object.keys(settings).length};
    }

    backups(): Backup[] {
        const out = [];
        for (const file of jsonFiles(this.backupsDir)) {
            try {
                const b = readJson(file);
                if (b.format === BACKUP_FORMAT) out.push({file, createdAt: b.createdAt, label: b.label, count: Object.keys(b.settings).length});
            } catch (_e) {
                // not a backup
            }
        }
        return out.reverse();
    }

    restore(file: string): ApplyResult {
        const b = readJson(file);
        if (b.format !== BACKUP_FORMAT || b.version > VERSION) throw new Error('Not a backup this version can read');
        const checked = validateProfile({format: 'niro-profile', version: b.version, name: 'backup', settings: b.settings}, CATALOG);
        if (!checked.ok) throw new Error(`The backup is damaged:\n${checked.errors.join('\n')}`);
        const result = this.applySettings(checked.profile.settings, 'Before restoring a backup');
        if (result.ok) this.setActive(null);
        return result;
    }

    deleteBackup(file: string) {
        Gio.File.new_for_path(file).delete(null);
    }
}
