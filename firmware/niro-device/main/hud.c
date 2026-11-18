#include "hud.h"

#include <math.h>
#include <stdio.h>
#include <string.h>

#include "draw.h"

static const rgb_t ICE = {170, 215, 255};
static const rgb_t BLUE = {70, 150, 245};
static const rgb_t GREEN = {60, 215, 120};
static const rgb_t AMBER = {255, 159, 10};
static const rgb_t RED = {255, 69, 58};
static const rgb_t VIOLET = {160, 135, 255};

static volatile uint8_t s_battery = 255;
static volatile bool s_charging, s_wake, s_listening;
static volatile int s_rssi;
static volatile float s_level;

void hud_status(uint8_t battery, bool charging, int rssi, bool wake, bool listening) {
    s_battery = battery;
    s_charging = charging;
    s_rssi = rssi;
    s_wake = wake;
    s_listening = listening;
}

void hud_level(float level) { s_level = level < 0.f ? 0.f : level > 1.f ? 1.f : level; }

static inline float clampf(float v, float lo, float hi) { return v < lo ? lo : v > hi ? hi : v; }

static struct {
    float t;            // seconds, forever
    float level;        // the smoothed sound level
    float ripple;       // seconds since a ripple began; < 0: none
    face_mood_t last;
    float shown;        // 0..1: how much the bottom element is there (it eases in and out)
    float bars[13];
} H = {.ripple = -1.f, .last = FACE_COUNT};

static inline void ring(uint16_t *px, float cx, float cy, float r, float thick, rgb_t col, float alpha) { draw_ring(px, cx, cy, r, thick, col, alpha); }

static void wifi(uint16_t *px, float x, float y, int rssi, float t) {
    int level = rssi == 0 ? 0 : rssi > -55 ? 4 : rssi > -65 ? 3 : rssi > -75 ? 2 : 1;
    for (int i = 0; i < 4; i++) {
        float h = 3.f + i * 2.4f;
        bool on = i < level;
        float a = on ? .85f : .22f;
        if (!level) a = .22f + .25f * (.5f + .5f * sinf(t * 4.f - i * .8f));  // searching: a wave runs up the bars
        draw_round_rect(px, x + i * 4.5f, y - h * .5f, 1.4f, h * .5f, 1.f, level ? (on ? ICE : (rgb_t){90, 110, 140}) : AMBER, a);
    }
}

static void battery(uint16_t *px, float x, float y, uint8_t pct, bool charging, float t) {
    if (pct == 255) return;
    float f = pct / 100.f;
    rgb_t c = pct <= 15 ? RED : pct <= 30 ? AMBER : GREEN;
    float blink = pct <= 15 && !charging ? .55f + .45f * sinf(t * 5.f) : 1.f;
    draw_round_rect(px, x, y, 12.f, 5.5f, 2.f, ICE, .55f);
    draw_round_rect(px, x, y, 10.8f, 4.3f, 1.4f, (rgb_t){0, 0, 0}, 1.f);
    draw_round_rect(px, x + 12.f + 1.6f, y, 1.2f, 2.2f, .8f, ICE, .55f);
    float w = 10.f * f;
    if (w > 1.f) draw_round_rect(px, x - 10.f + w, y, w, 3.2f, 1.f, c, .95f * blink);
    if (charging) {
        // A bright band runs along the fill.
        float at = fmodf(t * 18.f, 26.f) - 4.f;
        draw_round_rect(px, x - 10.f + at, y, 3.f, 3.2f, 1.f, (rgb_t){255, 255, 255}, .38f * (w > 1.f ? 1.f : 0.f) * (at < w * 2.f ? 1.f : 0.f));
    }
    char text[8];
    snprintf(text, sizeof text, "%u%%", pct);
    draw_text(px, (int)(x - 16.f - 6.f * (int)strlen(text)), (int)(y - 3.5f), 1, ICE, .6f, text);
}

void hud_draw(uint16_t *px, int dt_ms, face_mood_t mood, bool has_caption) {
    float dt = clampf(dt_ms / 1000.f, 0.f, .25f);
    H.t += dt;
    if (mood != H.last) {
        // The moods that answer the user with a ripple.
        if (mood == FACE_LISTENING || mood == FACE_HAPPY || mood == FACE_ALERT) H.ripple = 0.f;
        H.last = mood;
    }
    if (H.ripple >= 0.f) {
        H.ripple += dt;
        if (H.ripple > 1.1f) H.ripple = -1.f;
    }
    H.level += (s_level - H.level) * clampf(dt * 12.f, 0.f, 1.f);

    // The status line: quiet, always the same place.
    if (mood != FACE_WAKING) {
        wifi(px, 12.f, 20.f, s_rssi, H.t);
        battery(px, 214.f, 14.f, s_battery, s_charging, H.t);
        if (s_wake) {
            // A small breathing dot: the microphone is being sent to wait for the keyword. Amber while it is not.
            float breath = .5f + .5f * sinf(H.t * 2.2f);
            rgb_t c = s_listening ? VIOLET : AMBER;
            draw_circle(px, 120.f, 14.f, 2.2f + (s_listening ? .8f * breath : 0.f), c, s_listening ? .55f + .4f * breath : .5f);
        }
    }

    // A ripple spreads from the face when it takes notice.
    if (H.ripple >= 0.f) {
        float p = H.ripple / 1.1f, e = 1.f - (1.f - p) * (1.f - p);
        ring(px, 120.f, 120.f, 30.f + 84.f * e, 2.6f, mood == FACE_ALERT ? AMBER : BLUE, .55f * (1.f - p));
        if (p > .25f) {
            float q = (p - .25f) / .75f, eq = 1.f - (1.f - q) * (1.f - q);
            ring(px, 120.f, 120.f, 30.f + 84.f * eq, 2.f, ICE, .35f * (1.f - q));
        }
    }

    // Under the face, one thing that moves with what is going on.
    float y = 224.f;           // the sound bars: where a caption would be
    float ys = 236.f;          // the shimmer: a thin line under it
    bool bars = mood == FACE_LISTENING || mood == FACE_SPEAKING;
    bool shimmer = mood == FACE_THINKING || mood == FACE_SEARCHING;
    bool hint = mood == FACE_IDLE && s_wake && !has_caption;
    float want = (bars || shimmer) ? 1.f : 0.f;
    H.shown += (want - H.shown) * clampf(dt * 9.f, 0.f, 1.f);
    if (bars && H.shown > .02f) {
        for (int i = 0; i < 13; i++) {
            float mid = 1.f - fabsf(i - 6.f) / 7.f;  // the middle rises most
            float target;
            if (mood == FACE_LISTENING) target = .12f + H.level * 1.1f * mid + .06f * (.5f + .5f * sinf(H.t * 7.f + i * .9f));
            else target = .2f + .55f * mid * (.5f + .5f * sinf(H.t * 9.f + i * 1.3f)) * (.6f + .4f * sinf(H.t * 3.1f));
            H.bars[i] += (clampf(target, .08f, 1.f) - H.bars[i]) * clampf(dt * 16.f, 0.f, 1.f);
            float h = 2.f + H.bars[i] * 9.f;
            draw_round_rect(px, 120.f + (i - 6) * 9.f, y, 2.1f, h, 1.6f, mood == FACE_LISTENING ? BLUE : GREEN, .9f * H.shown);
        }
    } else if (shimmer && H.shown > .02f) {
        // A soft light runs along a faint track.
        draw_round_rect(px, 120.f, ys, 40.f, 1.2f, 1.1f, ICE, .18f * H.shown);
        float at = .5f + .5f * sinf(H.t * 3.4f);
        draw_round_rect(px, 80.f + 80.f * at, ys, 9.f, 1.6f, 1.4f, mood == FACE_SEARCHING ? AMBER : ICE, .85f * H.shown);
    } else {
        for (int i = 0; i < 13; i++) H.bars[i] = .1f;
    }
    if (hint) {
        // Now and then, for a few seconds, a hint of what to say; it fades in and out.
        float cycle = fmodf(H.t, 14.f), a = cycle < 3.6f ? sinf(cycle / 3.6f * 3.14159f) : 0.f;
        if (a > .02f) draw_text(px, 120 - (int)(strlen("SAY  MOMO NIRO") * 6 / 2), 224, 1, ICE, .75f * a, "SAY  MOMO NIRO");
    }
}
