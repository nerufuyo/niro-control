// Plugin manifest core (vNext initiative 28). Pure and declarative: this validates a description of a plugin and answers
// "may it do X?". No plugin code is ever loaded, imported or evaluated here; entryPoint is only checked as a string, and loading
// (in an isolated host, after design review) is out of scope.

import {CAPABILITIES} from './permissions.js';

export const HOST_API = {major: 1, minor: 0};
export const RISKY = ['file', 'network', 'device', 'automation', 'ai-external', 'clipboard'];
const KEYS = ['id', 'name', 'version', 'apiVersion', 'capabilities', 'permissions', 'entryPoint', 'dependencies'];
const ID_RE = /^[a-z][a-z0-9]*(\.[a-z0-9-]+)+$/;
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/;
const RANGE = /^[\^~]?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

/** A safe relative path: no absolute path, no "..", no "." segments, no backslash, no NUL, no scheme, a script extension. */
export function safeRelativePath(p) {
    if (typeof p !== 'string' || p === '' || p.length > 200)
        return false;
    if (p.startsWith('/') || p.startsWith('~') || p.includes('\\') || p.includes('\0') || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(p))
        return false;
    if (/%2e|%2f|%5c/i.test(p))
        return false;
    const segs = p.split('/');
    return segs.every(s => s !== '' && s !== '.' && s !== '..' && !s.includes('..'));
}

export function parseApiVersion(v) {
    const m = typeof v === 'string' ? v.match(/^(\d{1,4})\.(\d{1,4})$/) : null;
    return m ? {major: Number(m[1]), minor: Number(m[2])} : null;
}

/** Same major, and the plugin does not ask for a newer minor than the host offers. */
export function isCompatible(apiVersion, host = HOST_API) {
    const v = parseApiVersion(apiVersion);
    return Boolean(v) && v.major === host.major && v.minor <= host.minor;
}

/** {ok, errors[]}. Unknown keys, unknown capabilities and risky capabilities without a stated reason are all refused. */
export function validateManifest(m, {host = HOST_API} = {}) {
    const errors = [];
    if (m === null || typeof m !== 'object' || Array.isArray(m))
        return {ok: false, errors: ['manifest must be an object']};
    for (const k of Object.keys(m))
        if (!KEYS.includes(k))
            errors.push(`unknown key "${k}"`);
    if (typeof m.id !== 'string' || !ID_RE.test(m.id) || m.id.length > 80)
        errors.push('id must look like "com.example.name"');
    if (typeof m.name !== 'string' || m.name.trim() === '' || m.name.length > 60)
        errors.push('name must be 1 to 60 characters');
    if (typeof m.version !== 'string' || !SEMVER.test(m.version))
        errors.push('version must be semver (1.2.3)');
    if (!parseApiVersion(m.apiVersion))
        errors.push('apiVersion must look like "1.0"');
    else if (!isCompatible(m.apiVersion, host))
        errors.push(`apiVersion ${m.apiVersion} is not compatible with host API ${host.major}.${host.minor}`);
    const caps = Array.isArray(m.capabilities) ? m.capabilities : null;
    if (!caps || caps.length > CAPABILITIES.length)
        errors.push('capabilities must be a list');
    else {
        for (const c of caps)
            if (!CAPABILITIES.includes(c))
                errors.push(`unknown capability "${c}"`);
        if (new Set(caps).size !== caps.length)
            errors.push('capabilities must not repeat');
    }
    const perms = Array.isArray(m.permissions) ? m.permissions : (m.permissions === undefined ? [] : null);
    if (!perms)
        errors.push('permissions must be a list');
    else {
        for (const p of perms) {
            if (!p || typeof p.capability !== 'string' || !CAPABILITIES.includes(p.capability))
                errors.push(`permission names an unknown capability "${p?.capability}"`);
            else if (caps && !caps.includes(p.capability))
                errors.push(`permission "${p.capability}" is not among the capabilities`);
            if (!p || typeof p.reason !== 'string' || p.reason.trim() === '' || p.reason.length > 200)
                errors.push('every permission needs a reason (up to 200 characters)');
        }
        for (const c of caps ?? [])
            if (RISKY.includes(c) && !perms.some(p => p?.capability === c))
                errors.push(`capability "${c}" needs a permission entry with a reason`);
    }
    if (!safeRelativePath(m.entryPoint) || !/\.(m?js|wasm)$/.test(String(m.entryPoint)))
        errors.push('entryPoint must be a relative .js/.mjs/.wasm path without ".." or a scheme');
    const deps = m.dependencies ?? {};
    if (deps === null || typeof deps !== 'object' || Array.isArray(deps) || Object.keys(deps).length > 10)
        errors.push('dependencies must be an object of at most 10 entries');
    else
        for (const [id, range] of Object.entries(deps)) {
            if (!ID_RE.test(id))
                errors.push(`dependency id "${id}" is invalid`);
            if (id === m.id)
                errors.push('a plugin cannot depend on itself');
            if (typeof range !== 'string' || !RANGE.test(range))
                errors.push(`dependency "${id}" needs a version like 1.2.3, ^1.2.3 or ~1.2.3`);
        }
    return {ok: errors.length === 0, errors};
}

/** {allowed, reason}. A capability must be declared in the manifest; a declared one still needs a grant. `permissions` is a
 * createPermissions() store; subject is `plugin:<id>`. Without a store the answer for a declared capability is 'ask'. */
export function authorize(manifest, capability, permissions = null) {
    if (!validateManifest(manifest).ok)
        return {allowed: false, verdict: 'deny', reason: 'invalid manifest'};
    if (!CAPABILITIES.includes(capability))
        return {allowed: false, verdict: 'deny', reason: `unknown capability "${capability}"`};
    if (!manifest.capabilities.includes(capability))
        return {allowed: false, verdict: 'deny', reason: `capability "${capability}" was not declared`};
    if (!permissions)
        return {allowed: false, verdict: 'ask', reason: 'no grant yet'};
    const verdict = permissions.decide(`plugin:${manifest.id}`, capability);
    return {allowed: verdict === 'allow', verdict, reason: verdict === 'allow' ? 'granted' : verdict === 'deny' ? 'denied by the user' : 'needs the user to decide'};
}

/** What removing a plugin deletes. `owned` may add {settings: [], files: [], schedules: []}; files must stay inside the plugin's
 * own data folder, anything else is listed under `refused` and never deleted. */
export function uninstallPlan(manifest, owned = {}) {
    const root = `plugins/${manifest.id}`;
    const files = [`${root}/`];
    const refused = [];
    for (const f of owned.files ?? [])
        if (safeRelativePath(f)) files.push(`${root}/${f}`); else refused.push(String(f));
    const settings = [];
    for (const k of owned.settings ?? [])
        if (typeof k === 'string' && k.startsWith(`plugin.${manifest.id}.`)) settings.push(k); else refused.push(String(k));
    return {
        id: manifest.id,
        files,
        settings,
        schedules: (owned.schedules ?? []).filter(s => typeof s === 'string').slice(0, 50),
        grants: manifest.capabilities.map(c => ({subject: `plugin:${manifest.id}`, capability: c})),
        refused,
    };
}
