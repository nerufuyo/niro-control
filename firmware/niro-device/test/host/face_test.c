// The face, every mood, many seeds, a minute of animation each, in a buffer with guard words on both sides: a pixel written
// out of the canvas, or a mood that draws almost nothing, fails it. (Run it under -fsanitize=address,undefined too where the
// runtimes are installed; they are not on every machine, and this checks what it can without them.)
//   gcc -O1 -g -o face_test face_test.c ../../main/face.c ../../main/draw.c -I../../main -lm && ./face_test
#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "face.h"

#define W 240
#define H 240

static int lit(const uint16_t *px) {
    int n = 0;
    for (int i = 0; i < W * H; i++) n += px[i] != 0;
    return n;
}

int main(void) {
    // Guard words on both sides of the canvas catch a write that strays out of it.
    static uint16_t arena[W * H + 2 * 64];
    uint16_t *canvas = arena + 64;
    int failures = 0, frames = 0;
    for (int m = 0; m < FACE_COUNT; m++) {
        if (face_from_name(face_name((face_mood_t)m)) != m) { printf("name round trip failed for %d\n", m); failures++; }
        for (uint32_t seed = 1; seed <= 6; seed++) {
            memset(arena, 0xA5, sizeof arena);
            face_init(seed * 7919u);
            face_set((face_mood_t)m);
            for (int step = 0; step < 1800; step++) {          // a minute at 30 frames a second
                if (step % 400 == 199) face_poke();
                face_step(33);
                if (step % 6 == 0) {                           // the drawing is the costly part: every sixth frame
                    face_draw(canvas);
                    frames++;
                    int guard = 0;
                    for (int i = 0; i < 64; i++) guard += arena[i] != 0xA5A5 || arena[64 + W * H + i] != 0xA5A5;
                    if (guard) { printf("mood %d seed %u step %d: a write strayed out of the canvas\n", m, seed, step); failures++; }
                    int n = lit(canvas);
                    if (n < 3000) { printf("mood %d seed %u step %d: almost nothing drawn (%d)\n", m, seed, step, n); failures++; }
                }
            }
        }
    }
    face_set(FACE_COUNT);                                      // out of range: refused, not stored
    if (face_get() >= FACE_COUNT) { printf("an out of range mood was stored\n"); failures++; }
    if (face_from_name("nope") != -1 || face_from_name("") != -1) { printf("an unknown name was accepted\n"); failures++; }
    printf("%d frames over %d moods: %s\n", frames, FACE_COUNT, failures ? "FAILED" : "ok");
    return failures ? 1 : 0;
}
