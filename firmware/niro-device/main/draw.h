// Drawing into a 240 x 240 RGB565 buffer, anti-aliased: every shape is a signed distance field, and the pixels on its edge
// are blended by how much of them it covers. Used by the face and tested on the PC (test/host/face_preview.c).
#pragma once
#include <stdint.h>

#define CANVAS_W 240
#define CANVAS_H 240

typedef struct { uint8_t r, g, b; } rgb_t;

static inline uint16_t rgb565(rgb_t c) { return (uint16_t)(((c.r & 0xF8) << 8) | ((c.g & 0xFC) << 3) | (c.b >> 3)); }

/** Clears to one colour. */
void draw_clear(uint16_t *px, rgb_t colour);
/** A rounded rectangle centred at (cx, cy) with half sizes hx, hy, and corner radius r. `alpha` 0..1 */
void draw_round_rect(uint16_t *px, float cx, float cy, float hx, float hy, float r, rgb_t colour, float alpha);
/** An eye: a rounded rectangle from which a lid (a horizontal cut from the top), a tilted cut (`slope`, y per x, the cut
 * line passing through (cx, top_cut)) and a circle (a cheek pushing up from below) are taken away. `circle_r` 0 for none. */
void draw_eye(uint16_t *px, float cx, float cy, float hx, float hy, float r, float cut_y, float slope, float circ_x,
              float circ_y, float circ_r, rgb_t colour, float alpha);
/** A filled circle. */
void draw_circle(uint16_t *px, float cx, float cy, float radius, rgb_t colour, float alpha);
/** A ring of the given radius (to the middle of its stroke) and thickness. */
void draw_ring(uint16_t *px, float cx, float cy, float r, float thick, rgb_t colour, float alpha);
/** A filled ellipse. */
void draw_ellipse(uint16_t *px, float cx, float cy, float rx, float ry, rgb_t colour, float alpha);
/** A stroke along a circular arc bulging down (`sag` > 0, a smile) or up (< 0) over the chord from (x0, y) to (x1, y), `sag`
 * pixels deep in the middle; round ends. A chord with no sag is a line. */
void draw_arc_stroke(uint16_t *px, float x0, float x1, float y, float sag, float thickness, rgb_t colour, float alpha);
/** A thick line with round ends. */
void draw_line(uint16_t *px, float x0, float y0, float x1, float y1, float thickness, rgb_t colour, float alpha);
/** Text from the 5x7 font, `scale` pixels a dot, its top left at (x, y); blended by `alpha`. */
void draw_text(uint16_t *px, int x, int y, int scale, rgb_t colour, float alpha, const char *text);

typedef struct {
    float cx, ground;      // the middle of the body, and the line it sits on
    float rx, ry;          // half width and half height of the mound
    float tip;             // 0..1: the peak on top
    float tip_dx;          // where the peak leans
    float shear;           // the top leans by this many pixels (a sway)
    rgb_t light, deep, outline;
} slime_t;

/** A jelly body: a mound with a soft peak, lighter on top and deeper below, a darker rim; the edge anti-aliased. */
void draw_slime(uint16_t *px, const slime_t *s);
