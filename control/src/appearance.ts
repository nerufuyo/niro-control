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
    const fade = !o.safeMode && r?.mode === 'fade' && o.thirdParty ? (r.opacity ?? 80) : null;
    return {blur, fade, excluded: false};
}

// ---- Compatibility matrix: what is known about each family, and how it is known
export type Status = 'native' | 'theme' | 'compositor' | 'limited' | 'unsupported';
export type Evidence = 'tested' | 'partly tested' | 'documented, not tested here';
export type Applies = 'live' | 'restart' | 'login';
export interface Family {
    id: string; name: string; match: RegExp; status: Status; how: string; limit: string; evidence: Evidence;
    /** When a change reaches the application: while it runs, after it restarts, or after a new login (shell code) */
    applies: Applies;
    /** What can be set for it, only what actually takes effect */
    customizations: string[];
}
export const APPLIES_LABEL: Record<Applies, string> = {live: 'Applied live', restart: 'Application restart required', login: 'Requires new login'};
export const STATUS_LABEL: Record<Status, string> = {native: 'Native integration', theme: 'Theme integration', compositor: 'Compositor effects only', limited: 'Limited support', unsupported: 'Unsupported'};

export const FAMILIES: Family[] = [
    {id: 'niro', name: 'Niro Control', match: /^org\.niro\./i, status: 'native', evidence: 'tested',
        how: 'Paints its own three layers from the shared Look', limit: 'None known', applies: 'live', customizations: ['Exclude from effects']},
    {id: 'gtk4', name: 'GNOME apps (GTK 4, libadwaita)', match: /^org\.gnome\.(Nautilus|TextEditor|Settings|Calculator|Characters|Loupe|Papers|Evince|Snapshot|Totem|clocks|Maps|Weather|Contacts|Logs)/i, status: 'theme', evidence: 'partly tested',
        how: 'The GTK theme integration styles their window, sidebar and content backgrounds; their text colours are left to the app', limit: 'Needs the GTK theme integration installed from Compatibility; apps restart to pick it up; applications with their own opaque backgrounds stay opaque', applies: 'restart', customizations: ['Exclude from compositor effects', 'Window fade (Advanced)']},
    {id: 'gtk3', name: 'GTK 3 apps', match: /^(org\.gnome\.Terminal|gnome-terminal|org\.gnome\.gedit|org\.gnome\.Software|org\.gnome\.Extensions|gimp|org\.gimp)/i, status: 'limited', evidence: 'documented, not tested here',
        how: 'The GTK 3 stylesheet of the integration (backgrounds only)', limit: 'GNOME Terminal has its own transparency setting in its profile; GTK 3 themes in ~/.config/gtk-3.0 are applied before ours', applies: 'restart', customizations: ['Exclude from compositor effects', 'Window fade (Advanced)']},
    {id: 'chrome', name: 'Chrome / Chromium', match: /(google-chrome|chromium|chrome)/i, status: 'compositor', evidence: 'documented, not tested here',
        how: 'Blur behind the window and rounded corners by the shell', limit: 'The page and the toolbar are opaque: only a window-level fade is possible, and it fades the text too (off unless you set it)', applies: 'live', customizations: ['Exclude from effects', 'Blur off', 'Window fade (Advanced)']},
    {id: 'firefox', name: 'Firefox', match: /firefox/i, status: 'compositor', evidence: 'documented, not tested here',
        how: 'Blur behind the window and rounded corners by the shell', limit: 'Firefox draws opaque content; styling it needs a user profile stylesheet, which Niro does not write', applies: 'live', customizations: ['Exclude from effects', 'Blur off', 'Window fade (Advanced)']},
    {id: 'electron', name: 'Electron (VS Code and others)', match: /(^code$|visual-studio-code|electron|slack|discord|obsidian|spotify)/i, status: 'compositor', evidence: 'documented, not tested here',
        how: 'Blur behind the window and rounded corners by the shell', limit: 'Opaque content; a window-level fade also fades text and is off unless you set it per application', applies: 'live', customizations: ['Exclude from effects', 'Blur off', 'Window fade (Advanced)']},
    {id: 'qt', name: 'Qt 5 / Qt 6 apps', match: /^org\.kde\.|^(vlc|qbittorrent|telegram|obs)/i, status: 'unsupported', evidence: 'documented, not tested here',
        how: 'Would need a Qt platform theme (qt5ct, Kvantum) that is not installed here', limit: 'No Qt integration is installed or written by Niro; blur and rounded corners by the shell only if the window is see-through', applies: 'live', customizations: ['Exclude from effects', 'Window fade (Advanced)']},
];
/** What an application that matches no family gets: honest about not knowing. */
export const UNKNOWN: Family = {id: 'unknown', name: 'Toolkit not identified', match: /$^/, status: 'limited', evidence: 'documented, not tested here', applies: 'live',
    how: 'Blur behind the window by the shell, when the window is see-through', limit: 'Its content cannot be restyled from outside: whatever it paints stays as it is', customizations: ['Exclude from effects', 'Blur off', 'Window fade (Advanced)']};
export function classify(appId: string, execLine = ''): Family | null {
    const hay = `${appId} ${execLine}`;
    return FAMILIES.find(f => f.match.test(appId) || (f.id !== 'gtk4' && f.id !== 'gtk3' && f.id !== 'niro' && f.match.test(hay))) ?? null;
}

// ---- Legacy whole-window fade: migration, never destruction
export interface LegacyState {
    /** the blur extension's applications opacity, 0 to 255 */ appsOpacity: number;
    /** the value kept from before, -1 for none */ saved: number;
    /** the legacy-global-fade switch */ legacyFade: boolean;
}
/**
 * What to write so that no window is faded by default and the old value is never lost: the first time a fade (< 255) is found it is
 * saved; the extension setting goes to 255 unless the user turned the old fade back on, which writes the saved value back.
 * Idempotent: running it again changes nothing.
 */
export function migrateLegacy(s: LegacyState): LegacyState {
    let saved = s.saved;
    if (saved < 0 && s.appsOpacity >= 0 && s.appsOpacity < 255) saved = s.appsOpacity;
    const appsOpacity = s.legacyFade && saved >= 0 ? saved : 255;
    return {appsOpacity, saved, legacyFade: s.legacyFade};
}

// ---- The colour scheme: Niro's own choice, else GNOME's
export type SchemeChoice = 'system' | 'dark' | 'light';
/** `system` is org.gnome.desktop.interface color-scheme: "prefer-dark", "prefer-light" or "default" (which GNOME treats as light). */
export function resolveScheme(choice: string, system: string): 'dark' | 'light' {
    if (choice === 'dark' || choice === 'light') return choice;
    return system === 'prefer-dark' ? 'dark' : 'light';
}

// ---- Rules in profiles
export function rulesCount(json: string): number { return Object.keys(parseRules(json)).length; }
/** null when the text is a sound rules object with nothing dropped, else the reason. */
export function validateRulesText(json: unknown): string | null {
    if (typeof json !== 'string') return 'must be text';
    let raw: unknown;
    try { raw = JSON.parse(json || '{}'); } catch (_e) { return 'is not valid JSON'; }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return 'must be a JSON object keyed by application id';
    const kept = Object.keys(parseRules(json)).length, given = Object.keys(raw as object).length;
    return kept === given ? null : `${given - kept} of ${given} rules are not valid (an id of letters, digits . _ - @ +, and a mode of inherit, exclude or fade)`;
}
/** Exclusions the user has now that applying `next` would remove: what a profile must not drop silently. */
export function exclusionsDropped(current: string, next: string): string[] {
    const now = parseRules(current), after = parseRules(next);
    return Object.entries(now).filter(([id, r]) => r.mode === 'exclude' && after[id]?.mode !== 'exclude').map(([id]) => id).sort();
}

/**
 * GTK 3 does not follow GNOME's colour scheme: its look is the theme's. A theme whose name says dark (Yaru-olive-dark, Adwaita-dark)
 * or an application asking for the dark variant gives dark; anything else is taken as light. This is a heuristic about names, which
 * is why the GTK 3 stylesheet also sets the text colour on the surfaces it paints.
 */
export function gtk3Scheme(themeName: string, preferDark = false): 'dark' | 'light' {
    return preferDark || /dark/i.test(themeName ?? '') ? 'dark' : 'light';
}
