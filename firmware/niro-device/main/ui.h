// The static screens: what the face cannot say. Each takes the screen from the face and draws a whole frame.
#pragma once
#include <stdbool.h>
#include <stdint.h>

/** Entering the code: six digits and which one the cursor is on. */
void ui_code_entry(const uint8_t digits[6], int cursor, const char *hint);
/** A notification; `urgent` is drawn in red. */
void ui_notification(const char *title, const char *body, bool urgent);
