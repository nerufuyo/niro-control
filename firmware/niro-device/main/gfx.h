// The display: an ST7789, 240 x 240, drawn into a frame buffer and sent whole. Pins are in board.h.
#pragma once
#include <stdint.h>

#define RGB(r, g, b) ((uint16_t)((((r) & 0xF8) << 8) | (((g) & 0xFC) << 3) | ((b) >> 3)))
#define COL_BLACK  RGB(0, 0, 0)
#define COL_WHITE  RGB(255, 255, 255)
#define COL_GREY   RGB(140, 140, 150)
#define COL_BLUE   RGB(10, 132, 255)
#define COL_GREEN  RGB(48, 209, 88)
#define COL_RED    RGB(255, 69, 58)
#define COL_AMBER  RGB(255, 159, 10)

void gfx_init(void);
void gfx_backlight(int percent);
void gfx_clear(uint16_t colour);
void gfx_rect(int x, int y, int w, int h, uint16_t colour);
/** A character is 6 x 8 pixels times `scale`. Lower case is drawn as it is; what the font lacks is a blank. */
void gfx_text(int x, int y, int scale, uint16_t fg, uint16_t bg, const char *text);
/** Centred across the screen. */
void gfx_text_center(int y, int scale, uint16_t fg, uint16_t bg, const char *text);
/** Sends the frame to the screen and waits until it is there. */
void gfx_flush(void);
