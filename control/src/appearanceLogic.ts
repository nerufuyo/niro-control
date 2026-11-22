// Appearance Studio, the logic without a screen: a transaction over the real settings (preview, cancel, commit with rollback), a
// read-back check after the write, the contrast rules for the accent, and the motion presets mapped onto the Dock's own keys.
// Nothing here imports GTK or GLib, so node can test it. The page (appearanceStudio.ts) only draws this state.
// @ts-ignore: shell/shared is copied next to the build by `npm run build`
import {beginTransaction} from './shared/transaction.js';
// @ts-ignore
import {buildPalette, contrast, createMotion, ensureContrast, MOTION_PRESETS} from './shared/tokens.js';

export type StudioState = 'loading' | 'ready' | 'disabled' | 'error' | 'applying' | 'success' | 'rollback';

/** What the Studio edits: catalog ids of settings that already exist. Nothing here is a new key. */
export interface StudioComponent {id: string; label: string; ids: string[]; preview: 'dock' | 'windows' | 'look'; note?: string}

export const COMPONENTS: StudioComponent[] = [
    {id: 'dock', label: 'Dock', preview: 'dock', ids: ['dock.dock-position', 'dock.icon-size', 'dock.icon-spacing', 'dock.dock-padding',
        'dock.dock-border-radius', 'dock.icon-style', 'dock.icon-color'],
    note: 'The dock\'s opacity, background and blur follow Panel look: one value for the whole desktop.'},
    {id: 'island', label: 'Island', preview: 'look', ids: ['island.island-theme', 'island.island-shape', 'island.open-size', 'island.notch-depth',
        'island.top-bar-style', 'island.top-bar-opacity'],
    note: 'The island\'s glass follows Panel look.'},
    {id: 'windows', label: 'Windows', preview: 'windows', ids: ['corners.global-rounded-corner-settings.enabled',
        'corners.global-rounded-corner-settings.borderRadius', 'corners.border-width',
        'corners.global-rounded-corner-settings.keepRoundedCorners.maximized', 'corners.global-rounded-corner-settings.keepRoundedCorners.fullscreen'],
    note: 'Window opacity and blur follow Panel look. The window shadow has several fields: edit it in Windows.'},
    {id: 'panel', label: 'Panel look', preview: 'look', ids: ['niro.accent', 'niro.tint', 'niro.color-scheme', 'niro.opacity', 'niro.blur', 'niro.blur-strength']},
];

/** The Dock settings the motion presets write. */
export const MOTION_KEYS = ['dock.animation-duration', 'dock.bounce-on-launch'];
export const ALL_IDS = [...new Set([...COMPONENTS.flatMap(c => c.ids), ...MOTION_KEYS])];

/** Which parts of the desktop read an animation setting today (checked in the sources, not assumed). */
export const MOTION_CONSUMERS = [
    {component: 'Dock', consumes: true, how: 'animation-duration (ms) and bounce-on-launch: the presets write both.'},
    {component: 'Island', consumes: false, how: 'No animation setting exists; it only follows the system animations switch.'},
    {component: 'Windows', consumes: false, how: 'Tile has an on/off "slide into tiles" switch and no duration; the presets do not touch it.'},
    {component: 'Control panel', consumes: false, how: 'Its page crossfade follows the system animations switch.'},
];

export const PRESET_ORDER = ['minimal', 'smooth', 'dynamic', 'cinematic'];
export const PRESET_LABELS: Record<string, string> = {minimal: 'Minimal', smooth: 'Smooth', dynamic: 'Dynamic', cinematic: 'Cinematic'};

/** The Dock values a preset stands for. `reduced` (the system's "reduce animations") gives 0 ms and no bounce. */
export function motionPlan(preset: string, reduced = false) {
    if (!PRESET_ORDER.includes(preset))
        return null;
    const motion = createMotion({preset, reduced});
    return {
        'dock.animation-duration': motion.duration('normal', 'dock'),
        // a bounce is a jump with overshoot: Minimal is the one preset without it
        'dock.bounce-on-launch': !reduced && preset !== 'minimal',
    } as Record<string, number | boolean>;
}

/** Which preset the Dock's current values are, or 'custom'. 0 ms with bounce off reads as reduced motion. */
export function detectPreset(duration: unknown, bounce: unknown): string {
    if (duration === 0 && bounce === false)
        return 'reduced';
    for (const p of PRESET_ORDER) {
        const plan = motionPlan(p);
        if (plan && plan['dock.animation-duration'] === duration && plan['dock.bounce-on-launch'] === bounce)
            return p;
    }
    return 'custom';
}

export const presetMs = (preset: string): number => MOTION_PRESETS[preset]?.normal ?? 0;

// ---- colour

const HEX = /^#[0-9a-f]{6}$/i;

export interface Constraint {value?: any; note?: string; refuse?: string; also?: Record<string, any>}

/**
 * The accent sits on the surface tint, so it must be readable there (3:1, it is a graphic). A colour that is not #RRGGBB is refused;
 * one that is too close to the surface is moved toward white or black until it reads, and the note says so.
 * Changing the tint can make the accent unreadable too: then the accent is moved (`also`).
 */
export function constrainAppearance(id: string, value: any, draft: Record<string, any>): Constraint {
    if (id !== 'niro.accent' && id !== 'niro.tint')
        return {value};
    if (typeof value !== 'string' || !HEX.test(value))
        return {refuse: `"${value}" is not a colour: write it as #RRGGBB`};
    const color = value.toUpperCase();
    const tint = id === 'niro.tint' ? color : String(draft['niro.tint'] ?? '#1C1C1E');
    const accent = id === 'niro.accent' ? color : String(draft['niro.accent'] ?? '#E8472B');
    if (!HEX.test(tint) || !HEX.test(accent))
        return {value: color};
    const ratio = contrast(accent, tint);
    if (ratio === null || ratio >= 3)
        return {value: color};
    const safe = String(ensureContrast(accent, tint, 3)).toUpperCase();
    const text = `${accent} reads at only ${ratio.toFixed(1)}:1 on the surface ${tint} (it needs 3:1), so the accent was moved to ${safe} (${contrast(safe, tint).toFixed(1)}:1).`;
    return id === 'niro.accent' ? {value: safe, note: text} : {value: color, also: {'niro.accent': safe}, note: text};
}

export interface ColorAdvice {level: 'low' | 'unreadable'; ratio: number; accent: string; surface: string; suggestion: string; suggestedRatio: number; text: string}

/**
 * Advice (never a change) about an accent on the panel surface (the tint). Below 4.5:1 it is a warning (fine for a graphic, hard as text);
 * below 3:1 it is unreadable and the caller must ask before writing. `suggestion` is the accent moved toward white or black until it reads
 * at 4.5:1. null: the pair reads, or one of the two is not #RRGGBB (that is refused elsewhere).
 */
export function colorAdvice(accent: string, surface: string): ColorAdvice | null {
    if (typeof accent !== 'string' || typeof surface !== 'string' || !HEX.test(accent) || !HEX.test(surface))
        return null;
    const ratio = contrast(accent, surface);
    if (ratio === null || ratio >= 4.5)
        return null;
    const suggestion = String(ensureContrast(accent, surface, 4.5)).toUpperCase();
    const suggestedRatio = contrast(suggestion, surface) as number;
    const level = ratio < 3 ? 'unreadable' : 'low';
    const a = accent.toUpperCase(), t = surface.toUpperCase();
    const text = `${a} reads at ${ratio.toFixed(1)}:1 on the panel surface ${t}. ${level === 'unreadable' ? 'That is hard to see (under 3:1).' : 'Fine for a shape, weak for text (4.5:1 is comfortable).'} Suggested: ${suggestion} (${suggestedRatio.toFixed(1)}:1).`;
    return {level, ratio, accent: a, surface: t, suggestion, suggestedRatio, text};
}

const PALETTE_TOKENS: [string, number | null][] = [['accent', 3], ['primary', 4.5], ['foreground', 4.5], ['muted', 4.5], ['secondary', 4.5],
    ['danger', 4.5], ['success', 4.5], ['warning', 4.5], ['border', null]];

/** The contrast-checked palette for `accent` on a dark or a light surface: each token with its ratio and whether it passes. */
export function paletteReport(accent: string, dark: boolean) {
    const palette = buildPalette(accent, dark);
    if (!palette)
        return null;
    return {
        surface: palette.surface as string,
        adjusted: String(palette.accent).toLowerCase() !== accent.toLowerCase() || String(palette.primary).toLowerCase() !== accent.toLowerCase(),
        tokens: PALETTE_TOKENS.map(([token, min]) => {
            const color = String(palette[token]);
            const ratio = contrast(color, palette.surface) as number;
            return {token, color, ratio, min, ok: min === null || ratio >= min};
        }),
    };
}

// ---- values

/** The catalog default of an item as a value of its type (the catalog keeps it as text). */
export function parseDefault(item: {type: string; default: string; kind?: string}): any {
    const t = item.type;
    if (t === 'b') return item.default === 'true';
    if (['i', 'u', 'x', 'd'].includes(t)) return Number(item.default);
    return item.default;
}

export function sameValue(a: any, b: any): boolean {
    if (typeof a === 'number' && typeof b === 'number')
        return Math.abs(a - b) < 1e-6;
    if (typeof a === 'string' && typeof b === 'string' && HEX.test(a) && HEX.test(b))
        return a.toLowerCase() === b.toLowerCase();
    return JSON.stringify(a) === JSON.stringify(b);
}

// ---- the Studio

export interface StudioIO {
    read(id: string): any;
    write(id: string, value: any): void;
    /** False when the setting cannot be applied here (its extension is not installed). */
    available(id: string): boolean;
}

export interface StudioOptions {
    defaults?: Record<string, any>;
    reasons?: Record<string, string>;
    /** The labels used in messages. */
    titles?: Record<string, string>;
}

export function createStudio(ids: string[], io: StudioIO, options: StudioOptions = {}) {
    const defaults = options.defaults ?? {};
    const title = (id: string) => options.titles?.[id] ?? id;
    const listeners = new Set<() => void>();
    const history: StudioState[] = [];
    let state: StudioState = 'loading';
    let message = '';
    const notes: string[] = [];
    let tx: any = null;
    let supported: string[] = [];
    let previous: Record<string, any> | null = null;   // what the last successful Apply replaced
    let showBefore = false;

    const emit = () => listeners.forEach(fn => fn());
    const to = (s: StudioState, m = '') => { state = s; message = m; history.push(s); emit(); };
    const safeRead = (id: string) => { try { return io.read(id); } catch (_e) { return undefined; } };

    const open = () => {
        supported = ids.filter(id => io.available(id));
        tx = beginTransaction(Object.fromEntries(ids.map(id => [id, supported.includes(id) ? safeRead(id) : undefined])), supported);
    };

    const self = {
        get state() { return state; },
        get message() { return message; },
        get notes() { return [...notes]; },
        get history() { return [...history]; },
        get showBefore() { return showBefore; },
        subscribe(fn: () => void) { listeners.add(fn); return () => listeners.delete(fn); },
        /** Reads the settings and opens a transaction: ready, disabled (nothing can be applied here) or error. */
        load() {
            try {
                open();
            } catch (e: any) {
                to('error', `Couldn't read the settings: ${e.message}`);
                return;
            }
            if (!supported.length)
                to('disabled', 'None of these settings can be applied here: the Niro extensions are not installed.');
            else
                to('ready', '');
        },
        isSupported: (id: string) => supported.includes(id),
        unavailable: () => ids.filter(id => !supported.includes(id)).map(id => ({id, reason: options.reasons?.[id] ?? 'its extension is not installed'})),
        /** The draft: what the controls and the "after" preview show. */
        draft: () => (tx ? tx.preview() : {}) as Record<string, any>,
        before: () => (tx ? tx.before() : {}) as Record<string, any>,
        value(id: string) { return tx ? tx.preview()[id] : undefined; },
        /** The value to draw: the draft, or the settings as they are when Before is on; a setting the Studio does not edit is read live. */
        view(id: string) {
            if (!tx || !ids.includes(id))
                return safeRead(id);
            return showBefore ? tx.before()[id] : tx.preview()[id];
        },
        setShowBefore(on: boolean) { showBefore = on; emit(); },
        changes: () => (tx ? tx.changes() : []) as {key: string; before: any; after: any}[],
        /** Puts a value in the draft (never in the settings). The reply says why a value was refused or adjusted. */
        set(id: string, value: any): {ok: boolean; value?: any; reason?: string; note?: string} {
            if (!tx || state === 'disabled' || state === 'error' || state === 'loading')
                return {ok: false, reason: message || 'Not ready'};
            if (!supported.includes(id))
                return {ok: false, reason: `${title(id)} is unavailable: ${options.reasons?.[id] ?? 'its extension is not installed'}`};
            const c = constrainAppearance(id, value, tx.preview());
            if (c.refuse)
                return {ok: false, reason: c.refuse};
            tx.set(id, c.value);
            for (const [k, v] of Object.entries(c.also ?? {}))
                if (supported.includes(k)) tx.set(k, v);
            notes.length = 0;
            if (c.note) notes.push(c.note);
            if (state === 'success' || state === 'rollback')
                state = 'ready';
            emit();
            return {ok: true, value: c.value, note: c.note};
        },
        cancel() {
            if (!tx) return;
            tx.cancel();
            notes.length = 0;
            to('ready', 'Cancelled: nothing was changed.');
        },
        reset(id: string) {
            if (id in defaults) self.set(id, defaults[id]);
        },
        /** The whole draft back to the catalog defaults (still only a draft until Apply). */
        resetAll() {
            for (const id of supported) if (id in defaults) self.set(id, defaults[id]);
            to('ready', 'The draft is back at the defaults. Apply writes them.');
        },
        canRestore: () => previous !== null,
        /** The values the last Apply replaced, as a draft. */
        restorePrevious() {
            if (!previous) return false;
            for (const [k, v] of Object.entries(previous)) tx.set(k, v);
            to('ready', 'The values before the last Apply are in the draft. Apply writes them.');
            return true;
        },
        /** After the settings changed elsewhere: new baseline, keeping the draft of the settings the person changed here. */
        refresh() {
            if (!tx || state === 'applying') return;
            const mine = self.changes();
            const keep = Object.fromEntries(mine.map(c => [c.key, c.after]));
            open();
            for (const [k, v] of Object.entries(keep)) tx.set(k, v);
            emit();
        },
        /**
         * Writes the draft with the transaction, then reads every written setting back. A failed write or a value that did not
         * stick puts all of them back and says so.
         */
        apply(): {ok: boolean; message: string; written: number} {
            if (!tx || !self.changes().length)
                return {ok: false, message: 'Nothing to apply.', written: 0};
            const changes = self.changes();
            to('applying', `Applying ${changes.length} change${changes.length === 1 ? '' : 's'}…`);
            const result = tx.commit((k: string, v: any) => io.write(k, v));
            if (!result.ok) {
                const m = `Not applied: ${result.error}. ${result.rolledBack ? `The ${result.rolledBack} earlier change${result.rolledBack === 1 ? ' was' : 's were'} put back.` : 'Nothing was changed.'}`;
                to('rollback', m);
                return {ok: false, message: m, written: 0};
            }
            const bad = changes.filter(c => !sameValue(safeRead(c.key), c.after));
            if (bad.length) {
                const stuck: string[] = [];
                for (const c of [...changes].reverse()) {
                    try { io.write(c.key, c.before); } catch (_e) { /* checked below */ }
                    if (!sameValue(safeRead(c.key), c.before)) stuck.push(title(c.key));
                }
                const m = `Rolled back: ${bad.map(c => `${title(c.key)} is ${JSON.stringify(safeRead(c.key))}, not ${JSON.stringify(c.after)}`).join('; ')}.${stuck.length ? ` Could not restore: ${stuck.join(', ')}.` : ''}`;
                to('rollback', m);
                return {ok: false, message: m, written: 0};
            }
            previous = Object.fromEntries(changes.map(c => [c.key, c.before]));
            const keepDraft = changes.length;
            open();
            to('success', `Applied ${keepDraft} change${keepDraft === 1 ? '' : 's'} and checked that each one stuck.`);
            return {ok: true, message: message, written: keepDraft};
        },
    };
    return self;
}

export type Studio = ReturnType<typeof createStudio>;
