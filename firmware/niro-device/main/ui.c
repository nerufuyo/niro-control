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
