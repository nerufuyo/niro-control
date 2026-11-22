// Backup & Restore core (vNext S30). Pure: the hash is injected (GLib.Checksum in the shell, node:crypto in tests).
// A backup is a versioned manifest of files; secrets are left out by name and by key, and the backup says what it left out.

export const BACKUP_VERSION = 2;
const SECRET_PATH = /(^|\/)(\.env|.*\.(pem|key|p12)|secrets?(\..*)?|credentials?(\..*)?|id_[a-z0-9]+)$/i;
const SECRET_KEY = /(token|password|passphrase|secret|api[_-]?key|credential)/i;

/** JSON text with secret-looking values replaced; returns {text, removed: [key paths]}. Non-JSON is returned as is. */
export function stripSecrets(text) {
    let data;
    try { data = JSON.parse(text); } catch (_e) { return {text, removed: []}; }
    const removed = [];
    const walk = (v, path) => {
        if (Array.isArray(v))
            return v.map((x, i) => walk(x, `${path}[${i}]`));
        if (v && typeof v === 'object') {
            const o = {};
            for (const [k, x] of Object.entries(v)) {
                if (SECRET_KEY.test(k) && typeof x === 'string' && x !== '') {
                    removed.push(`${path}${path ? '.' : ''}${k}`);
                    continue;
                }
                o[k] = walk(x, `${path}${path ? '.' : ''}${k}`);
            }
            return o;
        }
        return v;
    };
    return {text: JSON.stringify(walk(data, ''), null, 2), removed};
}

/** `entries`: [{path, content}]. Secret files are skipped, secret values stripped. */
export function createBackup(entries, hash, {appVersion = 'unknown', now = () => new Date().toISOString()} = {}) {
    const files = [], skipped = [], stripped = [];
    for (const e of entries) {
        if (typeof e.path !== 'string' || e.path.startsWith('/') || e.path.split('/').includes('..')) {
            skipped.push({path: String(e.path), reason: 'unsafe path'});
            continue;
        }
        if (SECRET_PATH.test(e.path)) {
            skipped.push({path: e.path, reason: 'secret file'});
            continue;
        }
        const s = stripSecrets(e.content);
        s.removed.forEach(k => stripped.push(`${e.path}:${k}`));
        files.push({path: e.path, content: s.text, hash: hash(s.text)});
    }
    return {version: BACKUP_VERSION, appVersion, createdAt: now(), files, skipped, stripped};
}

/** Problems with a backup (empty = intact): wrong version, unsafe path, or a file whose content no longer matches its hash. */
export function verifyBackup(b, hash) {
    if (!b || typeof b !== 'object' || !Array.isArray(b.files))
        return ['not a backup'];
    if (!Number.isInteger(b.version) || b.version > BACKUP_VERSION)
        return [`backup version ${b.version} is newer than this program understands`];
    const p = [];
    for (const f of b.files) {
        if (typeof f.path !== 'string' || f.path.startsWith('/') || f.path.split('/').includes('..'))
            p.push(`unsafe path ${f.path}`);
        else if (hash(f.content) !== f.hash)
            p.push(`${f.path}: content does not match its checksum`);
    }
    return p;
}

/** v1 backups had no `skipped` / `stripped` lists. */
export function migrateBackup(b) {
    if (!b || !Array.isArray(b.files))
        throw new Error('not a backup');
    if (b.version === BACKUP_VERSION)
        return b;
    if (b.version === 1)
        return {...b, version: BACKUP_VERSION, skipped: [], stripped: []};
    throw new Error(`cannot migrate backup version ${b.version}`);
}

/** What a restore would do to `current` ({path: content}): nothing is written here. */
export function restorePreview(b, current) {
    const out = {add: [], change: [], same: []};
    for (const f of b.files)
        (f.path in current ? (current[f.path] === f.content ? out.same : out.change) : out.add).push(f.path);
    return out;
}
