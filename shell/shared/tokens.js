// Motion and colour tokens (vNext S5). Pure: no Clutter, no timers. A component asks for a duration; it gets 0 when motion is off, so
// nothing can wait on an animation that will never finish (the "onComplete re-arms itself" loop). Durations are in milliseconds.

export const MOTION_PRESETS = {
    minimal:   {fast: 80,  normal: 120, slow: 180, easing: 'ease-out-quad',  spring: {stiffness: 300, damping: 34}},
    smooth:    {fast: 120, normal: 200, slow: 320, easing: 'ease-out-cubic', spring: {stiffness: 220, damping: 26}},
    dynamic:   {fast: 160, normal: 260, slow: 420, easing: 'ease-out-back',  spring: {stiffness: 170, damping: 16}},
    cinematic: {fast: 240, normal: 400, slow: 640, easing: 'ease-in-out-cubic', spring: {stiffness: 120, damping: 20}},
};
export const MOTION_COMPONENTS = ['dock', 'island', 'window-open', 'window-close', 'workspace', 'notification', 'hover', 'hud'];

/**
 * `settings`: {preset, reduced (the system's "reduce animations"), off: components with motion switched off, scale: 0.5..2}.
 * Returns {duration(token, component), easing, spring(component)}; an unknown preset falls back to smooth.
 */
export function createMotion(settings = {}) {
    const preset = MOTION_PRESETS[settings.preset] ?? MOTION_PRESETS.smooth;
    const off = new Set(settings.off ?? []);
    const scale = Math.min(2, Math.max(0.5, Number(settings.scale) || 1));
    const still = c => settings.reduced === true || off.has(c);
    return {
        duration: (token, component) => {
            if (still(component) || !(token in preset) || typeof preset[token] !== 'number')
                return 0;
            return Math.round(preset[token] * scale);
        },
        easing: preset.easing,
        // A spring with no motion is a jump to the end: stiffness is infinite, so callers should skip it when `animated` is false.
        spring: component => ({...preset.spring, animated: !still(component)}),
    };
}

/**
 * Opt-in scaling of a surface's existing hard-coded durations (the island). `settings`: {preset: '' / 'default' | 'off' | a MOTION_PRESETS name,
 * reduced: the system's animations are off}. '' or 'default' leaves `ms` exactly as the component has always had it; 'off' or `reduced` (with a preset
 * chosen) gives 0; a preset scales `ms` by its `normal` over the smooth preset's, so 'smooth' is the look the hard-coded values were tuned to.
 */
export const MOTION_REFERENCE_MS = MOTION_PRESETS.smooth.normal;
/**
 * Whether decoration that runs by itself (the breath, the lyrics dots) and auto-hide / voice / chat transitions may move: never
 * with preset 'off', never with GNOME's reduce-animations. 'default' and empty reduce to the plain "animations are on" check the
 * island always made, so they change nothing.
 */
export const motionAllowed = (settings = {}) => settings.preset !== 'off' && settings.reduced !== true;
export function scaleDuration(ms, settings = {}) {
    const n = Number(ms);
    if (!Number.isFinite(n) || n <= 0)
        return 0;
    const preset = typeof settings.preset === 'string' ? settings.preset : '';
    if (preset === '' || preset === 'default')
        return n;
    if (preset === 'off' || settings.reduced === true)
        return 0;
    const p = MOTION_PRESETS[preset];
    return p ? Math.max(1, Math.round(n * p.normal / MOTION_REFERENCE_MS)) : n;
}

// ---- colour

const hex = h => {
    const m = /^#?([0-9a-f]{6})$/i.exec(h ?? '');
    if (!m)
        return null;
    const n = parseInt(m[1], 16);
    return [n >> 16 & 255, n >> 8 & 255, n & 255];
};
const toHex = c => `#${c.map(v => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, '0')).join('')}`;

export function luminance(color) {
    const rgb = hex(color);
    if (!rgb)
        return null;
    const [r, g, b] = rgb.map(v => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio of two #rrggbb colours (1 to 21), or null when either is not a colour. */
export function contrast(a, b) {
    const la = luminance(a), lb = luminance(b);
    if (la === null || lb === null)
        return null;
    return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** `color` moved toward white or black (whichever helps) until it reads on `background` at `min` (default 4.5); unchanged when it already does. */
export function ensureContrast(color, background, min = 4.5) {
    const rgb = hex(color);
    if (!rgb || contrast(color, background) === null)
        return null;
    if (contrast(color, background) >= min)
        return toHex(rgb);
    const towards = luminance(background) > 0.5 ? 0 : 255;
    for (let t = 0.05; t <= 1.0001; t += 0.05) {
        const c = toHex(rgb.map(v => v + (towards - v) * t));
        if (contrast(c, background) >= min)
            return c;
    }
    return toHex([towards, towards, towards]);
}

/**
 * The colours the island and the dock derive from the accent and the tint, in one place. Each value is the input itself while it already reads
 * (so the default accent and tint give the exact strings the stylesheets always had), and only moves when it would not:
 *   fill       the accent as a background (unchanged),
 *   onFill     text on that fill: white unless white is under 3:1 on it, then whichever of white or near-black reads better,
 *   onDark     the accent as text or a glyph on the island's dark surface (3:1),
 *   indicator  the accent as a dot or bar on the dock's `tint` (3:1).
 * An accent that is not #rrggbb gives null: the caller keeps what it had.
 */
export function deriveAccent(accent, tint = '#1c1c1e') {
    if (!hex(accent))
        return null;
    const keep = (c, bg, min) => contrast(c, bg) >= min ? c : ensureContrast(c, bg, min);
    const white = '#ffffff', ink = '#111111';
    const onFill = contrast(white, accent) >= 3 ? white : contrast(ink, accent) >= contrast(white, accent) ? ink : white;
    return {
        fill: accent,
        onFill,
        onDark: keep(accent, '#121212', 3),
        indicator: hex(tint) ? keep(accent, tint, 3) : accent,
    };
}

export const COLOR_TOKENS = ['primary', 'secondary', 'surface', 'surfaceVariant', 'foreground', 'muted', 'border', 'accent', 'danger', 'success', 'warning'];

/** A palette for `accent` on a light or dark surface, with the text and accent guaranteed readable. */
export function buildPalette(accent, dark) {
    if (!hex(accent))
        return null;
    const surface = dark ? '#1e1e1e' : '#fafafa', foreground = dark ? '#f2f2f2' : '#1b1b1b';
    const p = {
        surface, surfaceVariant: dark ? '#2b2b2b' : '#ececec', foreground,
        muted: ensureContrast(dark ? '#9a9a9a' : '#6a6a6a', surface),
        border: dark ? '#3d3d3d' : '#d4d4d4',
        accent: ensureContrast(accent, surface, 3),   // a graphic, not body text: 3:1
        primary: ensureContrast(accent, surface, 4.5),
        secondary: ensureContrast(dark ? '#8ab4f8' : '#3c5a99', surface),
        danger: ensureContrast('#d93025', surface), success: ensureContrast('#1e8e3e', surface), warning: ensureContrast('#b06000', surface),
    };
    return p;
}
