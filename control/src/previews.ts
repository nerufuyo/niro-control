// @ts-nocheck: Cairo contexts are untyped here
// The drawings: Look (the desktop's tone), Dock (position, size, indicators, magnification) and Windows (corners, shadow,
// blur). Each takes `read(id)`, which gives the live value of a setting, and says which ids it depends on.
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';

import {previewPanel} from './components.js';

const rgb = (hex: string): [number, number, number] => [1, 3, 5].map(i => parseInt(String(hex).slice(i, i + 2), 16) / 255);
const set = (cr, [r, g, b], a = 1) => cr.setSourceRGBA(r, g, b, a);

function roundRect(cr, x: number, y: number, w: number, h: number, r: number) {
    r = Math.max(0, Math.min(r, w / 2, h / 2));
    cr.newSubPath();
    cr.arc(x + w - r, y + r, r, -Math.PI / 2, 0);
    cr.arc(x + w - r, y + h - r, r, 0, Math.PI / 2);
    cr.arc(x + r, y + h - r, r, Math.PI / 2, Math.PI);
    cr.arc(x + r, y + r, r, Math.PI, 3 * Math.PI / 2);
    cr.closePath();
}

/** A wallpaper-ish backdrop: a diagonal gradient and a few soft shapes, so glass has something to show through. */
function wallpaper(cr, w, h, softness = 0) {
    set(cr, [0.17, 0.12, 0.33]); cr.paint();
    const shapes = [[0.2, 0.3, 0.28, [0.85, 0.35, 0.25]], [0.75, 0.25, 0.22, [0.3, 0.55, 0.9]], [0.6, 0.85, 0.3, [0.9, 0.7, 0.3]]];
    for (const [x, y, r, c] of shapes) {
        set(cr, c, 0.85 * (1 - softness * 0.6));
        cr.arc(x * w, y * h, r * Math.min(w, h) * (1 + softness * 0.4), 0, 2 * Math.PI); cr.fill();
    }
}

function view(read, ids: string[], caption: string, draw, height?) {
    const {frame, area} = previewPanel(caption, (cr, w, h, a) => draw(cr, w, h, a), height);
    return {frame, area, ids};
}

// ---- Look
export function lookPreview(read) {
    const draw = (cr, w, h) => {
        const accent = rgb(read('niro.accent') ?? '#E8472B'), tint = rgb(read('niro.tint') ?? '#1C1C1E');
        const opacity = (read('niro.opacity') ?? 80) / 100, blur = read('niro.blur') ?? true, strength = (read('niro.blur-strength') ?? 30) / 100;
        cr.save(); roundRect(cr, 0, 0, w, h, 10); cr.clip();
        wallpaper(cr, w, h);
        // the island: a black notch with the accent in it
        set(cr, [0, 0, 0]); roundRect(cr, w / 2 - 58, -8, 116, 28, 12); cr.fill();
        set(cr, accent); roundRect(cr, w / 2 - 38, 5, 40, 4, 2); cr.fill();
        // a window
        const wx = w * 0.14, wy = h * 0.2, ww = w * 0.58, wh = h * 0.5;
        cr.save(); roundRect(cr, wx, wy, ww, wh, 10); cr.clip();
        if (blur) wallpaper(cr, w, h, 0.3 + strength * 0.7);
        set(cr, tint, opacity); cr.paint(); cr.restore();
        set(cr, [1, 1, 1], 0.1); cr.setLineWidth(1); roundRect(cr, wx + 0.5, wy + 0.5, ww - 1, wh - 1, 10); cr.stroke();
        [[1, 0.37, 0.34], [1, 0.74, 0.18], [0.16, 0.8, 0.25]].forEach((c, i) => { set(cr, c); cr.arc(wx + 12 + i * 12, wy + 12, 3.5, 0, 6.3); cr.fill(); });
        set(cr, [1, 1, 1], 0.55); [0, 1, 2].forEach(i => { roundRect(cr, wx + 14, wy + 32 + i * 14, ww * (0.7 - i * 0.15), 5, 2.5); cr.fill(); });
        set(cr, accent); roundRect(cr, wx + ww - 70, wy + wh - 28, 56, 16, 8); cr.fill();
        // the dock
        const dw = 170, dh = 34, dx = (w - dw) / 2, dy = h - dh - 8;
        set(cr, tint, opacity); roundRect(cr, dx, dy, dw, dh, 12); cr.fill();
        set(cr, [1, 1, 1], 0.12); roundRect(cr, dx + 0.5, dy + 0.5, dw - 1, dh - 1, 12); cr.stroke();
        for (let i = 0; i < 5; i++) {
            set(cr, [0.8, 0.8, 0.85], 0.85); roundRect(cr, dx + 12 + i * 31, dy + 6, 20, 20, 6); cr.fill();
            if (i < 2) { set(cr, accent); cr.arc(dx + 22 + i * 31, dy + dh - 3, 1.8, 0, 6.3); cr.fill(); }
        }
        cr.restore();
    };
    return view(read, ['niro.accent', 'niro.tint', 'niro.opacity', 'niro.blur', 'niro.blur-strength'], 'Preview of the island, a window and the dock', draw, 210);
}

// ---- Dock
const DOCK_IDS = ['dock.dock-position', 'dock.icon-size', 'dock.dock-border-radius', 'dock.dock-background-color', 'dock.dock-opacity',
    'dock.running-indicators', 'dock.running-indicator-style', 'dock.magnification-enabled', 'dock.magnification-scale',
    'dock.magnification-falloff', 'dock.show-applications-button', 'dock.show-applications-button-position', 'dock.animation-duration',
    'dock.dock-blur-enabled'];

export function dockPreview(read) {
    const N = 7;
    const state = {hover: null, scales: new Array(N).fill(1)};
    const geometry = (w, h) => {
        const pos = read('dock.dock-position') ?? 0, size = (read('dock.icon-size') ?? 48) * 0.62, gap = 7 * 0.8, pad = 9;
        const vertical = pos === 1 || pos === 2;
        const apps = read('dock.show-applications-button') ? 1 : 0;
        const count = N + apps;
        const length = count * size + (count - 1) * gap + pad * 2;
        return {pos, size, gap, pad, vertical, count, apps, length, depth: size + pad * 2 + 8};
    };
    const targets = (g, along) => {
        const mag = read('dock.magnification-enabled') ? (read('dock.magnification-scale') ?? 1.4) : 1;
        const sigma = (read('dock.magnification-falloff') ?? 100) * 0.62 * 0.62;
        return Array.from({length: N}, (_v, i) => {
            if (state.hover === null || mag === 1) return 1;
            const first = g.apps && read('dock.show-applications-button-position') === 0 ? 1 : 0;
            const center = g.pad + (i + first) * (g.size + g.gap) + g.size / 2;
            const d = state.hover - (along.start + center);
            return 1 + (mag - 1) * Math.exp(-(d * d) / (2 * sigma * sigma));
        });
    };
    const draw = (cr, w, h) => {
        const g = geometry(w, h);
        const tint = rgb(read('dock.dock-background-color') ?? '#1E1E1E'), opacity = (read('dock.dock-opacity') ?? 60) / 100;
        cr.save(); roundRect(cr, 0, 0, w, h, 10); cr.clip();
        wallpaper(cr, w, h);
        const along = g.vertical ? h : w, start = (along - g.length) / 2;
        const dx = g.vertical ? (g.pos === 1 ? 10 : w - g.depth - 10) : start;
        const dy = g.vertical ? start : (g.pos === 3 ? 10 : h - g.depth - 10);
        const dw = g.vertical ? g.depth : g.length, dh = g.vertical ? g.length : g.depth;
        const radius = (read('dock.dock-border-radius') ?? 16) * 0.8;
        cr.save(); roundRect(cr, dx, dy, dw, dh, radius); cr.clip();
        if (read('dock.dock-blur-enabled')) wallpaper(cr, w, h, 0.9);
        set(cr, tint, opacity); cr.paint(); cr.restore();
        set(cr, [1, 1, 1], 0.12); cr.setLineWidth(1); roundRect(cr, dx + 0.5, dy + 0.5, dw - 1, dh - 1, radius); cr.stroke();
        const first = g.apps && read('dock.show-applications-button-position') === 0 ? 1 : 0;
        const slot = i => g.pad + i * (g.size + g.gap);
        const palette = [[0.35, 0.6, 0.95], [0.95, 0.55, 0.3], [0.45, 0.8, 0.5], [0.8, 0.45, 0.8], [0.95, 0.8, 0.3], [0.5, 0.75, 0.85], [0.85, 0.5, 0.5]];
        for (let i = 0; i < N; i++) {
            const s = state.scales[i], size = g.size * s;
            const centre = slot(i + first) + g.size / 2;
            const cx = g.vertical ? dx + g.depth / 2 : start + centre, cy = g.vertical ? start + centre : dy + g.depth / 2;
            // icons grow away from the screen edge, as the dock's do
            const shift = (size - g.size) / 2 * (g.pos === 3 || g.pos === 1 ? 1 : -1);
            const ix = g.vertical ? cx + shift - size / 2 : cx - size / 2, iy = g.vertical ? cy - size / 2 : cy + shift - size / 2;
            set(cr, palette[i], 0.95); roundRect(cr, ix, iy, size, size, size * 0.24); cr.fill();
            if (read('dock.running-indicators') && i < 3) {
                set(cr, [1, 1, 1], 0.9);
                const style = read('dock.running-indicator-style');
                const bx = g.vertical ? (g.pos === 1 ? dx + 4 : dx + g.depth - 4) : cx, by = g.vertical ? cy : (g.pos === 3 ? dy + 4 : dy + g.depth - 4);
                if (style === 1) { if (g.vertical) roundRect(cr, bx - 1.5, by - size / 3, 3, size * 0.66, 1.5); else roundRect(cr, bx - size / 3, by - 1.5, size * 0.66, 3, 1.5); cr.fill(); }
                else { cr.arc(bx, by, 2, 0, 6.3); cr.fill(); }
            }
        }
        if (g.apps) {
            const i = read('dock.show-applications-button-position') === 0 ? 0 : N;
            const centre = slot(i) + g.size / 2;
            const cx = g.vertical ? dx + g.depth / 2 : start + centre, cy = g.vertical ? start + centre : dy + g.depth / 2;
            set(cr, [1, 1, 1], 0.7);
            for (let a = 0; a < 3; a++) for (let b = 0; b < 3; b++) { cr.arc(cx + (a - 1) * g.size * 0.22, cy + (b - 1) * g.size * 0.22, 1.7, 0, 6.3); cr.fill(); }
        }
        cr.restore();
        state.along = {start}; state.g = g;
    };
    const v = view(read, DOCK_IDS, 'Hover the dock: icons grow as they do on screen', draw, 230);
    const motion = new Gtk.EventControllerMotion();
    motion.connect('motion', (_c, x, y) => { const g = state.g; if (!g) return; state.hover = g.vertical ? y : x; });
    motion.connect('leave', () => (state.hover = null));
    v.area.add_controller(motion);
    // The icons ease toward their size over the dock's own animation time.
    v.area.add_tick_callback((area, clock) => {
        const g = state.g;
        if (!g) return GLib.SOURCE_CONTINUE;
        const goal = targets(g, state.along), ms = Math.max(30, read('dock.animation-duration') ?? 200), dt = 16 / ms;
        let moving = false;
        state.scales = state.scales.map((s, i) => { const n = s + (goal[i] - s) * Math.min(1, dt * 3); if (Math.abs(n - s) > 0.001) moving = true; return n; });
        if (moving) area.queue_draw();
        return GLib.SOURCE_CONTINUE;
    });
    return v;
}

// ---- Windows
export function windowsPreview(read) {
    const state = {maximized: false};
    const draw = (cr, w, h) => {
        const on = read('corners.global-rounded-corner-settings.enabled') ?? true;
        const radius = on ? (read('corners.global-rounded-corner-settings.borderRadius') ?? 12) : 0;
        const keep = read('corners.global-rounded-corner-settings.keepRoundedCorners.maximized') ?? false;
        const border = read('corners.border-width') ?? 0;
        const [focused] = read('corners.shadows') ?? [{}];
        const blur = read('niro.blur') ?? true, opacity = (read('niro.opacity') ?? 80) / 100, strength = (read('niro.blur-strength') ?? 30) / 100;
        const tint = rgb(read('niro.tint') ?? '#1C1C1E');
        cr.save(); roundRect(cr, 0, 0, w, h, 10); cr.clip();
        wallpaper(cr, w, h);
        const max = state.maximized;
        const wx = max ? 0 : w * 0.18, wy = max ? 0 : h * 0.16, ww = max ? w : w * 0.64, wh = max ? h : h * 0.66;
        const r = max && !keep ? 0 : radius;
        if (!max && on) {                                   // the shadow
            const blurR = (focused.blurOffset ?? 28) * 0.4, ox = (focused.horizontalOffset ?? 0) * 0.4, oy = (focused.verticalOffset ?? 4) * 0.4;
            for (let i = 6; i >= 1; i--) { set(cr, [0, 0, 0], ((focused.opacity ?? 60) / 100) * 0.07); roundRect(cr, wx + ox - blurR * i / 6, wy + oy - blurR * i / 6, ww + 2 * blurR * i / 6, wh + 2 * blurR * i / 6, r + blurR * i / 6); cr.fill(); }
        }
        cr.save(); roundRect(cr, wx, wy, ww, wh, r); cr.clip();
        if (blur) wallpaper(cr, w, h, 0.3 + strength * 0.7);
        set(cr, tint, opacity); cr.paint(); cr.restore();
        if (border > 0) { set(cr, [1, 1, 1], 0.5); cr.setLineWidth(Math.min(border, 8)); roundRect(cr, wx, wy, ww, wh, r); cr.stroke(); }
        else { set(cr, [1, 1, 1], 0.1); cr.setLineWidth(1); roundRect(cr, wx + 0.5, wy + 0.5, ww - 1, wh - 1, r); cr.stroke(); }
        [[1, 0.37, 0.34], [1, 0.74, 0.18], [0.16, 0.8, 0.25]].forEach((c, i) => { set(cr, c); cr.arc(wx + 14 + i * 12, wy + 13, 3.5, 0, 6.3); cr.fill(); });
        set(cr, [1, 1, 1], 0.5); [0, 1, 2, 3].forEach(i => { roundRect(cr, wx + 16, wy + 36 + i * 14, ww * (0.62 - i * 0.1), 5, 2.5); cr.fill(); });
        cr.restore();
    };
    const v = view(read, ['corners.global-rounded-corner-settings.enabled', 'corners.global-rounded-corner-settings.borderRadius',
        'corners.global-rounded-corner-settings.keepRoundedCorners.maximized', 'corners.border-width', 'corners.shadows', 'niro.blur',
        'niro.opacity', 'niro.blur-strength', 'niro.tint'], 'Click the window to preview it maximized', draw, 210);
    const click = new Gtk.GestureClick();
    click.connect('released', () => { state.maximized = !state.maximized; v.area.queue_draw(); });
    v.area.add_controller(click);
    return v;
}
