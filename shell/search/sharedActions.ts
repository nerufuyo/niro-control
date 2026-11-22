// @ts-nocheck: the shared cores are plain JS copied into build/shared by the build
// Typed actions over the shared cores (text tools, URL cleaning, clipboard check, extension check). Pure: no GNOME imports, so node
// tests them; the shell passes in what it can see (`extensions()`, `shellMajor()`). None of them touches the clipboard or any extension.
import {CASES, convertCase, removeFormatting, formatJson, cleanUrl, sensitiveKind} from './shared/clipboardTools.js';
import {analyze} from './shared/extensionConflicts.js';

export const TEXT_KINDS = [...CASES, 'json', 'plain'];

export function transformText(text: string, kind: string): string {
    if (kind === 'json') {
        const r = formatJson(text);
        if (r.error) throw new Error(`not valid JSON: ${r.error}`);
        return r.text;
    }
    if (kind === 'plain') return removeFormatting(text);
    return convertCase(text, kind);
}

export function extensionReport(installed: {uuid: string; enabled: boolean; shellVersions?: string[]}[], shell: number): string {
    const {conflicts, incompatible} = analyze(installed, shell);
    const lines = [`${installed.filter(e => e.enabled).length} of ${installed.length} extensions enabled on GNOME Shell ${shell}`];
    for (const c of conflicts) lines.push(`Conflict (${c.confidence}): ${c.ours.join(', ')} with ${c.theirs.join(', ')}. ${c.reason}`);
    for (const i of incompatible) lines.push(`Not made for this Shell: ${i.uuid} (${i.shellVersions.join(', ')})`);
    if (!conflicts.length && !incompatible.length) lines.push('No known conflicts');
    return lines.join('\n');
}

export function registerSharedActions(r, env: {extensions: () => any[]; shellMajor: () => number}) {
    r.register({id: 'text.transform', title: 'Transform text', description: 'Changes the case of text, formats JSON or strips formatting; shows the result and leaves the clipboard alone', category: 'Tools', keywords: ['case', 'upper', 'lower', 'snake', 'camel', 'kebab', 'json', 'plain'],
        params: [{name: 'text', type: 'string', required: true, maxLength: 20000}, {name: 'kind', type: 'enum', required: true, enum: TEXT_KINDS}], permission: 'none',
        run: async ({text, kind}) => transformText(text, kind)});
    r.register({id: 'url.clean', title: 'Clean a link', description: 'Removes tracking parameters from a web address', category: 'Tools', keywords: ['url', 'link', 'tracking', 'utm'],
        params: [{name: 'url', type: 'string', required: true, maxLength: 4000}], permission: 'none',
        run: async ({url}) => cleanUrl(url)});
    r.register({id: 'clipboard.sensitive.check', title: 'Check text for secrets', description: 'Says whether text looks like a password, key or card number; never repeats the text', category: 'Tools', keywords: ['secret', 'password', 'sensitive', 'clipboard'],
        params: [{name: 'text', type: 'string', required: true, maxLength: 20000}], permission: 'none',
        run: async ({text}) => { const k = sensitiveKind(text); return k ? `Looks sensitive (${k})` : 'Looks fine'; }});
    r.register({id: 'extensions.check', title: 'Check extensions', description: 'Lists extension conflicts and extensions made for another Shell version; changes nothing', category: 'System', keywords: ['extensions', 'conflict', 'compatibility'], permission: 'none',
        run: async () => extensionReport(env.extensions(), env.shellMajor())});
    return r;
}
