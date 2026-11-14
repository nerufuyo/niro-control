// Universal Appearance: the presets, what the settings come to once safety rules are applied, per-application rules, and the
// compatibility matrix. Pure (no GTK), so tests can check it. The shared settings live in org.niro.control.

export type PresetName = 'balanced' | 'crystal' | 'solid' | 'performance';
export interface Values {
    opacity: number; blur: boolean; 'blur-strength': number;
    'sidebar-opacity': number; 'content-opacity': number; 'elevated-opacity': number; 'performance-mode': boolean;
}

export const PRESETS: Record<PresetName, Values> = {
    balanced: {opacity: 80, blur: true, 'blur-strength': 30, 'sidebar-opacity': 70, 'content-opacity': 85, 'elevated-opacity': 92, 'performance-mode': false},
    crystal: {opacity: 55, blur: true, 'blur-strength': 60, 'sidebar-opacity': 64, 'content-opacity': 80, 'elevated-opacity': 90, 'performance-mode': false},
    solid: {opacity: 100, blur: false, 'blur-strength': 0, 'sidebar-opacity': 100, 'content-opacity': 100, 'elevated-opacity': 100, 'performance-mode': false},
    performance: {opacity: 90, blur: false, 'blur-strength': 10, 'sidebar-opacity': 85, 'content-opacity': 92, 'elevated-opacity': 96, 'performance-mode': true},
};
export const PRESET_KEYS = Object.keys(PRESETS.balanced) as (keyof Values)[];

/** The preset whose values these are, or "custom". */
export function detectPreset(v: Partial<Values>): PresetName | 'custom' {
    for (const [name, p] of Object.entries(PRESETS)) if (PRESET_KEYS.every(k => v[k] === p[k])) return name as PresetName;
    return 'custom';
}

// Readability floors: below these, text over a bright wallpaper stops reaching WCAG AA. The schema ranges start at the same values.
export const FLOORS = {sidebar: 62, content: 70, elevated: 80};

export interface Safety {safeMode: boolean; highContrast: boolean}
export interface Effective {
    glass: number; blur: boolean; blurStrength: number; sidebar: number; content: number; elevated: number;
    /** Why the values differ from what was set, for a status line; empty when they do not */
    reasons: string[];
}

/** What the settings come to: safe mode and high contrast make everything solid; performance mode drops the blur and firms up surfaces. */
export function effective(v: Values, safety: Safety): Effective {
    const reasons: string[] = [];
    const clamp = (n: number, lo: number, hi = 100) => Math.min(hi, Math.max(lo, Number.isFinite(n) ? n : lo));
    let e: Effective = {glass: clamp(v.opacity, 0), blur: v.blur, blurStrength: clamp(v['blur-strength'], 0), sidebar: clamp(v['sidebar-opacity'], FLOORS.sidebar),
        content: clamp(v['content-opacity'], FLOORS.content), elevated: clamp(v['elevated-opacity'], FLOORS.elevated), reasons};
    if (v['performance-mode']) { e = {...e, blur: false, content: Math.max(e.content, 90), elevated: Math.max(e.elevated, 94), sidebar: Math.max(e.sidebar, 80)}; reasons.push('performance mode: no blur'); }
    if (safety.highContrast) { e = {...e, glass: 100, blur: false, sidebar: 100, content: 100, elevated: 100}; reasons.push('high contrast: solid surfaces'); }
    if (safety.safeMode) { e = {...e, glass: 100, blur: false, sidebar: 100, content: 100, elevated: 100}; reasons.push('safe mode: solid surfaces, no effects'); }
    return e;
}

// ---- Per-application rules, keyed by application id (the window class / desktop id), never by title
export type RuleMode = 'inherit' | 'exclude' | 'fade';
export interface Rule {mode: RuleMode; /** whole-window opacity for mode "fade", 20 to 100 */ opacity?: number; blur?: boolean}
export type Rules = Record<string, Rule>;

/** Reads the stored JSON; whatever is not a valid rule is dropped, so a hand-edited value can never break the shell. */
export function parseRules(json: string): Rules {
    let raw: unknown;
    try { raw = JSON.parse(json || '{}'); } catch (_e) { return {}; }
    const out: Rules = {};
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
    for (const [id, r] of Object.entries(raw as Record<string, any>)) {
        if (!/^[\w.@+-]{1,120}$/.test(id) || !r || typeof r !== 'object') continue;
        if (!['inherit', 'exclude', 'fade'].includes(r.mode)) continue;
        const rule: Rule = {mode: r.mode};
        if (r.mode === 'fade') rule.opacity = Math.min(100, Math.max(20, Math.round(Number(r.opacity ?? 80)) || 80));
        if (typeof r.blur === 'boolean') rule.blur = r.blur;
        out[id] = rule;
    }
    return out;
}
export const serializeRules = (rules: Rules) => JSON.stringify(rules);
export function setRule(rules: Rules, id: string, rule: Rule | null): Rules {
    const next = {...rules};
    if (!rule || (rule.mode === 'inherit' && rule.blur === undefined)) delete next[id]; else next[id] = rule;
    return parseRules(serializeRules(next));
}

/** What the compositor does to a window: no fade unless the rule asks for one, and only when window-level effects are allowed. */
export function windowEffect(appId: string, rules: Rules, o: {universal: boolean; safeMode: boolean; thirdParty: boolean; blurOn: boolean}): {blur: boolean; fade: number | null; excluded: boolean} {
    const r = rules[appId];
    if (!o.universal || r?.mode === 'exclude') return {blur: false, fade: null, excluded: true};
    const blur = !o.safeMode && o.blurOn && r?.blur !== false;
    const fade = !o.safeMode && r?.mode === 'fade' && (o.thirdParty || r.opacity !== undefined) ? (r.opacity ?? 80) : null;
    return {blur, fade, excluded: false};
}

// ---- Compatibility matrix: what is known about each family, and how it is known
export type Status = 'native' | 'theme' | 'compositor' | 'limited' | 'unsupported';
export type Evidence = 'tested' | 'partly tested' | 'documented, not tested here';
export interface Family {
    id: string; name: string; match: RegExp; status: Status; how: string; limit: string; evidence: Evidence;
}
export const STATUS_LABEL: Record<Status, string> = {native: 'Native integration', theme: 'Theme integration', compositor: 'Compositor effects only', limited: 'Limited support', unsupported: 'Unsupported'};

export const FAMILIES: Family[] = [
    {id: 'niro', name: 'Niro Control', match: /^org\.niro\./i, status: 'native', evidence: 'tested',
        how: 'Paints its own three layers from the shared Look', limit: 'None known'},
    {id: 'gtk4', name: 'GNOME apps (GTK 4, libadwaita)', match: /^org\.gnome\.(Nautilus|TextEditor|Settings|Calculator|Characters|Loupe|Papers|Evince|Snapshot|Totem|clocks|Maps|Weather|Contacts|Logs)/i, status: 'theme', evidence: 'partly tested',
        how: 'The GTK theme integration styles their window, sidebar and content backgrounds; their text colours are left to the app', limit: 'Needs the GTK theme integration installed from Compatibility; apps restart to pick it up; applications with their own opaque backgrounds stay opaque'},
    {id: 'gtk3', name: 'GTK 3 apps', match: /^(org\.gnome\.Terminal|gnome-terminal|org\.gnome\.gedit|org\.gnome\.Software|org\.gnome\.Extensions|gimp|org\.gimp)/i, status: 'limited', evidence: 'documented, not tested here',
        how: 'The GTK 3 stylesheet of the integration (backgrounds only)', limit: 'GNOME Terminal has its own transparency setting in its profile; GTK 3 themes in ~/.config/gtk-3.0 are applied before ours'},
    {id: 'chrome', name: 'Chrome / Chromium', match: /(google-chrome|chromium|chrome)/i, status: 'compositor', evidence: 'documented, not tested here',
        how: 'Blur behind the window and rounded corners by the shell', limit: 'The page and the toolbar are opaque: only a window-level fade is possible, and it fades the text too (off unless you set it)'},
    {id: 'firefox', name: 'Firefox', match: /firefox/i, status: 'compositor', evidence: 'documented, not tested here',
        how: 'Blur behind the window and rounded corners by the shell', limit: 'Firefox draws opaque content; styling it needs a user profile stylesheet, which Niro does not write'},
    {id: 'electron', name: 'Electron (VS Code and others)', match: /(^code$|visual-studio-code|electron|slack|discord|obsidian|spotify)/i, status: 'compositor', evidence: 'documented, not tested here',
        how: 'Blur behind the window and rounded corners by the shell', limit: 'Opaque content; a window-level fade also fades text and is off unless you set it per application'},
    {id: 'qt', name: 'Qt 5 / Qt 6 apps', match: /^org\.kde\.|^(vlc|qbittorrent|telegram|obs)/i, status: 'unsupported', evidence: 'documented, not tested here',
        how: 'Would need a Qt platform theme (qt5ct, Kvantum) that is not installed here', limit: 'No Qt integration is installed or written by Niro; blur and rounded corners by the shell only if the window is see-through'},
];
export function classify(appId: string, execLine = ''): Family | null {
    const hay = `${appId} ${execLine}`;
    return FAMILIES.find(f => f.match.test(appId) || (f.id !== 'gtk4' && f.id !== 'gtk3' && f.id !== 'niro' && f.match.test(hay))) ?? null;
}
