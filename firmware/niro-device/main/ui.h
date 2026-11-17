// What the screen says. Every function draws a whole screen and sends it.
#pragma once
#include <stdbool.h>
#include <stdint.h>

void ui_splash(void);
/** A heading and up to three short lines (any may be NULL). */
void ui_message(const char *heading, const char *line1, const char *line2, const char *line3, uint16_t colour);
/** Entering the code: six digits and which one the cursor is on. */
void ui_code_entry(const uint8_t digits[6], int cursor, const char *hint);
/** The idle screen of a paired device. */
void ui_idle(bool online, int rssi);
/** A notification; `urgent` is drawn in red. */
void ui_notification(const char *title, const char *body, bool urgent);
