// The board's pins, from docs/device-hardware.md: each was read from the firmware the board came with.
#pragma once

#define PIN_BTN_DOWN   39   // 音量减, volume down (input, pull-up, active low)
#define PIN_BTN_BOOT    0   // BOOT (also the strapping pin)
#define PIN_BTN_UP     10   // 音量加, volume up

#define PIN_LCD_MOSI   41
#define PIN_LCD_SCLK   42
#define PIN_LCD_CS     21
#define PIN_LCD_DC     40
#define PIN_LCD_RST    45
#define PIN_LCD_BL     20   // backlight, LEDC PWM

#define LCD_W 240
#define LCD_H 240
