#include "face.h"

#include <math.h>
#include <string.h>

#include "draw.h"

// ---- Palette: one slime, one accent. ---------------------------------------------------------------------------------
static const rgb_t BODY_LIGHT = {150, 222, 255};
static const rgb_t BODY_DEEP = {52, 146, 240};
static const rgb_t BODY_RIM = {22, 98, 206};
static const rgb_t INK = {14, 24, 44};          // eyes, brows
static const rgb_t MOUTH = {20, 44, 104};
static const rgb_t TONGUE = {255, 120, 150};
static const rgb_t WHITE = {255, 255, 255};
static const rgb_t ICE = {170, 215, 255};
static const rgb_t PINK = {255, 105, 150};
static const rgb_t RED = {255, 69, 58};
static const rgb_t AMBER = {255, 159, 10};
static const rgb_t VIOLET = {160, 135, 255};
static const rgb_t SHADOW = {8, 40, 96};

#define GROUND 208.f
#define BODY_RX 82.f
#define BODY_RY 58.f

// ---- The pose: everything an expression is. --------------------------------------------------------------------------
typedef struct {
    float sq;               // body: + wide and low, - tall and narrow
    float tip;              // 0..1 the peak
    float tip_dx;           // where it leans
    float eye_gap, eye_dy;  // from the middle, and from the body's centre (up is negative)
    float eye_rx, eye_ry;
    float arch;             // 0 oval .. 1 a smiling eye (^)
    float shut;             // 0 open .. 1 a closed line
    float lid;              // 0..1 of the eye taken away from the top
    float tilt;             // brows: -1 sad .. +1 angry
    float brow_l, brow_r;   // a raised brow on one side alone
    float mouth_hw, mouth_dy, curve, open;
    float blush;
    float warm;             // 0..1 flushed toward red
    float dim;              // 0..1 duller
} pose_t;

static pose_t pose_for(face_mood_t m) {
    pose_t p = {.tip = .75f, .eye_gap = 30, .eye_dy = -4, .eye_rx = 9.5f, .eye_ry = 13.5f, .mouth_hw = 8, .mouth_dy = 24, .curve = .55f};
    switch (m) {
    case FACE_IDLE: break;
    case FACE_HAPPY:
        p.sq = .05f; p.arch = 1; p.eye_rx = 11; p.mouth_hw = 19; p.curve = 1.1f; p.open = 0; p.blush = 1; p.mouth_dy = 23; p.tip = 1.f;
        break;
    case FACE_LISTENING:
        p.sq = -.1f; p.eye_rx = 11.5f; p.eye_ry = 17.f; p.eye_dy = -6; p.mouth_hw = 6; p.curve = 0; p.open = .45f; p.mouth_dy = 26; p.tip = 1.f;
        break;
    case FACE_THINKING:
        p.eye_ry = 12; p.lid = .1f; p.mouth_hw = 7; p.curve = -.1f; p.brow_l = .8f; p.tip_dx = 9; p.mouth_dy = 25;
        break;
    case FACE_SPEAKING:
        p.mouth_hw = 13; p.curve = .3f; p.open = .3f; p.eye_rx = 10; p.tip = .85f;
        break;
    case FACE_ALERT:
        p.sq = -.16f; p.eye_rx = 12; p.eye_ry = 18; p.eye_dy = -8; p.tilt = -.4f; p.mouth_hw = 11; p.curve = -.7f; p.open = .25f; p.mouth_dy = 28;
        p.warm = 1.f; p.tip = 1.f;
        break;
    case FACE_WAKING:
        p.sq = .04f; p.shut = 1; p.curve = .1f; p.tip = .55f; p.dim = .12f; p.mouth_hw = 6;
        break;
    case FACE_SEARCHING:
        p.eye_ry = 12.5f; p.mouth_hw = 6; p.curve = -.15f; p.tip = .6f; p.mouth_dy = 25; p.dim = .1f;
        break;
    case FACE_CURIOUS:
        p.tip_dx = -10; p.brow_r = .9f; p.tilt = -.1f; p.mouth_hw = 7; p.curve = .5f; p.eye_ry = 14.5f; p.tip = 1.f;
        break;
    case FACE_SLEEPY:
        p.sq = .03f; p.shut = 1; p.mouth_hw = 5; p.curve = 0; p.tip = .5f; p.dim = .15f; p.eye_dy = 1;
        break;
    case FACE_SAD:
        p.sq = .04f; p.eye_ry = 12.5f; p.tilt = -.85f; p.mouth_hw = 9; p.curve = -.6f; p.mouth_dy = 26; p.tip = .5f; p.tip_dx = -3; p.dim = .12f; p.eye_dy = 1;
        break;
    case FACE_LOVE:
        p.sq = .03f; p.blush = 1; p.mouth_hw = 15; p.curve = 1.f; p.mouth_dy = 23; p.tip = 1.f;
        break;
    default: break;
    }
    return p;
}

// ---- The animation state. ---------------------------------------------------------------------------------------------
static struct {
    face_mood_t mood;
    pose_t pose, target;
    float t, mood_age, idle_age;
    float sq, sqv;              // the body's spring
    float hy, hv;               // a hop: height and speed
    float hop_wait;             // seconds to the next hop in a hopping mood
    float shear;                // a sway
    float blink, blink_phase, next_blink;
    int double_blink;
    float gx, gy, gtx, gty, next_look;
    float talk;
    int act;                    // 0 none, 1 yawn, 2 wink left, 3 wink right, 4 look around, 5 grin, 6 bubble, 7 sway
    float act_t, act_len, next_act;
    float bubble;               // a bubble at the mouth, 0..1 grown
    float shiver;
    uint32_t rng;
} F;

static void launch(float v);

static float rnd(void) {
    F.rng ^= F.rng << 13; F.rng ^= F.rng >> 17; F.rng ^= F.rng << 5;
    return (F.rng & 0xFFFFFF) / (float)0x1000000;
}
static float between(float a, float b) { return a + (b - a) * rnd(); }
static float clampf(float v, float lo, float hi) { return v < lo ? lo : v > hi ? hi : v; }

void face_init(uint32_t seed) {
    memset(&F, 0, sizeof F);
    F.rng = seed ? seed : 2463534242u;
    F.mood = FACE_WAKING;
    F.target = F.pose = pose_for(FACE_WAKING);
    F.sq = F.pose.sq;
    F.blink_phase = -1; F.next_blink = 2.5f; F.next_look = 1.5f; F.next_act = 12.f;
}

face_mood_t face_get(void) { return F.mood; }

float face_act(int act) {
    if (F.mood != FACE_IDLE || act < 1 || act > 7) return 0.f;
    F.act = act;
    F.act_t = 0;
    F.act_len = act == 1 ? 2.8f : act == 4 ? 2.6f : act == 5 ? 1.8f : act == 6 ? 3.2f : act == 7 ? 2.4f : 1.1f;
    if (act == 5) launch(210.f);
    return F.act_len;
}

/** The body is knocked a little: the spring is struck. */
static void jolt(float v) { F.sqv += v; }

void face_set(face_mood_t mood) {
    if (mood >= FACE_COUNT) return;
    if (mood != F.mood) {
        F.mood_age = 0;
        jolt(mood == FACE_ALERT ? -7.f : mood == FACE_HAPPY ? 5.f : 3.f);
    }
    F.mood = mood;
    F.target = pose_for(mood);
    F.idle_age = 0;
    F.act = 0;
    F.hop_wait = .2f;
}

void face_poke(void) {
    F.idle_age = 0;
    if (F.mood == FACE_SLEEPY) face_set(FACE_IDLE);
}

static void ease(float *cur, float to, float k) { *cur += (to - *cur) * k; }

static void ease_pose(pose_t *c, const pose_t *t, float k) {
    float *a = (float *)c; const float *b = (const float *)t;
    for (size_t i = 0; i < sizeof(pose_t) / sizeof(float); i++) ease(&a[i], b[i], k);
}

static void launch(float v) {
    if (F.hy <= .5f) F.hv = v;
}

static void steer_gaze(float dt) {
    F.next_look -= dt;
    switch (F.mood) {
    case FACE_THINKING: F.gtx = -5; F.gty = -9; break;
    case FACE_LISTENING: case FACE_ALERT: F.gtx = 0; F.gty = 0; break;
    case FACE_SEARCHING: F.gtx = 12 * sinf(F.mood_age * 1.9f); F.gty = -1; break;
    case FACE_SLEEPY: case FACE_WAKING: F.gtx = 0; F.gty = 0; break;
    case FACE_SAD: F.gtx = 0; F.gty = 4; break;
    default:
        if (F.next_look <= 0) {
            float r = rnd();
            if (r < .3f) { F.gtx = 0; F.gty = 0; }
            else if (r < .8f) { F.gtx = between(-11, 11); F.gty = between(-2, 3); }
            else { F.gtx = between(-6, 6); F.gty = between(-8, -3); }
            F.next_look = between(.8f, 3.2f);
        }
    }
}

void face_step(int dt_ms) {
    float dt = dt_ms / 1000.f;
    if (dt <= 0.f) return;
    if (dt > .1f) dt = .1f;
    F.t += dt; F.mood_age += dt; F.idle_age += dt;
    ease_pose(&F.pose, &F.target, 1.f - expf(-dt * 8.f));
    steer_gaze(dt);
    ease(&F.gx, F.gtx, 1.f - expf(-dt * (F.mood == FACE_SEARCHING ? 16.f : 10.f)));
    ease(&F.gy, F.gty, 1.f - expf(-dt * 10.f));

    // Hops: a happy slime keeps bouncing, a loving one bobs, the rest hop for a reason.
    if (F.mood == FACE_HAPPY || F.mood == FACE_LOVE) {
        F.hop_wait -= dt;
        if (F.hop_wait <= 0 && F.hy <= .5f) { launch(F.mood == FACE_HAPPY ? 270.f : 170.f); F.hop_wait = F.mood == FACE_HAPPY ? 1.05f : 1.4f; }
    }
    float launched_v = F.hv;
    F.hv -= 900.f * dt;
    F.hy += F.hv * dt;
    if (F.hy <= 0.f) {
        if (launched_v < -40.f) jolt(-fminf(7.5f, -launched_v / 60.f));   // landing: squash flat (the spring's rest is below, so push down)
        F.hy = 0.f; if (F.hv < 0) F.hv = 0;
    }

    // The body's spring: it rests on the pose's squash, stretches going up and wobbles after a knock.
    float rest = F.pose.sq - .15f * clampf(fabsf(F.hv) / 300.f, 0.f, 1.f) * (F.hy > .5f ? 1.f : 0.f);
    if (F.mood == FACE_SPEAKING) rest += .035f * sinf(F.talk * 1.0f);
    float stiff = 140.f, damp = 9.f;
    F.sqv += (-stiff * (F.sq - rest) - damp * F.sqv) * dt;
    F.sq += F.sqv * dt;
    F.sq = clampf(F.sq, -.35f, .32f);
    F.shiver = F.mood == FACE_ALERT ? sinf(F.t * 38.f) * 1.8f : 0.f;

    // Blinks.
    if (F.blink_phase < 0) {
        F.next_blink -= dt;
        if (F.next_blink <= 0 && F.pose.shut < .5f && F.mood != FACE_LOVE) F.blink_phase = 0;
    } else {
        F.blink_phase += dt / .15f;
        F.blink = F.blink_phase < .5f ? F.blink_phase * 2.f : fmaxf(0.f, 2.f - F.blink_phase * 2.f);
        if (F.blink_phase >= 1.f) {
            F.blink = 0; F.blink_phase = -1;
            if (F.double_blink) { F.double_blink = 0; F.next_blink = between(1.8f, 5.f); }
            else { F.double_blink = rnd() < .2f; F.next_blink = F.double_blink ? .08f : between(1.6f, 5.2f); }
        }
    }
    if (F.mood == FACE_SPEAKING) F.talk += dt * 11.f;

    // Idle acts.
    if (F.mood == FACE_IDLE) {
        if (F.act == 0) {
            F.next_act -= dt;
            if (F.next_act <= 0) {
                float r = rnd();
                F.act = r < .2f ? 1 : r < .35f ? 2 : r < .45f ? 3 : r < .6f ? 4 : r < .72f ? 5 : r < .84f ? 6 : 7;
                F.act_t = 0;
                F.act_len = F.act == 1 ? 2.8f : F.act == 4 ? 2.6f : F.act == 5 ? 1.8f : F.act == 6 ? 3.2f : F.act == 7 ? 2.4f : 1.1f;
                F.next_act = between(8.f, 20.f);
                if (F.act == 5) launch(210.f);             // a grin comes with a little hop
            }
        } else {
            F.act_t += dt;
            if (F.act_t >= F.act_len) { F.act = 0; F.bubble = 0; }
        }
        if (F.idle_age > 90.f) face_set(FACE_SLEEPY);
    } else {
        F.act = 0; F.bubble = 0;
    }
    // A sway: the top leans one way and the other, in an idle act and a little when curious.
    float sway = 0.f;
    if (F.act == 7) sway = 15.f * sinf(F.act_t / F.act_len * 6.2832f * 2.f) * sinf(F.act_t / F.act_len * 3.1416f);
    if (F.mood == FACE_CURIOUS) sway = 5.f * sinf(F.t * 1.6f);
    if (F.mood == FACE_SEARCHING) sway = 4.f * sinf(F.mood_age * 1.9f);
    ease(&F.shear, sway, 1.f - expf(-dt * 12.f));
    // A bubble at the mouth: blown up and popped.
    if (F.mood == FACE_SLEEPY) F.bubble = .5f + .5f * sinf(F.t * .9f);
    else if (F.act == 6) { float u = F.act_t / F.act_len; F.bubble = u < .8f ? u / .8f : 0.f; }
}

// ---- Drawing ----------------------------------------------------------------------------------------------------------
static rgb_t mixc(rgb_t a, rgb_t b, float t) {
    t = clampf(t, 0.f, 1.f);
    return (rgb_t){(uint8_t)(a.r + (b.r - a.r) * t), (uint8_t)(a.g + (b.g - a.g) * t), (uint8_t)(a.b + (b.b - a.b) * t)};
}

static void heart(uint16_t *px, float cx, float cy, float s, rgb_t c, float a) {
    draw_circle(px, cx - s * .5f, cy - s * .25f, s * .56f, c, a);
    draw_circle(px, cx + s * .5f, cy - s * .25f, s * .56f, c, a);
    draw_line(px, cx - s * .9f, cy + s * .05f, cx, cy + s * 1.1f, s * .42f, c, a);
    draw_line(px, cx + s * .9f, cy + s * .05f, cx, cy + s * 1.1f, s * .42f, c, a);
}

static void sparkle(uint16_t *px, float cx, float cy, float s, rgb_t c, float a) {
    draw_line(px, cx, cy - s, cx, cy + s, s * .28f, c, a);
    draw_line(px, cx - s, cy, cx + s, cy, s * .28f, c, a);
}

static void question(uint16_t *px, float x, float y, float s, rgb_t c, float a) {
    draw_arc_stroke(px, x - 8 * s, x + 8 * s, y, -9 * s, 4.2f * s, c, a);
    draw_line(px, x + 8 * s, y, x + 7 * s, y + 8 * s, 4.2f * s, c, a);
    draw_line(px, x + 7 * s, y + 8 * s, x, y + 13 * s, 4.2f * s, c, a);
    draw_line(px, x, y + 13 * s, x, y + 16 * s, 4.2f * s, c, a);
    draw_circle(px, x, y + 25 * s, 2.8f * s, c, a);
}

static void zee(uint16_t *px, float x, float y, float s, rgb_t c, float a) {
    draw_line(px, x - s, y - s, x + s, y - s, s * .38f, c, a);
    draw_line(px, x + s, y - s, x - s, y + s, s * .38f, c, a);
    draw_line(px, x - s, y + s, x + s, y + s, s * .38f, c, a);
}

/** Sound waves on one side of the body: arcs of a circle, brighter as the wave goes out. */
static void waves(uint16_t *px, float x, float y, int side, float t) {
    for (int i = 0; i < 3; i++) {
        float r = 11.f + i * 10.f, a = clampf(.15f + .85f * (.5f + .5f * sinf(t * 6.f - i * 1.1f)), .12f, 1.f);
        for (int k = -3; k < 3; k++) {
            float a0 = k * .2f, a1 = (k + 1) * .2f;
            draw_line(px, x + side * r * cosf(a0), y + r * sinf(a0), x + side * r * cosf(a1), y + r * sinf(a1), 3.2f, ICE, a);
        }
    }
}

void face_draw(uint16_t *px) {
    draw_clear(px, (rgb_t){0, 0, 0});
    const pose_t *p = &F.pose;

    // Idle acts bend the pose a little on top of it.
    float shut = p->shut, arch = p->arch, curve = p->curve, open = p->open, lid_l = p->lid + p->brow_l * .0f, lid_r = p->lid;
    float act = F.act ? sinf(clampf(F.act_t / F.act_len, 0.f, 1.f) * 3.14159f) : 0.f;
    float gx = F.gx, gy = F.gy;
    if (F.act == 1) { shut = fmaxf(shut, act); open = fmaxf(open, .9f * act); curve = 0; }                       // a yawn
    if (F.act == 2) { lid_l = 1.f * act; arch = fmaxf(arch, .8f * act); curve = fmaxf(curve, .9f * act); }       // a wink
    if (F.act == 3) { lid_r = 1.f * act; arch = fmaxf(arch, .8f * act); curve = fmaxf(curve, .9f * act); }
    if (F.act == 4) { gx = 12 * sinf(F.act_t / F.act_len * 6.2832f); gy = -1; }                                    // a look around
    if (F.act == 5) { curve = 1.2f; arch = fmaxf(arch, .85f * act); }               // a grin
    if (F.mood == FACE_SPEAKING) open = p->open + .6f * fabsf(sinf(F.talk)) * (.6f + .4f * sinf(F.talk * .37f));

    // The body.
    float sq = F.sq;
    float rx = BODY_RX * (1.f + sq), ry = BODY_RY / (1.f + sq * .85f);
    float ground = GROUND - F.hy;
    float cx = 120.f + F.shiver;
    float cy = ground - ry, top = cy - ry;
    float scale_x = rx / BODY_RX;

    // An alert glows red around the slime, pulsing.
    if (p->warm > .05f) {
        float pulse = .5f + .5f * sinf(F.t * 7.f);
        draw_ellipse(px, 120.f, GROUND - 70.f, 118.f, 96.f, RED, .07f * p->warm * (.5f + pulse));
        draw_ellipse(px, 120.f, GROUND - 70.f, 96.f, 78.f, RED, .07f * p->warm * (.5f + pulse));
    }

    // A shadow that shrinks as the slime leaves the ground.
    float lift = clampf(F.hy / 70.f, 0.f, 1.f);
    draw_ellipse(px, 120, GROUND + 3, (BODY_RX + 8) * (1.f - .35f * lift), 9.f * (1.f - .4f * lift), SHADOW, .55f * (1.f - .5f * lift));

    float dim = p->dim, warm = p->warm;
    slime_t body = {.cx = cx, .ground = ground, .rx = rx, .ry = ry, .tip = p->tip, .tip_dx = p->tip_dx, .shear = F.shear,
                    .light = mixc(mixc(BODY_LIGHT, (rgb_t){255, 190, 170}, warm * .3f), (rgb_t){60, 90, 130}, dim),
                    .deep = mixc(mixc(BODY_DEEP, (rgb_t){255, 110, 110}, warm * .35f), (rgb_t){40, 70, 120}, dim),
                    .outline = mixc(mixc(BODY_RIM, RED, warm), (rgb_t){30, 55, 105}, dim)};
    draw_slime(px, &body);

    // Shine: a soft highlight and two small bubbles inside.
    float lean_top = F.shear * .6f;
    draw_ellipse(px, cx - rx * .46f + lean_top, top + ry * .5f, rx * .2f, ry * .12f, WHITE, .55f * (1.f - dim));
    draw_ellipse(px, cx - rx * .6f + lean_top * .8f, top + ry * .78f, rx * .045f, ry * .045f, WHITE, .5f * (1.f - dim));
    draw_circle(px, cx + rx * .52f, cy + ry * .5f, 4.f, WHITE, .22f * (1.f - dim));
    draw_circle(px, cx + rx * .62f, cy + ry * .28f, 2.5f, WHITE, .2f * (1.f - dim));

    // The face sits on the body and moves with it: its spacing follows the width, its height the squash.
    float face_cy = cy + p->eye_dy * (ry / BODY_RY) + F.shear * .25f;
    float gap = p->eye_gap * scale_x;
    float erx = p->eye_rx * (1.f + (scale_x - 1.f) * .4f), ery = p->eye_ry * (ry / BODY_RY);
    float blink = F.blink;

    for (int side = -1; side <= 1; side += 2) {
        float ex = cx + F.shear * .3f + side * gap + gx, ey = face_cy + gy;
        float lid = side < 0 ? lid_l : lid_r;
        float sh = fmaxf(shut, 0.f);
        if (F.mood == FACE_LOVE) {
            heart(px, ex, ey - 4, 11.f + 1.5f * sinf(F.t * 5.f), PINK, 1.f);
        } else if (arch > .5f && sh < .5f) {
            // A smiling eye: an arch.
            draw_arc_stroke(px, ex - erx * 1.05f, ex + erx * 1.05f, ey + ery * .45f, -erx * .95f, 5.2f, INK, 1.f);
        } else if (sh > .5f || blink > .9f) {
            draw_line(px, ex - erx, ey + 2, ex + erx, ey + 2, 4.6f, INK, 1.f);   // a closed eye
        } else {
            float h = ery * (1.f - .93f * blink) * (1.f - clampf(lid + (side < 0 ? 0.f : 0.f), 0.f, 1.f) * .95f);
            float shift = ery * clampf(lid, 0.f, 1.f) * .9f;                       // an eye that is half shut sinks
            draw_ellipse(px, ex, ey + shift, erx, fmaxf(1.8f, h), INK, 1.f);
            if (h > 5.f) {
                draw_ellipse(px, ex - erx * .32f, ey + shift - h * .38f, erx * .34f, h * .2f, WHITE, .95f);   // the shine in the eye
                draw_circle(px, ex + erx * .35f, ey + shift + h * .38f, erx * .13f, WHITE, .6f);
            }
        }
        // Brows: angry down at the middle, sad down at the sides; one raised alone for a thinking or curious look.
        float tilt = p->tilt, br = side < 0 ? p->brow_l : p->brow_r;
        if (fabsf(tilt) > .12f) {
            float in_y = ey - ery * 1.3f + tilt * 7.f, out_y = ey - ery * 1.3f - tilt * 7.f;
            float inner = -side * 1.f;   // toward the middle
            draw_line(px, ex + inner * (-erx * 1.25f) * -1.f, in_y, ex - inner * erx * 1.25f, out_y, 4.2f, INK, 1.f);
        }
        if (br > .1f && F.mood != FACE_LOVE) draw_line(px, ex - erx * 1.1f, ey - ery * 1.45f - 3.f * br, ex + erx * 1.1f, ey - ery * 1.45f - 7.f * br, 4.2f, INK, 1.f);
        // Blush.
        if (p->blush > .02f) draw_ellipse(px, ex + side * 15.f, ey + ery + 9.f, 10.5f, 6.2f, PINK, .5f * p->blush);
    }

    // The mouth.
    float mw = p->mouth_hw * (1.f + (scale_x - 1.f) * .5f);
    float mx = cx + F.shear * .3f + gx * .35f, my = face_cy + (p->mouth_dy + 4.f) * (ry / BODY_RY) + gy * .3f;
    if (open > .08f && F.mood != FACE_LOVE) {
        float h = 3.5f + open * 15.f, w = mw * (.6f + .4f * (1.f - open * .4f));
        if (F.mood == FACE_LISTENING) w = 6.f + open * 3.f;
        draw_ellipse(px, mx, my + h * .35f, w, h, MOUTH, 1.f);
        if (h > 8.f) draw_ellipse(px, mx, my + h * .75f, w * .6f, h * .35f, TONGUE, .9f);
    } else {
        draw_arc_stroke(px, mx - mw, mx + mw, my, curve * mw * .7f, 3.6f, MOUTH, 1.f);
    }
    // A bubble at the mouth.
    if (F.bubble > .02f) {
        float r = 3.f + F.bubble * 19.f;
        draw_circle(px, mx + 14.f + r * .5f, my - 2.f, r, ICE, .5f);
        draw_ellipse(px, mx + 14.f + r * .5f - r * .35f, my - 2.f - r * .35f, r * .22f, r * .14f, WHITE, .75f);
    }

    // What the mood adds, above and around the slime.
    switch (F.mood) {
    case FACE_THINKING:
        for (int i = 0; i < 3; i++) draw_circle(px, 176 + i * 15, 40 - fmaxf(0.f, sinf(F.t * 5.f - i * .9f)) * 7.f, 4.5f, ICE, .95f);
        break;
    case FACE_LISTENING:
        waves(px, cx - rx - 2.f, cy - 6.f, -1, F.t);
        waves(px, cx + rx + 2.f, cy - 6.f, 1, F.t);
        break;
    case FACE_ALERT: {
        float pulse = .75f + .25f * sinf(F.t * 9.f);
        draw_round_rect(px, 120, 28, 4.8f, 12.f, 3.f, RED, pulse);
        draw_circle(px, 120, 52, 4.8f, RED, pulse);
        break;
    }
    case FACE_CURIOUS:
        question(px, 182, 16 + sinf(F.t * 3.f) * 2.f, .8f, ICE, .95f);
        break;
    case FACE_SLEEPY:
        for (int i = 0; i < 3; i++) {
            float ph = fmodf(F.t * .45f + i * .33f, 1.f);
            zee(px, 168 + ph * 26, 96 - ph * 66, 4.5f + i * 1.8f, ICE, (1.f - ph) * .9f);
        }
        break;
    case FACE_HAPPY:
        sparkle(px, 194, 66, 8.f + 2.f * sinf(F.t * 4.f), ICE, .9f);
        sparkle(px, 48, 82, 5.f + 1.5f * sinf(F.t * 4.f + 1.f), ICE, .8f);
        break;
    case FACE_SEARCHING:
        for (int i = 0; i < 3; i++) {
            float on = fmodf(F.t * 1.3f, 3.f) > i ? 1.f : .2f, r = 9.f + i * 8.f;
            draw_arc_stroke(px, 120 - r, 120 + r, 38 - r * .6f + 18, -r * .55f, 3.f, AMBER, on);
        }
        draw_circle(px, 120, 56, 3.2f, AMBER, 1.f);
        break;
    case FACE_SAD:
        if (fmodf(F.t, 6.f) < 2.4f) {
            float f = fmodf(F.t, 6.f) / 2.4f;
            draw_ellipse(px, cx - gap - 10, face_cy + ery + 4 + f * 36, 3.2f, 4.6f, ICE, 1.f - f);
        }
        break;
    case FACE_LOVE:
        for (int i = 0; i < 3; i++) {
            float ph = fmodf(F.t * .6f + i * .33f, 1.f);
            heart(px, 70 + i * 50, 70 - ph * 50, 5.f, PINK, 1.f - ph * .6f);
        }
        break;
    default: break;
    }
    (void)VIOLET;
}

const char *face_name(face_mood_t m) {
    static const char *names[FACE_COUNT] = {"idle", "happy", "listening", "thinking", "speaking", "alert", "waking", "searching",
                                            "curious", "sleepy", "sad", "love"};
    return m < FACE_COUNT ? names[m] : "?";
}

int face_from_name(const char *name) {
    for (int i = 0; i < FACE_COUNT; i++)
        if (!strcmp(name, face_name((face_mood_t)i))) return i;
    return -1;
}
