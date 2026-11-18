// The little things around the face that tell how the device is doing, kept few and quiet: a status line at the top (Wi-Fi,
// whether it is listening for "Momo Niro", the battery), and under the face one thing that moves with what is happening (the
// sound it hears, the sound it makes, a shimmer while it thinks, a hint now and then while it is calm). Pure arithmetic and
// drawing, like face.c: it runs on the PC too (test/host/face_preview.c).
#pragma once
#include <stdbool.h>
#include <stdint.h>

#include "face.h"

/** What the status line shows. `battery` 0..100 (255: unknown), `rssi` in dBm (0: no Wi-Fi), `listening` is the microphone being
 * sent for the keyword, `wake` that the device waits for it at all. May be called from any task. */
void hud_status(uint8_t battery, bool charging, int rssi, bool wake, bool listening);
/** How loud the room (or the voice) is, 0..1, as the microphone hears it. */
void hud_level(float level);
/** Moves the animation on by `dt_ms` and draws over a face frame in `mood`. */
void hud_draw(uint16_t *px, int dt_ms, face_mood_t mood, bool has_caption);
