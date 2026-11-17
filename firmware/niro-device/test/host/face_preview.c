// Renders Niro's face on the PC with the firmware's own face.c and draw.c, to raw RGB565 frames that face_sheet.py turns into
// pictures, so the face can be looked at and tuned without the board.
//   face_preview sheet OUT_DIR              one settled frame per mood: <mood>.rgb565
//   face_preview strip OUT_DIR MOOD FROM_S STEP_MS COUNT [SEED]   frames of one mood over time: strip_<n>.rgb565
//   face_preview bench                       how long a frame takes to draw, per mood, on this machine (relative, not the board's speed)
//   face_preview act OUT_DIR ACT COUNT      one idle act (1 yawn .. 7 sway) over its length: strip_<n>.rgb565
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include <time.h>

#include "face.h"

static uint16_t canvas[240 * 240];

static void dump(const char *path) {
    face_draw(canvas);
    FILE *f = fopen(path, "wb");
    fwrite(canvas, 2, 240 * 240, f);
    fclose(f);
}

int main(int argc, char **argv) {
    if (argc < 2) return 2;
    if (argc < 3 && strcmp(argv[1], "bench")) return 2;
    char path[512];
    if (!strcmp(argv[1], "sheet")) {
        for (int m = 0; m < FACE_COUNT; m++) {
            face_init(7 + (uint32_t)m);
            face_set((face_mood_t)m);
            // Let it settle, and for the moods that move (a hop, a voice) land on a frame that shows it.
            for (int i = 0; i < 70; i++) face_step(33);
            snprintf(path, sizeof path, "%s/%s.rgb565", argv[2], face_name((face_mood_t)m));
            dump(path);
        }
        return 0;
    }
    if (!strcmp(argv[1], "strip") && argc >= 7) {
        int mood = face_from_name(argv[3]);
        if (mood < 0) return 2;
        float from = (float)atof(argv[4]);
        int step = atoi(argv[5]), count = atoi(argv[6]);
        face_init(argc > 7 ? (uint32_t)atoi(argv[7]) : 5);
        face_set((face_mood_t)mood);
        double t = 0;
        for (int n = 0; n < count; n++) {
            double target = from + n * step / 1000.0;
            while (t < target) { face_step(33); t += .033; }
            snprintf(path, sizeof path, "%s/strip_%03d.rgb565", argv[2], n);
            dump(path);
        }
        return 0;
    }
    if (!strcmp(argv[1], "bench")) {
        for (int m = 0; m < FACE_COUNT; m++) {
            face_init(9);
            face_set((face_mood_t)m);
            for (int i = 0; i < 40; i++) face_step(33);
            struct timespec a, b;
            clock_gettime(CLOCK_MONOTONIC, &a);
            for (int i = 0; i < 200; i++) { face_step(33); face_draw(canvas); }
            clock_gettime(CLOCK_MONOTONIC, &b);
            printf("%-10s %.3f ms/frame\n", face_name((face_mood_t)m), ((b.tv_sec - a.tv_sec) * 1e3 + (b.tv_nsec - a.tv_nsec) / 1e6) / 200);
        }
        return 0;
    }
    if (!strcmp(argv[1], "act") && argc >= 5) {
        face_init(3);
        face_set(FACE_IDLE);
        for (int i = 0; i < 20; i++) face_step(33);
        float len = face_act(atoi(argv[3]));
        int count = atoi(argv[4]);
        double t = 0;
        for (int n = 0; n < count; n++) {
            double target = (len * 1.1) * n / (count - 1);
            while (t < target) { face_step(33); t += .033; }
            snprintf(path, sizeof path, "%s/strip_%03d.rgb565", argv[2], n);
            dump(path);
        }
        return 0;
    }
    return 2;
}
