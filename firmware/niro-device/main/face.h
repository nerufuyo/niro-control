// Niro, a little slime: a soft blue jelly that sits on the ground, with two shiny eyes and a small mouth. An expression is a
// pose, a few numbers; the body is a spring, so it squashes, stretches and wobbles, and the face eases toward each pose, blinks,
// looks about and now and then does something of its own (a hop, a sway, a yawn, a wink, a bubble), so it is never still and
// never the same. Pure arithmetic and drawing: it runs on the PC too (test/host/face_preview.c).
#pragma once
#include <stdint.h>

typedef enum {
    FACE_IDLE,       // calm; blinks, looks about, now and then hops, sways, yawns, winks or blows a bubble
    FACE_HAPPY,      // smiling eyes, a wide smile, a blush, hops, sparkles
    FACE_LISTENING,  // taller, eyes wide, a small round mouth, sound arcs
    FACE_THINKING,   // looks up and away, a brow, three dots
    FACE_SPEAKING,   // the mouth opens and closes
    FACE_ALERT,      // tall and flushed, wide eyes, a shiver, an exclamation mark
    FACE_WAKING,     // rises from a puddle and opens its eyes (boot)
    FACE_SEARCHING,  // looks left and right, a signal that fills in (no network)
    FACE_CURIOUS,    // one brow up, a small smile, a question mark (not paired)
    FACE_SLEEPY,     // melts low, eyes shut, a bubble at the nose, Zs
    FACE_SAD,        // droops, brows up, a tear (offline)
    FACE_LOVE,       // hearts for eyes
    FACE_COUNT
} face_mood_t;

void face_init(uint32_t seed);
/** Changes the expression; the face eases there. */
void face_set(face_mood_t mood);
face_mood_t face_get(void);
/** Something happened: a sleepy face wakes, and the idle clock starts over. */
void face_poke(void);
/** Starts an idle act now: 1 yawn, 2 wink left, 3 wink right, 4 look around, 5 grin, 6 bubble, 7 sway. For previews and tests; in the
 * idle mood only. Returns how long it lasts, in seconds. */
float face_act(int act);
/** Moves the animation on by `dt_ms`. */
void face_step(int dt_ms);
/** Draws the face into a 240 x 240 RGB565 buffer (the pixels in native order). */
void face_draw(uint16_t *px);

const char *face_name(face_mood_t mood);
/** The mood a protocol name means ("idle", "happy", ...), or -1. */
int face_from_name(const char *name);
