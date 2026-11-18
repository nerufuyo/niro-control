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

#define PIN_CHARGING    2   // the charger's status, an input without pull (read from the boot log; polarity in Kconfig)

#define PIN_MIC_WS      4   // the microphone's I2S word select, clock and data (boot log: 4 / 5 / 6, 16 kHz)
#define PIN_MIC_SCK     5
#define PIN_MIC_DIN     6

#define PIN_SPK_DOUT    7   // the speaker's I2S data, bit clock and word select (boot log: 7 / 15 / 16, 24 kHz there; 16 kHz here)
#define PIN_SPK_BCLK   15
#define PIN_SPK_LRCK   16
