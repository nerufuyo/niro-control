// Plugin SDK (vNext initiative 28), validation only: check a plugin manifest and say what it asks for. The manifest is DATA. Nothing
// here loads, imports, evaluates or runs plugin code (there is no plugin host; that waits for a design review), and the entryPoint is only
// checked as a string. No GTK or GLib here, so node tests it.
// @ts-ignore: shell/shared is copied next to the build by `npm run build`
import {HOST_API, RISKY, validateManifest} from './shared/pluginManifest.js';

export const MAX_MANIFEST_BYTES = 64 * 1024;

export interface PermissionLine {capability: string; risky: boolean; reason: string}
export interface PluginReport {
    ok: boolean;
    problems: string[];
    id: string | null;
    name: string | null;
    version: string | null;
    apiVersion: string | null;
    hostApi: string;
    entryPoint: string | null;
    /** What the plugin asks for; a capability may be used only after the user grants it (nothing is granted by this check). */
    permissions: PermissionLine[];
    dependencies: string[];
}

/** `text` is the manifest's JSON. Never throws. */
export function checkManifestText(text: string): PluginReport {
    const hostApi = `${HOST_API.major}.${HOST_API.minor}`;
    const empty = {id: null, name: null, version: null, apiVersion: null, hostApi, entryPoint: null, permissions: [], dependencies: []};
    if (typeof text !== 'string' || text.trim() === '') return {ok: false, problems: ['the manifest is empty'], ...empty};
    if (text.length > MAX_MANIFEST_BYTES) return {ok: false, problems: [`the manifest is larger than ${MAX_MANIFEST_BYTES / 1024} KB`], ...empty};
    let m: any;
    try { m = JSON.parse(text); } catch (e: any) { return {ok: false, problems: [`not valid JSON: ${String(e?.message ?? e).slice(0, 100)}`], ...empty}; }
    const v = validateManifest(m);
    const asText = (x: unknown, n = 80) => (typeof x === 'string' ? x.slice(0, n) : null);
    const caps: string[] = Array.isArray(m?.capabilities) ? m.capabilities.filter((c: unknown) => typeof c === 'string') : [];
    const reasons = new Map<string, string>();
    for (const p of Array.isArray(m?.permissions) ? m.permissions : []) if (p && typeof p.capability === 'string' && typeof p.reason === 'string') reasons.set(p.capability, p.reason.slice(0, 200));
    return {
        ok: v.ok, problems: v.errors,
        id: asText(m?.id), name: asText(m?.name, 60), version: asText(m?.version, 40), apiVersion: asText(m?.apiVersion, 10), hostApi,
        entryPoint: asText(m?.entryPoint, 200),
        permissions: caps.map(c => ({capability: c, risky: RISKY.includes(c), reason: reasons.get(c) ?? ''})),
        dependencies: m?.dependencies && typeof m.dependencies === 'object' && !Array.isArray(m.dependencies) ? Object.entries(m.dependencies).map(([k, r]) => `${k} ${r}`) : [],
    };
}

/** The report as lines of text for a terminal. */
export function formatReport(r: PluginReport, source: string): string[] {
    const out = [`${r.ok ? 'valid' : 'INVALID'}: ${source}`];
    if (r.id) out.push(`  ${r.name ?? r.id} (${r.id}) ${r.version ?? ''}, API ${r.apiVersion ?? '?'} (this host: ${r.hostApi})`);
    for (const p of r.problems) out.push(`  problem: ${p}`);
    if (r.permissions.length) {
        out.push('  asks for:');
        for (const p of r.permissions) out.push(`    ${p.capability}${p.risky ? ' (sensitive)' : ''}${p.reason ? `: ${p.reason}` : ''}`);
    } else if (r.ok) out.push('  asks for no capability');
    if (r.dependencies.length) out.push(`  depends on: ${r.dependencies.join(', ')}`);
    if (r.ok) out.push('  Nothing was loaded or run. Niro has no plugin host yet, so this plugin cannot be installed or started.');
    return out;
}
