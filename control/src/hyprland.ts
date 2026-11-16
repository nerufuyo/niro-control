// Hyprland settings the panel manages: pure logic (what the settings are, the file they are written to, the line that makes
// hyprland.conf read it). Nothing here touches the disk or Hyprland; `hyprlandPage.ts` does, so the rules can be tested.
//
// The panel never edits hyprland.conf beyond one marked line. Its settings live in their own file, `niro.conf`, which holds
// only what was changed (a setting that was never touched, or was reset, is not in the file and stays as the user's
// config or Hyprland's default has it).

export type Value = boolean | number | string;
export type Kind = 'switch' | 'int' | 'float' | 'select';

export interface Def {
    /** Hyprland's option, as `hyprctl keyword` and the config file name it: `decoration:blur:size`. */
    key: string;
    group: string;
    title: string;
    subtitle?: string;
    kind: Kind;
    /** Hyprland's own default, shown as the value of a setting not changed. */
    default: Value;
    min?: number;
    max?: number;
    step?: number;
    /** For `select`: the values Hyprland takes, with their labels. */
    options?: [string, string][];
}

export const GROUPS = ['Windows', 'Layout', 'Blur', 'Shadow and opacity', 'Animations', 'Input', 'Miscellaneous'] as const;

export const DEFS: Def[] = [
    {key: 'general:gaps_in', group: 'Windows', title: 'Gap between windows', kind: 'int', default: 5, min: 0, max: 50, step: 1},
    {key: 'general:gaps_out', group: 'Windows', title: 'Gap to the screen edge', kind: 'int', default: 20, min: 0, max: 100, step: 1},
    {key: 'general:border_size', group: 'Windows', title: 'Border width', kind: 'int', default: 1, min: 0, max: 10, step: 1},
    {key: 'decoration:rounding', group: 'Windows', title: 'Rounded corners', subtitle: 'Radius in pixels', kind: 'int', default: 0, min: 0, max: 40, step: 1},
    {key: 'general:resize_on_border', group: 'Windows', title: 'Resize by dragging a border', kind: 'switch', default: false},

    {key: 'general:layout', group: 'Layout', title: 'Layout', subtitle: 'Scrolling and Monocle need a recent Hyprland; an older one refuses them and the panel says so',
        kind: 'select', default: 'dwindle', options: [['dwindle', 'Dwindle: splits the screen in two, again and again'], ['master', 'Master: one large window, the rest in a stack'], ['scrolling', 'Scrolling: windows in a strip you scroll along'], ['monocle', 'Monocle: one window fills the area']]},
    {key: 'dwindle:pseudotile', group: 'Layout', title: 'Dwindle: pseudotile', subtitle: 'A window keeps the size it asks for inside its tile', kind: 'switch', default: false},
    {key: 'dwindle:preserve_split', group: 'Layout', title: 'Dwindle: keep the split direction', kind: 'switch', default: false},
    {key: 'dwindle:smart_split', group: 'Layout', title: 'Dwindle: split towards the pointer', kind: 'switch', default: false},
    {key: 'dwindle:force_split', group: 'Layout', title: 'Dwindle: where a new window goes', kind: 'select', default: '0',
        options: [['0', 'By the pointer'], ['1', 'Left or up'], ['2', 'Right or down']]},
    {key: 'master:orientation', group: 'Layout', title: 'Master: where the large window is', kind: 'select', default: 'left',
        options: [['left', 'Left'], ['right', 'Right'], ['top', 'Top'], ['bottom', 'Bottom'], ['center', 'Centre']]},
    {key: 'master:mfact', group: 'Layout', title: 'Master: size of the large window', subtitle: 'Share of the screen', kind: 'float', default: 0.55, min: 0.1, max: 0.9, step: 0.05},
    {key: 'master:new_status', group: 'Layout', title: 'Master: a new window becomes', kind: 'select', default: 'slave',
        options: [['master', 'The large window'], ['slave', 'Part of the stack'], ['inherit', 'Like the focused one']]},
    {key: 'master:new_on_top', group: 'Layout', title: 'Master: new windows go on top of the stack', kind: 'switch', default: false},
    {key: 'scrolling:column_width', group: 'Layout', title: 'Scrolling: width of a column', subtitle: 'Share of the screen', kind: 'float', default: 0.5, min: 0.1, max: 1, step: 0.05},
    {key: 'scrolling:follow_focus', group: 'Layout', title: 'Scrolling: the strip follows the focus', kind: 'switch', default: true},

    {key: 'decoration:blur:enabled', group: 'Blur', title: 'Blur behind windows', kind: 'switch', default: true},
    {key: 'decoration:blur:size', group: 'Blur', title: 'Blur radius', kind: 'int', default: 8, min: 1, max: 30, step: 1},
    {key: 'decoration:blur:passes', group: 'Blur', title: 'Blur passes', subtitle: 'More passes are smoother and cost more', kind: 'int', default: 1, min: 1, max: 8, step: 1},
    {key: 'decoration:blur:noise', group: 'Blur', title: 'Noise', kind: 'float', default: 0.0117, min: 0, max: 0.1, step: 0.005},
    {key: 'decoration:blur:vibrancy', group: 'Blur', title: 'Vibrancy', kind: 'float', default: 0.1696, min: 0, max: 1, step: 0.05},

    {key: 'decoration:shadow:enabled', group: 'Shadow and opacity', title: 'Window shadow', kind: 'switch', default: true},
    {key: 'decoration:shadow:range', group: 'Shadow and opacity', title: 'Shadow size', kind: 'int', default: 4, min: 0, max: 60, step: 1},
    {key: 'decoration:active_opacity', group: 'Shadow and opacity', title: 'Opacity of the focused window', kind: 'float', default: 1, min: 0.1, max: 1, step: 0.05},
    {key: 'decoration:inactive_opacity', group: 'Shadow and opacity', title: 'Opacity of other windows', kind: 'float', default: 1, min: 0.1, max: 1, step: 0.05},
    {key: 'decoration:dim_inactive', group: 'Shadow and opacity', title: 'Dim windows that are not focused', kind: 'switch', default: false},

    {key: 'animations:enabled', group: 'Animations', title: 'Animations', kind: 'switch', default: true},

    {key: 'input:follow_mouse', group: 'Input', title: 'Focus follows the pointer', kind: 'select', default: '1',
        options: [['0', 'Never (click to focus)'], ['1', 'Always'], ['2', 'Pointer moves focus, keyboard keeps it'], ['3', 'Only on click, pointer follows']]},
    {key: 'input:repeat_rate', group: 'Input', title: 'Key repeat rate', subtitle: 'Characters per second', kind: 'int', default: 25, min: 5, max: 100, step: 1},
    {key: 'input:repeat_delay', group: 'Input', title: 'Key repeat delay', subtitle: 'Milliseconds', kind: 'int', default: 600, min: 100, max: 1500, step: 50},
    {key: 'input:touchpad:natural_scroll', group: 'Input', title: 'Natural scrolling on the touchpad', kind: 'switch', default: false},

    {key: 'misc:disable_hyprland_logo', group: 'Miscellaneous', title: 'Hide the Hyprland logo on the background', kind: 'switch', default: false},
    {key: 'misc:vfr', group: 'Miscellaneous', title: 'Variable frame rate', subtitle: 'Draws only when something changes: saves power', kind: 'switch', default: true},
];

export const BY_KEY = new Map(DEFS.map(d => [d.key, d]));

export type Overrides = Record<string, Value>;

/** Whole sets of values to start from. Each lists only what it changes; the rest goes back to the default. */
export const PRESETS: Record<string, {title: string; values: Overrides}> = {
    glass: {title: 'Glass', values: {
        'general:gaps_in': 6, 'general:gaps_out': 14, 'general:border_size': 1, 'decoration:rounding': 14,
        'decoration:blur:enabled': true, 'decoration:blur:size': 10, 'decoration:blur:passes': 3, 'decoration:blur:vibrancy': 0.3,
        'decoration:shadow:enabled': true, 'decoration:shadow:range': 18, 'decoration:inactive_opacity': 0.92}},
    sharp: {title: 'Sharp', values: {
        'general:gaps_in': 0, 'general:gaps_out': 0, 'general:border_size': 2, 'decoration:rounding': 0,
        'decoration:blur:enabled': false, 'decoration:shadow:enabled': false}},
    minimal: {title: 'Minimal and light', values: {
        'general:gaps_in': 3, 'general:gaps_out': 6, 'general:border_size': 1, 'decoration:rounding': 6,
        'decoration:blur:enabled': false, 'decoration:shadow:enabled': false, 'animations:enabled': false}},
};

// ---- Text of a value

/** A value as Hyprland's config and `hyprctl keyword` write it. */
export function format(def: Def, value: Value): string {
    if (def.kind === 'switch') return value === true || value === 'true' ? 'true' : 'false';
    if (def.kind === 'int') return String(Math.round(Number(value)));
    if (def.kind === 'float') return String(Math.round(Number(value) * 10000) / 10000);
    return String(value);
}

/** A value read back from text, or undefined when it does not suit the setting (it is then left out, never guessed). */
export function parseValue(def: Def, text: string): Value | undefined {
    const t = text.trim();
    switch (def.kind) {
    case 'switch':
        if (/^(true|yes|on|1)$/i.test(t)) return true;
        if (/^(false|no|off|0)$/i.test(t)) return false;
        return undefined;
    case 'int': case 'float': {
        const n = Number(t);
        if (t === '' || !Number.isFinite(n)) return undefined;
        return clamp(def, def.kind === 'int' ? Math.round(n) : n);
    }
    default:
        return def.options?.some(([v]) => v === t) ? t : undefined;
    }
}

export function clamp(def: Def, n: number): number {
    return Math.min(def.max ?? n, Math.max(def.min ?? n, n));
}

// ---- niro.conf

export const FILE_MARK = '# Written by Niro Control. Only what was changed is here; remove a line (or reset it in the panel) to go back.';

/** The file's text for `values`, in the panel's own order, so it does not shuffle from one write to the next. */
export function serialize(values: Overrides): string {
    const lines = [FILE_MARK];
    for (const def of DEFS) {
        const v = values[def.key];
        if (v === undefined) continue;
        lines.push(`${def.key} = ${format(def, v)}`);
    }
    return `${lines.join('\n')}\n`;
}

/** The overrides in a niro.conf. A line that is not a known setting, or does not parse, is skipped. */
export function parse(text: string): Overrides {
    const out: Overrides = {};
    for (const raw of text.split('\n')) {
        const line = raw.replace(/#.*$/, '').trim();
        const eq = line.indexOf('=');
        if (eq < 0) continue;
        const def = BY_KEY.get(line.slice(0, eq).trim());
        if (!def) continue;
        const v = parseValue(def, line.slice(eq + 1));
        if (v !== undefined) out[def.key] = v;
    }
    return out;
}

/** What differs from Hyprland's own default: a value equal to it is not worth writing. */
export function changed(values: Overrides): Overrides {
    const out: Overrides = {};
    for (const [k, v] of Object.entries(values)) {
        const def = BY_KEY.get(k);
        if (def && format(def, v) !== format(def, def.default)) out[k] = v;
    }
    return out;
}

// ---- The line in hyprland.conf

const MARK = '# niro-control';

/** The line that makes hyprland.conf read niro.conf; marked, so it is found again and only it is ever removed. */
export function sourceLine(path: string): string {
    return `source = ${path} ${MARK}`;
}

export function hasSource(conf: string): boolean {
    return conf.split('\n').some(l => /^\s*source\s*=/.test(l) && l.includes(MARK));
}

/** `conf` with the line at its end (as it is, when it has it already). Everything else is left as written. */
export function addSource(conf: string, path: string): string {
    if (hasSource(conf)) return conf;
    const base = conf === '' || conf.endsWith('\n') ? conf : `${conf}\n`;
    return `${base}\n${sourceLine(path)}\n`;
}

/** `conf` without the marked line, and nothing else changed. */
export function removeSource(conf: string): string {
    const lines = conf.split('\n');
    const keep = lines.filter(l => !(/^\s*source\s*=/.test(l) && l.includes(MARK)));
    // the blank line addSource put before it goes too, when it is the last one
    while (keep.length > 1 && keep[keep.length - 1] === '' && keep[keep.length - 2] === '') keep.pop();
    return keep.join('\n');
}

/** The arguments for `hyprctl keyword` that apply a setting now. */
export function keywordArgs(def: Def, value: Value): string[] {
    return ['keyword', def.key, format(def, value)];
}
