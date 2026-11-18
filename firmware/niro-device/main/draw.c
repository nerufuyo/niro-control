#include "draw.h"

#include <math.h>
#include <stdbool.h>
#include <string.h>

#include "font5x7.h"

static inline float clampf(float v, float lo, float hi) { return v < lo ? lo : v > hi ? hi : v; }

/** Blends `colour` into one pixel by `cover` (0..1). */
static inline void blend(uint16_t *px, int x, int y, rgb_t colour, float cover) {
    if (x < 0 || y < 0 || x >= CANVAS_W || y >= CANVAS_H || cover <= 0.f) return;
    uint16_t *p = &px[y * CANVAS_W + x];
    if (cover >= 0.999f) {
        *p = rgb565(colour);
        return;
    }
    uint16_t d = *p;
    int dr = (d >> 8) & 0xF8, dg = (d >> 3) & 0xFC, db = (d << 3) & 0xF8;
    int r = dr + (int)((colour.r - dr) * cover), g = dg + (int)((colour.g - dg) * cover), b = db + (int)((colour.b - db) * cover);
    *p = (uint16_t)(((r & 0xF8) << 8) | ((g & 0xFC) << 3) | (b >> 3));
}

void draw_clear(uint16_t *px, rgb_t colour) {
    uint16_t c = rgb565(colour);
    for (int i = 0; i < CANVAS_W * CANVAS_H; i++) px[i] = c;
}

/** Signed distance to a rounded rectangle: negative inside. */
static inline float sd_round_rect(float x, float y, float hx, float hy, float r) {
    float qx = fabsf(x) - (hx - r), qy = fabsf(y) - (hy - r);
    float ox = qx > 0 ? qx : 0, oy = qy > 0 ? qy : 0;
    return sqrtf(ox * ox + oy * oy) + fminf(fmaxf(qx, qy), 0.f) - r;
}

void draw_round_rect(uint16_t *px, float cx, float cy, float hx, float hy, float r, rgb_t colour, float alpha) {
    if (r > hx) r = hx;
    if (r > hy) r = hy;
    for (int y = (int)(cy - hy - 2); y <= (int)(cy + hy + 2); y++)
        for (int x = (int)(cx - hx - 2); x <= (int)(cx + hx + 2); x++) {
            float d = sd_round_rect(x + .5f - cx, y + .5f - cy, hx, hy, r);
            blend(px, x, y, colour, clampf(.5f - d, 0.f, 1.f) * alpha);
        }
}

void draw_eye(uint16_t *px, float cx, float cy, float hx, float hy, float r, float cut_y, float slope, float circ_x,
              float circ_y, float circ_r, rgb_t colour, float alpha) {
    if (r > hx) r = hx;
    if (r > hy) r = hy;
    float norm = 1.f / sqrtf(1.f + slope * slope);
    for (int y = (int)(cy - hy - 2); y <= (int)(cy + hy + 2); y++)
        for (int x = (int)(cx - hx - 2); x <= (int)(cx + hx + 2); x++) {
            float fx = x + .5f, fy = y + .5f;
            float d = sd_round_rect(fx - cx, fy - cy, hx, hy, r);
            // The cut: what is above the line through (cx, cut_y) is taken away.
            float above = ((fy - cut_y) - slope * (fx - cx)) * norm;  // positive below the line
            d = fmaxf(d, -above);
            if (circ_r > 0.f) {
                float dx = fx - circ_x, dy = fy - circ_y;
                d = fmaxf(d, circ_r - sqrtf(dx * dx + dy * dy));
            }
            blend(px, x, y, colour, clampf(.5f - d, 0.f, 1.f) * alpha);
        }
}

void draw_circle(uint16_t *px, float cx, float cy, float radius, rgb_t colour, float alpha) {
    float inner = radius - 1.f > 0.f ? (radius - 1.f) * (radius - 1.f) : -1.f, outer = (radius + 1.f) * (radius + 1.f);
    for (int y = (int)(cy - radius - 2); y <= (int)(cy + radius + 2); y++)
        for (int x = (int)(cx - radius - 2); x <= (int)(cx + radius + 2); x++) {
            float dx = x + .5f - cx, dy = y + .5f - cy, q = dx * dx + dy * dy;
            if (q > outer) continue;
            blend(px, x, y, colour, (q < inner ? 1.f : clampf(.5f - (sqrtf(q) - radius), 0.f, 1.f)) * alpha);
        }
}

void draw_ring(uint16_t *px, float cx, float cy, float r, float thick, rgb_t colour, float alpha) {
    if (alpha <= 0.f) return;
    float outer = r + thick * .5f, inner = fmaxf(r - thick * .5f, 0.f);
    for (int y = (int)(cy - outer - 1); y <= (int)(cy + outer + 1); y++) {
        if (y < 0 || y >= CANVAS_H) continue;
        float dy = y + .5f - cy, ox2 = (outer + 1.f) * (outer + 1.f) - dy * dy;
        if (ox2 < 0) continue;
        float ox = sqrtf(ox2), ix2 = (inner - 1.f) * (inner - 1.f) - dy * dy, ix = ix2 > 0 && inner > 1.f ? sqrtf(ix2) : 0.f;
        // The two runs of this row that are off the hole.
        for (int side = 0; side < 2; side++) {
            int a = side ? (int)(cx + ix) : (int)(cx - ox) - 1, b = side ? (int)(cx + ox) + 1 : (int)(cx - ix);
            if (ix <= 0.f && side) break;
            if (ix <= 0.f) b = (int)(cx + ox) + 1;
            for (int x = a; x <= b; x++) {
                float dx = x + .5f - cx, d = fabsf(sqrtf(dx * dx + dy * dy) - r) - thick * .5f;
                blend(px, x, y, colour, clampf(.5f - d, 0.f, 1.f) * alpha);
            }
        }
    }
}

void draw_ellipse(uint16_t *px, float cx, float cy, float rx, float ry, rgb_t colour, float alpha) {
    if (rx < .5f || ry < .5f) return;
    float m = fminf(rx, ry), inv_rx = 1.f / rx, inv_ry = 1.f / ry;
    float in_lim = 1.f - 1.f / m, out_lim = 1.f + 1.f / m;
    float in_q = in_lim > 0.f ? in_lim * in_lim : -1.f, out_q = out_lim * out_lim;
    for (int y = (int)(cy - ry - 2); y <= (int)(cy + ry + 2); y++) {
        float dy = (y + .5f - cy) * inv_ry, dy2 = dy * dy;
        for (int x = (int)(cx - rx - 2); x <= (int)(cx + rx + 2); x++) {
            float dx = (x + .5f - cx) * inv_rx, q = dx * dx + dy2;
            if (q > out_q) continue;
            blend(px, x, y, colour, (q < in_q ? 1.f : clampf(.5f - (sqrtf(q) - 1.f) * m, 0.f, 1.f)) * alpha);
        }
    }
}

/** Distance from (x, y) to the segment (x0, y0)-(x1, y1). */
static inline float sd_segment(float x, float y, float x0, float y0, float x1, float y1) {
    float vx = x1 - x0, vy = y1 - y0, wx = x - x0, wy = y - y0;
    float len2 = vx * vx + vy * vy;
    float t = len2 > 0.f ? clampf((wx * vx + wy * vy) / len2, 0.f, 1.f) : 0.f;
    float dx = wx - t * vx, dy = wy - t * vy;
    return sqrtf(dx * dx + dy * dy);
}

void draw_line(uint16_t *px, float x0, float y0, float x1, float y1, float thickness, rgb_t colour, float alpha) {
    float h = thickness * .5f;
    int xa = (int)(fminf(x0, x1) - h - 2), xb = (int)(fmaxf(x0, x1) + h + 2);
    int ya = (int)(fminf(y0, y1) - h - 2), yb = (int)(fmaxf(y0, y1) + h + 2);
    for (int y = ya; y <= yb; y++)
        for (int x = xa; x <= xb; x++)
            blend(px, x, y, colour, clampf(.5f - (sd_segment(x + .5f, y + .5f, x0, y0, x1, y1) - h), 0.f, 1.f) * alpha);
}

void draw_arc_stroke(uint16_t *px, float x0, float x1, float y, float sag, float thickness, rgb_t colour, float alpha) {
    float half = (x1 - x0) * .5f, mx = (x0 + x1) * .5f, h = thickness * .5f;
    if (fabsf(sag) < .75f) {
        draw_line(px, x0, y, x1, y, thickness, colour, alpha);
        return;
    }
    float s = fabsf(sag);
    float radius = (half * half + s * s) / (2.f * s);
    // A smile (sag > 0) is the part of the circle below the chord, the circle's centre above it; a frown mirrors it.
    float dir = sag > 0 ? 1.f : -1.f;
    float cy = y + dir * (s - radius);
    int ya = (int)(fminf(y, y + dir * s) - h - 2), yb = (int)(fmaxf(y, y + dir * s) + h + 2);
    for (int py = ya; py <= yb; py++)
        for (int pxl = (int)(x0 - h - 2); pxl <= (int)(x1 + h + 2); pxl++) {
            float fx = pxl + .5f, fy = py + .5f;
            float dx = fx - mx, dy = fy - cy;
            float len = sqrtf(dx * dx + dy * dy);
            float qy = len > 0.f ? cy + dy * radius / len : cy;
            float d;
            if ((qy - y) * dir >= 0.f) {
                d = fabsf(len - radius);  // its nearest point on the circle is on the arc
            } else {
                float e0 = hypotf(fx - x0, fy - y), e1 = hypotf(fx - x1, fy - y);
                d = fminf(e0, e1);        // otherwise the nearer end
            }
            blend(px, pxl, py, colour, clampf(.5f - (d - h), 0.f, 1.f) * alpha);
        }
}

void draw_text(uint16_t *px, int x, int y, int scale, rgb_t colour, float alpha, const char *text) {
    for (; *text; text++, x += 6 * scale) {
        char ch = *text;
        const uint8_t *cols = (ch >= 32 && ch <= 126) ? FONT5X7[ch - 32] : FONT5X7[0];
        for (int cx = 0; cx < 5; cx++)
            for (int cy = 0; cy < 8; cy++)
                if ((cols[cx] >> cy) & 1)
                    for (int j = 0; j < scale; j++)
                        for (int i = 0; i < scale; i++) blend(px, x + cx * scale + i, y + cy * scale + j, colour, alpha);
    }
}

/** Smooth minimum of two distances: the shapes melt into one. */
static inline float smin(float a, float b, float k) {
    float h = fmaxf(k - fabsf(a - b), 0.f) / k;
    return fminf(a, b) - h * h * k * .25f;
}

static inline rgb_t lerp_rgb(rgb_t a, rgb_t b, float t) {
    t = clampf(t, 0.f, 1.f);
    return (rgb_t){(uint8_t)(a.r + (b.r - a.r) * t), (uint8_t)(a.g + (b.g - a.g) * t), (uint8_t)(a.b + (b.b - a.b) * t)};
}

void draw_slime(uint16_t *px, const slime_t *s) {
    float cy = s->ground - s->ry, top = cy - s->ry;
    float tr = 10.f + 12.f * s->tip;                       // the peak's radius
    float tcy = top - tr * .1f - 12.f * s->tip + 10.f;     // and where it sits
    float tcx = s->cx + s->tip_dx;
    int y0 = (int)(top - 2.f * tr - 6.f), y1 = (int)(s->ground + 3.f);
    int x0 = (int)(s->cx - s->rx - 14.f - fabsf(s->shear)), x1 = (int)(s->cx + s->rx + 14.f + fabsf(s->shear));
    float body_h = 2.f * s->ry + 2.f * tr;
    float m = fminf(s->rx, s->ry);
    // Squares to compare against, so that most pixels need no square root: well inside the body (or the peak) the rim cannot
    // reach, and well outside both nothing is drawn. Only a band along the edge is worked out exactly.
    float in_lim = 1.f - 10.f / m, out_lim = 1.f + 9.f / m;
    float in_q = in_lim > 0.f ? in_lim * in_lim : -1.f, out_q = out_lim * out_lim;
    float tip_in = tr - 10.f > 0.f ? (tr - 10.f) * (tr - 10.f) : -1.f, tip_out = (tr + 9.f) * (tr + 9.f);
    bool has_tip = s->tip > .01f;
    for (int y = y0; y <= y1; y++) {
        if (y < 0 || y >= CANVAS_H) continue;
        float fy = y + .5f;
        float lean = s->shear * clampf((s->ground - fy) / (2.f * s->ry), 0.f, 1.4f);
        float ey = (fy - cy) / s->ry, ey2 = ey * ey, ty = fy - tcy, ty2 = ty * ty;
        float t = clampf((fy - (top - tr)) / body_h, 0.f, 1.f);
        rgb_t base = lerp_rgb(s->light, s->deep, powf(t, 1.25f));        // one colour for the whole row's interior
        uint16_t base565 = rgb565(base);
        float inv_rx = 1.f / s->rx;
        for (int x = x0; x <= x1; x++) {
            if (x < 0 || x >= CANVAS_W) continue;
            float fx = x + .5f;
            float ex = (fx - lean - s->cx) * inv_rx, tx = fx - lean - tcx;
            float qb = ex * ex + ey2, qt = tx * tx + ty2;
            if (qb < in_q || (has_tip && qt < tip_in)) {
                px[y * CANVAS_W + x] = base565;
                continue;
            }
            if (qb > out_q && (!has_tip || qt > tip_out)) continue;
            float d_body = (sqrtf(qb) - 1.f) * m;
            float d = has_tip ? smin(d_body, sqrtf(qt) - tr, 26.f) : d_body;
            float cover = clampf(.5f - d, 0.f, 1.f);
            if (cover <= 0.f) continue;
            float rim = clampf((d + 8.f) / 8.f, 0.f, 1.f);                  // 0 well inside .. 1 on the edge
            blend(px, x, y, lerp_rgb(base, s->outline, rim * rim * .8f), cover);
        }
    }
}
