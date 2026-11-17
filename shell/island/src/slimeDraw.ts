// @ts-nocheck: written for the island, which is not typed yet
// SPDX-License-Identifier: GPL-3.0-or-later

// Draws Niro the slime (slime.js) with Cairo alone, so the island, Settings and the tests can all draw it. The drawing is made in a
// 240-pixel square, as on the device's screen, and scaled to `size`. The body is the same shape the device draws: a mound with a
// soft peak, found as the outline of two shapes melted together.

import Cairo from 'cairo';

import {BODY} from './slime.js';

const LIGHT = [150, 222, 255], DEEP = [52, 146, 240], RIM = [22, 98, 206], INK = [14, 24, 44], MOUTH = [20, 44, 104];
const TONGUE = [255, 120, 150], ICE = [170, 215, 255], PINK = [255, 105, 150], RED = [255, 69, 58], AMBER = [255, 159, 10];
const SHADOW = [8, 40, 96];

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * clamp(t, 0, 1));
const rgba = (cr, c, alpha = 1) => cr.setSourceRGBA(c[0] / 255, c[1] / 255, c[2] / 255, alpha);

function ellipse(cr, x, y, rx, ry) {
    cr.save();
    cr.translate(x, y);
    cr.scale(Math.max(rx, 0.01), Math.max(ry, 0.01));
    cr.newSubPath();
    cr.arc(0, 0, 1, 0, 2 * Math.PI);
    cr.restore();
}

function fillEllipse(cr, x, y, rx, ry, colour, alpha = 1) {
    if (rx < 0.3 || ry < 0.3)
        return;
    ellipse(cr, x, y, rx, ry);
    rgba(cr, colour, alpha);
    cr.fill();
}

function circle(cr, x, y, r, colour, alpha = 1) {
    cr.newSubPath();
    cr.arc(x, y, r, 0, 2 * Math.PI);
    rgba(cr, colour, alpha);
    cr.fill();
}

function line(cr, x0, y0, x1, y1, width, colour, alpha = 1) {
    cr.moveTo(x0, y0);
    cr.lineTo(x1, y1);
    cr.setLineWidth(width);
    rgba(cr, colour, alpha);
    cr.stroke();
}

/** A stroke bulging down (a smile, `sag` > 0) or up over the chord from x0 to x1 at y; a line when it hardly bulges. */
function arc(cr, x0, x1, y, sag, width, colour, alpha = 1) {
    if (Math.abs(sag) < 0.75) {
        line(cr, x0, y, x1, y, width, colour, alpha);
        return;
    }
    const half = (x1 - x0) / 2;
    cr.moveTo(x0, y);
    cr.curveTo(x0 + half * 0.5, y + sag * 1.333, x1 - half * 0.5, y + sag * 1.333, x1, y);
    cr.setLineWidth(width);
    rgba(cr, colour, alpha);
    cr.stroke();
}

/** Where the body ends: the outline of an ellipse melted with a small circle on top, as points round the middle. */
function outline(f, tr, tcx, tcy, cy, top) {
    const p = f.pose, m = Math.min(f.rx, f.ry), points = [];
    const field = (x, y) => {
        const ex = (x - f.cx) / f.rx, ey = (y - cy) / f.ry;
        const dBody = (Math.hypot(ex, ey) - 1) * m;
        if (p.tip <= 0.01)
            return dBody;
        const dTip = Math.hypot(x - tcx, y - tcy) - tr;
        const k = 26, h = Math.max(k - Math.abs(dBody - dTip), 0) / k;
        return Math.min(dBody, dTip) - h * h * k * 0.25;
    };
    const N = 96;
    for (let i = 0; i < N; i++) {
        const a = i / N * 2 * Math.PI, dx = Math.cos(a), dy = Math.sin(a);
        let lo = 0, hi = f.rx + 80;
        for (let k = 0; k < 18; k++) {
            const mid = (lo + hi) / 2;
            if (field(f.cx + dx * mid, cy + dy * mid) < 0) lo = mid; else hi = mid;
        }
        const x = f.cx + dx * lo, y = cy + dy * lo;
        // The top leans with a sway.
        points.push([x + f.shear * clamp((f.ground - y) / (2 * f.ry), 0, 1.4), y]);
    }
    return points;
}

/** A closed smooth path through `points` (Catmull-Rom turned to Béziers). */
function smoothPath(cr, pts) {
    const n = pts.length;
    cr.newPath();
    cr.moveTo(pts[0][0], pts[0][1]);
    for (let i = 0; i < n; i++) {
        const p0 = pts[(i - 1 + n) % n], p1 = pts[i], p2 = pts[(i + 1) % n], p3 = pts[(i + 2) % n];
        cr.curveTo(p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6, p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6, p2[0], p2[1]);
    }
    cr.closePath();
}

function heart(cr, x, y, s, colour, alpha) {
    circle(cr, x - s * 0.5, y - s * 0.25, s * 0.56, colour, alpha);
    circle(cr, x + s * 0.5, y - s * 0.25, s * 0.56, colour, alpha);
    cr.setLineCap(Cairo.LineCap.ROUND);
    line(cr, x - s * 0.9, y + s * 0.05, x, y + s * 1.1, s * 0.42, colour, alpha);
    line(cr, x + s * 0.9, y + s * 0.05, x, y + s * 1.1, s * 0.42, colour, alpha);
}

function sparkle(cr, x, y, s, colour, alpha) {
    cr.setLineCap(Cairo.LineCap.ROUND);
    line(cr, x, y - s, x, y + s, s * 0.28, colour, alpha);
    line(cr, x - s, y, x + s, y, s * 0.28, colour, alpha);
}

function question(cr, x, y, s, colour, alpha) {
    cr.setLineCap(Cairo.LineCap.ROUND);
    arc(cr, x - 8 * s, x + 8 * s, y, -9 * s, 4.2 * s, colour, alpha);
    line(cr, x + 8 * s, y, x + 7 * s, y + 8 * s, 4.2 * s, colour, alpha);
    line(cr, x + 7 * s, y + 8 * s, x, y + 13 * s, 4.2 * s, colour, alpha);
    line(cr, x, y + 13 * s, x, y + 16 * s, 4.2 * s, colour, alpha);
    circle(cr, x, y + 25 * s, 2.8 * s, colour, alpha);
}

function zee(cr, x, y, s, colour, alpha) {
    cr.setLineCap(Cairo.LineCap.ROUND);
    cr.moveTo(x - s, y - s); cr.lineTo(x + s, y - s); cr.lineTo(x - s, y + s); cr.lineTo(x + s, y + s);
    cr.setLineWidth(s * 0.38);
    rgba(cr, colour, alpha);
    cr.stroke();
}

function waves(cr, x, y, side, t) {
    cr.setLineCap(Cairo.LineCap.ROUND);
    for (let i = 0; i < 3; i++) {
        const r = 11 + i * 10, a = clamp(0.15 + 0.85 * (0.5 + 0.5 * Math.sin(t * 6 - i * 1.1)), 0.12, 1);
        cr.newPath();
        if (side < 0) cr.arc(x, y, r, Math.PI - 0.6, Math.PI + 0.6); else cr.arc(x, y, r, -0.6, 0.6);
        cr.setLineWidth(3.2);
        rgba(cr, ICE, a);
        cr.stroke();
    }
}

/** Draws one frame (from Slime.frame()) into `cr` in a square of `size` pixels with its top left at the origin. */
export function drawSlime(cr, f, size = 240) {
    cr.save();
    cr.scale(size / 240, size / 240);
    cr.setLineCap(Cairo.LineCap.ROUND);
    cr.setLineJoin(Cairo.LineJoin.ROUND);
    const p = f.pose, t = f.t;
    const dim = p.dim, warm = p.warm;
    const light = mix(mix(LIGHT, [255, 190, 170], warm * 0.16), [60, 90, 130], dim);
    const deep = mix(mix(DEEP, [255, 110, 110], warm * 0.22), [40, 70, 120], dim);
    const rim = mix(mix(RIM, RED, warm), [30, 55, 105], dim);
    const cy = f.ground - f.ry, top = cy - f.ry;
    const tr = 10 + 12 * p.tip, tcx = f.cx + p.tipDx, tcy = top - tr * 0.1 - 12 * p.tip + 10;

    // A red glow when it is alert.
    if (warm > 0.05) {
        const pulse = 0.5 + 0.5 * Math.sin(t * 7);
        fillEllipse(cr, 120, BODY.ground - 70, 118, 96, RED, 0.07 * warm * (0.5 + pulse));
        fillEllipse(cr, 120, BODY.ground - 70, 96, 78, RED, 0.07 * warm * (0.5 + pulse));
    }
    // The shadow shrinks as the slime leaves the ground.
    const lift = clamp(f.lift / 70, 0, 1);
    fillEllipse(cr, 120, BODY.ground + 3, (BODY.rx + 8) * (1 - 0.35 * lift), 9 * (1 - 0.4 * lift), SHADOW, 0.55 * (1 - 0.5 * lift));

    // The body: a gradient, a rim that darkens inside the edge, a highlight and two small bubbles within.
    const pts = outline(f, tr, tcx, tcy, cy, top);
    smoothPath(cr, pts);
    const grad = new Cairo.LinearGradient(0, top - tr, 0, f.ground);
    for (let i = 0; i <= 4; i++) {
        const u = i / 4, c = mix(light, deep, Math.pow(u, 1.25));
        grad.addColorStopRGBA(u, c[0] / 255, c[1] / 255, c[2] / 255, 1);
    }
    cr.setSource(grad);
    cr.fillPreserve();
    cr.save();
    cr.clip();
    smoothPath(cr, pts);
    cr.setLineWidth(15);
    rgba(cr, rim, 0.5);
    cr.stroke();
    smoothPath(cr, pts);
    cr.setLineWidth(7);
    rgba(cr, rim, 0.55);
    cr.stroke();
    cr.restore();
    smoothPath(cr, pts);
    cr.setLineWidth(2.2);
    rgba(cr, rim, 0.9);
    cr.stroke();
    const lean = f.shear * 0.6, shine = 1 - dim;
    fillEllipse(cr, f.cx - f.rx * 0.46 + lean, top + f.ry * 0.5, f.rx * 0.2, f.ry * 0.12, [255, 255, 255], 0.55 * shine);
    fillEllipse(cr, f.cx - f.rx * 0.6 + lean * 0.8, top + f.ry * 0.78, f.rx * 0.045, f.ry * 0.045, [255, 255, 255], 0.5 * shine);
    circle(cr, f.cx + f.rx * 0.52, cy + f.ry * 0.5, 4, [255, 255, 255], 0.22 * shine);
    circle(cr, f.cx + f.rx * 0.62, cy + f.ry * 0.28, 2.5, [255, 255, 255], 0.2 * shine);

    // The face sits on the body and moves with it.
    const scaleX = f.rx / BODY.rx, scaleY = f.ry / BODY.ry;
    const faceCy = cy + p.eyeDy * scaleY + f.shear * 0.25, gap = p.eyeGap * scaleX;
    const erx = p.eyeRx * (1 + (scaleX - 1) * 0.4), ery = p.eyeRy * scaleY;
    for (const side of [-1, 1]) {
        const ex = f.cx + f.shear * 0.3 + side * gap + f.gx, ey = faceCy + f.gy;
        const lid = side < 0 ? f.lidL : f.lidR;
        if (f.mood === 'love') {
            heart(cr, ex, ey - 4, 11 + 1.5 * Math.sin(t * 5), PINK, 1);
        } else if (f.arch > 0.5 && f.shut < 0.5) {
            arc(cr, ex - erx * 1.05, ex + erx * 1.05, ey + ery * 0.45, -erx * 0.95, 5.2, INK, 1);
        } else if (f.shut > 0.5 || f.blink > 0.9) {
            line(cr, ex - erx, ey + 2, ex + erx, ey + 2, 4.6, INK, 1);
        } else {
            const h = ery * (1 - 0.93 * f.blink) * (1 - clamp(lid, 0, 1) * 0.95), shift = ery * clamp(lid, 0, 1) * 0.9;
            fillEllipse(cr, ex, ey + shift, erx, Math.max(1.8, h), INK, 1);
            if (h > 5) {
                fillEllipse(cr, ex - erx * 0.32, ey + shift - h * 0.38, erx * 0.34, h * 0.2, [255, 255, 255], 0.95);
                circle(cr, ex + erx * 0.35, ey + shift + h * 0.38, erx * 0.13, [255, 255, 255], 0.6);
            }
        }
        const tilt = p.tilt, brow = side < 0 ? p.browL : p.browR;
        if (Math.abs(tilt) > 0.12) {
            // From the outer end to the inner one (toward the middle): the inner end lower when angry, higher when sad or worried.
            const outer = ex + side * erx * 1.25, inner = ex - side * erx * 1.25;
            line(cr, outer, ey - ery * 1.3 - tilt * 7, inner, ey - ery * 1.3 + tilt * 7, 4.2, INK, 1);
        }
        if (brow > 0.1 && f.mood !== 'love')
            line(cr, ex - erx * 1.1, ey - ery * 1.45 - 3 * brow, ex + erx * 1.1, ey - ery * 1.45 - 7 * brow, 4.2, INK, 1);
        if (p.blush > 0.02) {
            ellipse(cr, ex + side * 15, ey + ery + 9, 10.5, 6.2);
            rgba(cr, PINK, 0.5 * p.blush);
            cr.fill();
        }
    }

    // The mouth.
    const mw = p.mouthHw * (1 + (scaleX - 1) * 0.5);
    const mx = f.cx + f.shear * 0.3 + f.gx * 0.35, my = faceCy + (p.mouthDy + 4) * scaleY + f.gy * 0.3;
    if (f.open > 0.08 && f.mood !== 'love') {
        const h = 3.5 + f.open * 15;
        const w = f.mood === 'listening' ? 6 + f.open * 3 : mw * (0.6 + 0.4 * (1 - f.open * 0.4));
        fillEllipse(cr, mx, my + h * 0.35, w, h, MOUTH, 1);
        if (h > 8)
            fillEllipse(cr, mx, my + h * 0.75, w * 0.6, h * 0.35, TONGUE, 0.9);
    } else {
        arc(cr, mx - mw, mx + mw, my, f.curve * mw * 0.7, 3.6, MOUTH, 1);
    }
    if (f.bubble > 0.02) {
        const r = 3 + f.bubble * 19;
        circle(cr, mx + 14 + r * 0.5, my - 2, r, ICE, 0.5);
        fillEllipse(cr, mx + 14 + r * 0.5 - r * 0.35, my - 2 - r * 0.35, r * 0.22, r * 0.14, [255, 255, 255], 0.75);
    }

    // What the mood adds, above and around.
    switch (f.mood) {
    case 'thinking':
        for (let i = 0; i < 3; i++)
            circle(cr, 176 + i * 15, 40 - Math.max(0, Math.sin(t * 5 - i * 0.9)) * 7, 4.5, ICE, 0.95);
        break;
    case 'listening':
        waves(cr, f.cx - f.rx - 2, cy - 6, -1, t);
        waves(cr, f.cx + f.rx + 2, cy - 6, 1, t);
        break;
    case 'alert': {
        const pulse = 0.75 + 0.25 * Math.sin(t * 9);
        ellipse(cr, 188, 40, 4.8, 12);
        rgba(cr, RED, pulse);
        cr.fill();
        circle(cr, 188, 60, 4.8, RED, pulse);
        break;
    }
    case 'curious':
        question(cr, 182, 16 + Math.sin(t * 3) * 2, 0.8, ICE, 0.95);
        break;
    case 'sleepy':
        for (let i = 0; i < 3; i++) {
            const ph = (t * 0.45 + i * 0.33) % 1;
            zee(cr, 168 + ph * 26, 96 - ph * 66, 4.5 + i * 1.8, ICE, (1 - ph) * 0.9);
        }
        break;
    case 'happy':
        sparkle(cr, 194, 66, 8 + 2 * Math.sin(t * 4), ICE, 0.9);
        sparkle(cr, 48, 82, 5 + 1.5 * Math.sin(t * 4 + 1), ICE, 0.8);
        break;
    case 'searching':
        for (let i = 0; i < 3; i++) {
            const on = (t * 1.3) % 3 > i ? 1 : 0.2, r = 9 + i * 8;
            arc(cr, 120 - r, 120 + r, 56 - r * 0.6, -r * 0.55, 3, AMBER, on);
        }
        circle(cr, 120, 56, 3.2, AMBER, 1);
        break;
    case 'sad':
        if (t % 6 < 2.4) {
            const u = (t % 6) / 2.4;
            fillEllipse(cr, f.cx - gap - 10, faceCy + ery + 4 + u * 36, 3.2, 4.6, ICE, 1 - u);
        }
        break;
    case 'love':
        for (let i = 0; i < 3; i++) {
            const ph = (t * 0.6 + i * 0.33) % 1;
            heart(cr, 70 + i * 50, 70 - ph * 50, 5, PINK, 1 - ph * 0.6);
        }
        break;
    default:
        break;
    }
    cr.restore();
}
