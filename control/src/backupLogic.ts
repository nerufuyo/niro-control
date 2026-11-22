// Backup & Restore (vNext initiative 30), the logic without a screen: what goes into a settings backup, what an import would change, and
// the import itself through transaction.js (write, read back, put back on any failure). Nothing here imports GTK or GLib: settings and
// hashing come in through `env`, so node tests it with fakes. The page (backupPage.ts), the command line (backupCli.ts) and the real
// backend (backupBackend.ts) only call this.
//
// What a backup holds: the GSettings values of the Niro Control schema and of the Niro-managed extensions that are installed (see
// SOURCES). Values are kept as GVariant text next to the schema's own type, so any key type round-trips and an import can be checked
// against the schema before a single write. What it NEVER holds: see EXCLUSIONS (secrets are left out by key name and by value shape,
// and API keys, tokens and passphrase files live outside GSettings and are never read at all).
// @ts-ignore: shell/shared is copied next to the build by `npm run build`
import {BACKUP_VERSION, createBackup, migrateBackup, verifyBackup} from './shared/backup.js';
// @ts-ignore
import {beginTransaction} from './shared/transaction.js';

export const FORMAT = 'niro-settings-backup';
export const SETTINGS_FORMAT = 1;
export const MAX_BYTES = 1024 * 1024;     // a backup file larger than this is refused unread
export const MAX_VALUE = 64 * 1024;       // one value (GVariant text) longer than this is left out / refused
export const MAX_KEYS = 5000;

/** Settings sources in the order they are written; the second item is what the page calls them. Ids match store.ts. */
export const SOURCES: Array<[string, string]> = [
    ['niro', 'Niro Control'], ['island', 'Island'], ['dock', 'Dock'], ['tile', 'Tiling'], ['blur', 'Blur'], ['corners', 'Window corners'], ['emoji', 'Emoji'],
];

/** The exclusion list, in words, for the page and the command line. Keep it true: the tests check the rules below against it. */
export const EXCLUSIONS = [
    'A setting whose name contains token, password, passphrase, secret, api key, credential or private key is never exported, and one found in a file is never imported.',
    'A value that looks like a key (sk-..., ghp_..., xoxb-..., AIza..., a PEM block, a Bearer header) is left out whatever the setting is called.',
    'API keys, tokens and passphrase files (the assistant\'s connections, ~/.config/niro-control) are not read at all: they are not in GSettings.',
    'Not included: window layouts of running windows, clipboard history, shelf contents, recorded files, the Niro Device.',
];

const SECRET_KEY = /(token|password|passphrase|secret|api[_-]?key|credential|private[_-]?key)/i;
const SECRET_VALUE = /(\bsk-[A-Za-z0-9_-]{12,}|\bgh[pousr]_[A-Za-z0-9]{12,}|\bxox[abprs]-[A-Za-z0-9-]{10,}|\bAIza[0-9A-Za-z_-]{20,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|\bBearer\s+[A-Za-z0-9._-]{16,})/;
export const isSecretKey = (key: string) => SECRET_KEY.test(key);
export const looksSecretValue = (text: string) => SECRET_VALUE.test(text);

export interface SettingsIO {
    /** Source ids whose schema is installed here. */
    sources(): string[];
    /** key -> GVariant type string, for the source's schema. */
    keys(source: string): Record<string, string>;
    /** The value as GVariant text. */
    read(source: string, key: string): string;
    /** The canonical text of `text` as a value of that key (type and range checked). Throws when it is not one. */
    canon(source: string, key: string, text: string): string;
    writable(source: string, key: string): boolean;
    write(source: string, key: string, text: string): void;
}
export interface BackupEnv {settings: SettingsIO; hash(text: string): string; now?(): string; appVersion?: string}

export interface ExportResult {ok: boolean; error?: string; text?: string; keys: number; groups: number; excluded: string[]; unsupported: string[]}

const split = (id: string): [string, string] => { const i = id.indexOf('.'); return [id.slice(0, i), id.slice(i + 1)]; };
const msg = (e: any) => String(e?.message ?? e);

/** The backup file's text for the settings now. Reads only. */
export function exportSettings(env: BackupEnv): ExportResult {
    const entries: Array<{path: string; content: string}> = [];
    const excluded: string[] = [], unsupported: string[] = [];
    let keys = 0;
    const installed = env.settings.sources();
    for (const [source] of SOURCES) {
        if (!installed.includes(source)) continue;
        const types = env.settings.keys(source);
        const out: Record<string, {type: string; value: string}> = {};
        for (const key of Object.keys(types).sort()) {
            if (isSecretKey(key)) { excluded.push(`${source}.${key}`); continue; }
            let value: string;
            try { value = env.settings.read(source, key); } catch (_e) { unsupported.push(`${source}.${key}`); continue; }
            if (looksSecretValue(value)) { excluded.push(`${source}.${key}`); continue; }
            if (value.length > MAX_VALUE) { unsupported.push(`${source}.${key}`); continue; }
            out[key] = {type: types[key], value};
            keys++;
        }
        if (Object.keys(out).length) entries.push({path: `settings/${source}.json`, content: JSON.stringify(out, null, 1)});
    }
    if (!entries.length) return {ok: false, error: 'There are no Niro settings to export on this system.', keys: 0, groups: 0, excluded, unsupported};
    const b = createBackup(entries, env.hash, {appVersion: env.appVersion ?? 'unknown', ...(env.now ? {now: env.now} : {})});
    // createBackup strips secret-named string values inside JSON; none can be left here, but if it did, say so instead of hiding it
    for (const s of b.stripped as string[]) excluded.push(s);
    const doc = {format: FORMAT, settingsFormat: SETTINGS_FORMAT, ...b, excluded, unsupported};
    const text = JSON.stringify(doc, null, 1);
    if (text.length > MAX_BYTES) return {ok: false, error: 'The backup would be larger than 1 MB, which this tool refuses.', keys, groups: entries.length, excluded, unsupported};
    return {ok: true, text, keys, groups: entries.length, excluded, unsupported};
}

export interface ParsedBackup {ok: boolean; error?: string; entries?: Record<string, Record<string, {type: string; value: string}>>; createdAt?: string; appVersion?: string}

/** A backup file's text, checked: size, JSON, format, version, checksums. Never touches the settings. */
export function parseBackup(text: string, env: Pick<BackupEnv, 'hash'>): ParsedBackup {
    if (typeof text !== 'string' || text.length === 0) return {ok: false, error: 'The file is empty.'};
    if (text.length > MAX_BYTES) return {ok: false, error: 'The file is larger than 1 MB: it is not a Niro settings backup.'};
    let doc: any;
    try { doc = JSON.parse(text); } catch (_e) { return {ok: false, error: 'The file is not valid JSON.'}; }
    if (!doc || typeof doc !== 'object' || doc.format !== FORMAT) return {ok: false, error: 'This is not a Niro settings backup (wrong or missing format).'};
    if (!Number.isInteger(doc.settingsFormat) || doc.settingsFormat < 1 || doc.settingsFormat > SETTINGS_FORMAT)
        return {ok: false, error: `The backup's settings format (${doc.settingsFormat}) is newer than this program understands (${SETTINGS_FORMAT}). Update Niro and try again.`};
    if (Number.isInteger(doc.version) && doc.version > BACKUP_VERSION) return {ok: false, error: `Backup version ${doc.version} is newer than this program understands. Update Niro and try again.`};
    let b: any;
    try { b = migrateBackup(doc); } catch (e) { return {ok: false, error: msg(e)}; }
    if (b.version > BACKUP_VERSION) return {ok: false, error: `Backup version ${b.version} is newer than this program understands.`};
    const problems: string[] = verifyBackup(b, env.hash);
    if (problems.length) return {ok: false, error: `The backup is damaged: ${problems.slice(0, 3).join('; ')}`};
    const known = SOURCES.map(s => s[0]);
    const entries: Record<string, Record<string, {type: string; value: string}>> = {};
    let total = 0;
    for (const f of b.files) {
        const m = /^settings\/([a-z]+)\.json$/.exec(f.path);
        if (!m || !known.includes(m[1])) return {ok: false, error: `The backup holds a file this program does not know: ${String(f.path).slice(0, 60)}.`};
        if (m[1] in entries) return {ok: false, error: `The backup names ${m[1]} twice.`};
        let data: any;
        try { data = JSON.parse(f.content); } catch (_e) { return {ok: false, error: `${f.path} is not valid JSON.`}; }
        if (!data || typeof data !== 'object' || Array.isArray(data)) return {ok: false, error: `${f.path} is not a list of settings.`};
        for (const [key, v] of Object.entries<any>(data)) {
            if (!v || typeof v !== 'object' || typeof v.type !== 'string' || typeof v.value !== 'string' || Object.keys(v).length !== 2)
                return {ok: false, error: `${m[1]}.${key} is not a setting entry.`};
            if (v.value.length > MAX_VALUE) return {ok: false, error: `${m[1]}.${key} has a value that is too long.`};
            if (++total > MAX_KEYS) return {ok: false, error: `The backup has more than ${MAX_KEYS} settings.`};
        }
        entries[m[1]] = data;
    }
    return {ok: true, entries, createdAt: String(b.createdAt ?? ''), appVersion: String(b.appVersion ?? '')};
}

export interface Change {id: string; source: string; key: string; before: string; after: string}
export interface Plan {
    ok: boolean;
    /** Why the import is refused (unknown key, wrong type, a secret, a locked key). Empty when ok. */
    problems: string[];
    changes: Change[];
    unchanged: number;
    /** Sources in the backup whose extension is not installed here: skipped, not an error. */
    skipped: string[];
    file?: string;
}

/** What importing `entries` would change, per key, and whether it may be imported at all. Nothing is written. */
export function planImport(entries: NonNullable<ParsedBackup['entries']>, env: Pick<BackupEnv, 'settings'>): Plan {
    const problems: string[] = [], changes: Change[] = [], skipped: string[] = [];
    let unchanged = 0;
    const installed = env.settings.sources();
    for (const [source, values] of Object.entries(entries)) {
        if (!installed.includes(source)) { skipped.push(source); continue; }
        const types = env.settings.keys(source);
        for (const [key, entry] of Object.entries(values)) {
            const id = `${source}.${key}`;
            if (isSecretKey(key) || looksSecretValue(entry.value)) { problems.push(`${id}: looks like a secret; secrets are never imported`); continue; }
            if (!(key in types)) { problems.push(`${id}: no such setting here`); continue; }
            if (types[key] !== entry.type) { problems.push(`${id}: wrong type (the backup says ${entry.type}, this system has ${types[key]})`); continue; }
            let after: string;
            try { after = env.settings.canon(source, key, entry.value); } catch (e) { problems.push(`${id}: not a valid value (${msg(e).slice(0, 80)})`); continue; }
            let before: string;
            try { before = env.settings.read(source, key); } catch (e) { problems.push(`${id}: cannot be read (${msg(e).slice(0, 80)})`); continue; }
            if (before === after) { unchanged++; continue; }
            if (!env.settings.writable(source, key)) { problems.push(`${id}: is locked by the system and cannot be changed`); continue; }
            changes.push({id, source, key, before, after});
        }
    }
    return {ok: problems.length === 0, problems, changes, unchanged, skipped};
}

export interface ApplyResult {ok: boolean; written: number; error?: string; rolledBack?: number; restoreFailed?: string[]}

/** Writes a plan through a transaction: every write, then a read-back of each key; on a failed write or a key that did not keep its
 * value, everything already written is put back. */
export function applyPlan(plan: Plan, env: Pick<BackupEnv, 'settings'>): ApplyResult {
    if (!plan.ok) return {ok: false, written: 0, error: 'The backup was refused; nothing was written.'};
    if (!plan.changes.length) return {ok: true, written: 0};
    const ids = plan.changes.map(c => c.id);
    const tx = beginTransaction(Object.fromEntries(plan.changes.map(c => [c.id, c.before])), ids);
    for (const c of plan.changes) tx.set(c.id, c.after);
    const write = (id: string, text: string) => { const [s, k] = split(id); env.settings.write(s, k, text); };
    const r = tx.commit(write);
    if (!r.ok) return {ok: false, written: 0, error: r.error, rolledBack: r.rolledBack};
    const bad: string[] = [];
    for (const c of plan.changes) {
        try { if (env.settings.read(c.source, c.key) !== c.after) bad.push(c.id); } catch (_e) { bad.push(c.id); }
    }
    if (!bad.length) return {ok: true, written: r.written};
    const restoreFailed: string[] = [];
    for (const c of plan.changes) {
        try { write(c.id, c.before); } catch (_e) { restoreFailed.push(c.id); }
    }
    return {ok: false, written: 0, error: `${bad[0]} did not keep the imported value${bad.length > 1 ? ` (and ${bad.length - 1} more)` : ''}`, rolledBack: plan.changes.length - restoreFailed.length, restoreFailed};
}

/** The plan that undoes an applied one. */
export const inversePlan = (plan: Plan): Plan => ({ok: true, problems: [], unchanged: 0, skipped: [], changes: plan.changes.map(c => ({...c, before: c.after, after: c.before}))});

// ---- the controller the page draws (and the command line reuses)

export type BackupView = 'loading' | 'empty' | 'ready' | 'error';
export type BackupBusy = null | 'exporting' | 'reading' | 'applying';
export interface BackupStatus {kind: 'success' | 'rollback' | 'error'; text: string}
export interface BackupFiles {read(path: string): Promise<string> | string; write(path: string, text: string): Promise<void> | void}

export function createBackupFlow(env: BackupEnv, files: BackupFiles) {
    const listeners = new Set<() => void>();
    const s: {view: BackupView; message: string; busy: BackupBusy; status: BackupStatus | null; plan: Plan | null; groups: Array<[string, string]>; applied: Plan | null; lastExport: ExportResult | null} =
        {view: 'loading', message: '', busy: null, status: null, plan: null, groups: [], applied: null, lastExport: null};
    const emit = () => listeners.forEach(f => f());
    const tick = () => Promise.resolve();
    const base = (p: string) => p.split('/').pop() || p;

    async function refresh() {
        s.view = 'loading'; s.message = ''; emit();
        await tick();
        try {
            const installed = env.settings.sources();
            s.groups = SOURCES.filter(x => installed.includes(x[0]));
            s.view = s.groups.length ? 'ready' : 'empty';
        } catch (e) { s.view = 'error'; s.message = msg(e); }
        emit();
    }

    async function exportTo(path: string) {
        if (s.busy) return;
        s.busy = 'exporting'; s.status = null; emit();
        await tick();
        try {
            const r = exportSettings(env);
            if (!r.ok) throw new Error(r.error);
            await files.write(path, r.text!);
            s.lastExport = r;
            s.status = {kind: 'success', text: `Exported ${r.keys} settings from ${r.groups} group${r.groups === 1 ? '' : 's'} to ${base(path)}.${r.excluded.length ? ` ${r.excluded.length} secret-looking setting${r.excluded.length === 1 ? '' : 's'} left out.` : ''}`};
        } catch (e) { s.status = {kind: 'error', text: `Could not export: ${msg(e)}`}; }
        s.busy = null; emit();
    }

    async function loadFile(path: string) {
        if (s.busy) return;
        s.busy = 'reading'; s.status = null; s.plan = null; emit();
        await tick();
        try {
            const text = await files.read(path);
            const p = parseBackup(text, env);
            if (!p.ok) throw new Error(p.error);
            s.plan = {...planImport(p.entries!, env), file: base(path)};
        } catch (e) { s.status = {kind: 'error', text: `Could not read the backup: ${msg(e)}`}; }
        s.busy = null; emit();
    }

    async function apply() {
        if (s.busy || !s.plan) return;
        const plan = s.plan;
        if (!plan.ok || !plan.changes.length) return;
        s.busy = 'applying'; s.status = null; emit();
        await tick();
        const r = applyPlan(plan, env);
        if (r.ok) { s.status = {kind: 'success', text: `Imported: ${r.written} setting${r.written === 1 ? '' : 's'} changed.`}; s.applied = plan; s.plan = null; }
        else {
            s.status = {kind: 'rollback', text: `The import failed (${r.error}). ${r.restoreFailed?.length ? `${r.restoreFailed.length} setting(s) could not be put back: ${r.restoreFailed.slice(0, 3).join(', ')}.` : 'Everything was put back as it was.'}`};
            s.plan = null;
        }
        s.busy = null; emit();
    }

    async function undo() {
        if (s.busy || !s.applied) return;
        s.busy = 'applying'; emit();
        await tick();
        const r = applyPlan(inversePlan(s.applied), env);
        s.status = r.ok ? {kind: 'success', text: 'The import was undone.'} : {kind: 'rollback', text: `Could not undo: ${r.error}.`};
        if (r.ok) s.applied = null;
        s.busy = null; emit();
    }

    function cancel() { if (s.busy) return; s.plan = null; s.status = null; emit(); }
    function dismiss() { s.status = null; emit(); }

    return {
        get state() { return s; },
        subscribe(f: () => void) { listeners.add(f); return () => { listeners.delete(f); }; },
        refresh, exportTo, loadFile, apply, undo, cancel, dismiss,
    };
}

/** A value for display: one line, shortened. */
export const shortValue = (v: string, max = 60) => { const t = v.replace(/\s+/g, ' '); return t.length > max ? `${t.slice(0, max - 1)}…` : t; };
