#include "ui.h"

#include <stdio.h>
#include <string.h>

#include "board.h"
#include "face_task.h"
#include "gfx.h"

#define TITLE_Y 24

void ui_code_entry(const uint8_t digits[6], int cursor, const char *hint) {
    face_hide();
    gfx_clear(COL_BLACK);
    gfx_text_center(TITLE_Y, 3, COL_BLUE, COL_BLACK, "ENTER CODE");
    gfx_text_center(64, 2, COL_GREY, COL_BLACK, "SHOWN ON YOUR PC");
    const int slot = 34, gap = 4, total = 6 * slot + 5 * gap, x0 = (LCD_W - total) / 2;
    for (int i = 0; i < 6; i++) {
        int x = x0 + i * (slot + gap);
        gfx_rect(x, 110, slot, 56, i == cursor ? COL_BLUE : RGB(40, 40, 46));
        gfx_rect(x + 2, 112, slot - 4, 52, COL_BLACK);
        char digit[2] = {(char)('0' + digits[i]), 0};
        gfx_text(x + 5, 120, 4, i == cursor ? COL_WHITE : COL_GREY, COL_BLACK, digit);
    }
    gfx_text_center(190, 2, COL_GREY, COL_BLACK, hint);
    gfx_flush();
}

/** Writes `text` over lines of at most `width` characters, breaking at spaces, from `y`; at most `max` lines. */
static void wrapped(int y, int scale, uint16_t colour, const char *text, int width, int max) {
    char line[48];
    int lines = 0;
    while (*text && lines < max) {
        int len = (int)strlen(text);
        if (len > width) {
            len = width;
            while (len > 0 && text[len] != ' ') len--;
            if (len == 0) len = width;
        }
        memcpy(line, text, (size_t)len);
        line[len] = 0;
        gfx_text(8, y, scale, colour, COL_BLACK, line);
        y += 9 * scale + 4;
        text += len;
        while (*text == ' ') text++;
        lines++;
    }
}

void ui_notification(const char *title, const char *body, bool urgent) {
    face_hide();
    gfx_clear(COL_BLACK);
    gfx_rect(0, 0, LCD_W, 6, urgent ? COL_RED : COL_BLUE);
    wrapped(20, 3, urgent ? COL_RED : COL_WHITE, title, 13, 2);
    wrapped(100, 2, COL_GREY, body, 19, 5);
    gfx_flush();
}

#define ANSWER_WIDTH 19
#define ANSWER_LINES 7

int ui_answer(const char *text, int page) {
    // Lines of at most ANSWER_WIDTH characters, broken at spaces.
    const char *start[64];
    int length[64], lines = 0;
    while (*text && lines < 64) {
        while (*text == ' ') text++;
        int len = (int)strlen(text);
        if (len > ANSWER_WIDTH) {
            len = ANSWER_WIDTH;
            while (len > 0 && text[len] != ' ') len--;
            if (len == 0) len = ANSWER_WIDTH;
        }
        if (len == 0) break;
        start[lines] = text;
        length[lines++] = len;
        text += len;
    }
    int pages = lines ? (lines + ANSWER_LINES - 1) / ANSWER_LINES : 1;
    if (page >= pages || page < 0) page = 0;
    face_hide();
    gfx_clear(COL_BLACK);
    gfx_rect(0, 0, LCD_W, 6, COL_GREEN);
    gfx_text(8, 14, 2, COL_GREEN, COL_BLACK, "NIRO");
    for (int i = 0; i < ANSWER_LINES && page * ANSWER_LINES + i < lines; i++) {
        char line[ANSWER_WIDTH + 1];
        int at = page * ANSWER_LINES + i;
        memcpy(line, start[at], (size_t)length[at]);
        line[length[at]] = 0;
        gfx_text(8, 40 + i * 24, 2, COL_WHITE, COL_BLACK, line);
    }
    char hint[32];
    snprintf(hint, sizeof hint, pages > 1 ? "DOWN: MORE %d/%d  BOOT: OK" : "BOOT: OK", page + 1, pages);
    gfx_text(8, 224, 1, COL_GREY, COL_BLACK, hint);
    gfx_flush();
    return pages;
}
