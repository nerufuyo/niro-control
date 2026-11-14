// The look of the panel as three layers, each with its own alpha, so that the opacity of the glass never touches the text:
//   1. glass     the window material, the only layer that follows Look > Opacity (and the Look tint in the dark scheme)
//   2. surfaces  sidebar, content, groups, raised things: fixed alphas high enough to carry text over any wallpaper
//   3. foreground text and dividers: fixed, never faded by anything above
// Pure (no GTK), so tests can check the contrast. window.ts turns tokens() into a GTK stylesheet.

export type Scheme = 'dark' | 'light';
export type RGB = [number, number, number];
export interface Layer {rgb: RGB; a: number}
export interface Tokens {
    glass: Layer; sidebar: Layer; content: Layer; group: Layer; elevated: Layer; hover: Layer;
    text1: Layer; text2: Layer; text3: Layer; textDisabled: Layer; divider: Layer; border: Layer;
}

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
export const hexToRgb = (hex: string): RGB | null => {
    const m = /^#([0-9a-f]{6})$/i.exec((hex ?? '').trim());
    return m ? [0, 2, 4].map(i => parseInt(m[1].slice(i, i + 2), 16)) as RGB : null;
};
const luminance = ([r, g, b]: RGB) => [r, g, b].map(v => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }).reduce((s, v, i) => s + v * [0.2126, 0.7152, 0.0722][i], 0);

/** Look > Opacity (0 to 100) as the alpha of the glass: 80 (the default) is half see-through; the ends are clear glass and solid. */
export function glassAlpha(opacity: number): number {
    const o = clamp(Number.isFinite(opacity) ? opacity : 80, 0, 100);
    return o <= 80 ? 0.2 + 0.3 * (o / 80) : 0.5 + 0.5 * ((o - 80) / 20);
}

export function tokens(scheme: Scheme, opacity: number, tint?: string): Tokens {
    const L = (rgb: RGB, a: number): Layer => ({rgb, a});
    if (scheme === 'dark') {
        const t = hexToRgb(tint ?? '');
        return {
            glass: L(t && luminance(t) < 0.12 ? t : [20, 20, 24], glassAlpha(opacity)),
            sidebar: L([18, 18, 22], 0.65), content: L([16, 16, 20], 0.82), group: L([28, 28, 34], 0.85), elevated: L([35, 35, 42], 0.90), hover: L([255, 255, 255], 0.07),
            text1: L([255, 255, 255], 0.96), text2: L([255, 255, 255], 0.75), text3: L([255, 255, 255], 0.60), textDisabled: L([255, 255, 255], 0.42),
            divider: L([255, 255, 255], 0.10), border: L([255, 255, 255], 0.08),
        };
    }
    return {
        glass: L([244, 244, 248], glassAlpha(opacity)),
        sidebar: L([238, 238, 243], 0.70), content: L([250, 250, 252], 0.86), group: L([255, 255, 255], 0.92), elevated: L([255, 255, 255], 0.96), hover: L([0, 0, 0], 0.06),
        text1: L([0, 0, 0], 0.90), text2: L([0, 0, 0], 0.70), text3: L([0, 0, 0], 0.56), textDisabled: L([0, 0, 0], 0.38),
        divider: L([0, 0, 0], 0.10), border: L([0, 0, 0], 0.10),
    };
}

// ---- Contrast (WCAG 2): what a person sees, from the wallpaper up
const over = (top: Layer, below: RGB): RGB => top.rgb.map((c, i) => Math.round(c * top.a + below[i] * (1 - top.a))) as RGB;
export function contrast(a: RGB, b: RGB): number {
    const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return (hi + 0.05) / (lo + 0.05);
}
/** The colour behind a row of text: wallpaper, glass, content, group. `where` says which of them the text sits on. */
export function surfaceBehind(t: Tokens, wallpaper: RGB, where: 'group' | 'content' | 'sidebar'): RGB {
    const glass = over(t.glass, wallpaper);
    return where === 'group' ? over(t.group, over(t.content, glass)) : where === 'content' ? over(t.content, glass) : over(t.sidebar, glass);
}
export function textContrast(t: Tokens, text: keyof Tokens, wallpaper: RGB, where: 'group' | 'content' | 'sidebar'): number {
    const bg = surfaceBehind(t, wallpaper, where);
    return contrast(over(t[text], bg), bg);
}

// ---- The stylesheet
const rgba = (l: Layer) => `rgba(${l.rgb.join(', ')}, ${+l.a.toFixed(3)})`;

/** GTK 4 CSS: named colours for the tokens, libadwaita's foreground colours pointed at them, and the rules for the layers. */
export function stylesheet(scheme: Scheme, opacity: number, tint?: string): string {
    const t = tokens(scheme, opacity, tint);
    return `
@define-color niro_glass ${rgba(t.glass)};
@define-color niro_sidebar ${rgba(t.sidebar)};
@define-color niro_content ${rgba(t.content)};
@define-color niro_group ${rgba(t.group)};
@define-color niro_elevated ${rgba(t.elevated)};
@define-color niro_hover ${rgba(t.hover)};
@define-color niro_text_1 ${rgba(t.text1)};
@define-color niro_text_2 ${rgba(t.text2)};
@define-color niro_text_3 ${rgba(t.text3)};
@define-color niro_border ${rgba(t.border)};
@define-color niro_divider ${rgba(t.divider)};
@define-color window_fg_color @niro_text_1;
@define-color view_fg_color @niro_text_1;
@define-color card_fg_color @niro_text_1;
@define-color headerbar_fg_color @niro_text_1;
@define-color sidebar_fg_color @niro_text_1;

/* 1. the glass: only the window's own background follows Look > Opacity */
window.niro-window { background-color: @niro_glass; border: 1px solid @niro_border; color: @niro_text_1; }
window.niro-window:not(.maximized):not(.fullscreen):not(.tiled), window.niro-window.csd:not(.maximized):not(.fullscreen):not(.tiled) { border-radius: 14px; }
/* 2. the surfaces on it */
.niro-sidebar { background-color: @niro_sidebar; }
.niro-content { background-color: @niro_content; }
.niro-window headerbar { background: transparent; box-shadow: none; }
.niro-window .boxed-list, .niro-window preferencesgroup > box > box > list { background-color: @niro_group; border: 1px solid @niro_border; }
.niro-window .boxed-list > row, .niro-window preferencesgroup list > row { border-color: @niro_divider; }
.niro-subnav { background-color: @niro_sidebar; }
.niro-subnav row { border-radius: 8px; margin: 1px 6px; }
.niro-preview { border-radius: 12px; background-color: @niro_elevated; border: 1px solid @niro_border; }
.niro-card { border-radius: 14px; background-color: @niro_group; border: 1px solid @niro_border; }
.niro-card-active { background-color: alpha(@accent_bg_color, 0.22); border-radius: 14px; }
.niro-preset { padding: 6px 10px; border-radius: 9px; }
.niro-sidebar row.activatable { border-radius: 9px; margin: 1px 6px; }
.niro-window row.activatable:hover:not(:selected) { background-color: @niro_hover; }
/* 3. the foreground: set on the containers too, so no libadwaita palette lookup decides it
   (and libadwaita dims secondary text with opacity, which also dims it over the glass: use a colour instead) */
.niro-sidebar, .niro-content, .niro-window headerbar, .niro-window row, .niro-window .boxed-list { color: @niro_text_1; }
/* (continued) libadwaita dims secondary text with opacity, which also dims it over the glass: use a colour instead */
.niro-window .dim-label, .niro-window .subtitle, .niro-window row .subtitle { opacity: 1; color: @niro_text_2; }
.niro-window .caption.dim-label { color: @niro_text_3; }
.niro-window button:not(.suggested-action):not(.destructive-action):not(:checked), .niro-window togglebutton:not(:checked) { color: @niro_text_1; }
.niro-window .linked button.toggle:checked { color: @niro_text_1; }
.niro-window entry, .niro-window searchentry { color: @niro_text_1; }
.niro-window entry text placeholder, .niro-window searchentry text placeholder { color: @niro_text_3; opacity: 1; }
.niro-window separator { background-color: @niro_divider; }
`;
}
