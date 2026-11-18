# Niro Device: the board

What is known of the board the first Niro Device runs on, and how each fact was learned, so the firmware
does not stand on guesses. Nothing here comes from a datasheet or a schematic: the board has no model name on its
PCB. Every value was read from the board's own firmware (a 4 MB backup of `ota_0`, and its boot log).

## The board

- **ESP32-S3** (QFN56, rev v0.2), Wi-Fi and BLE, 16 MB flash (Winbond, DIO), 8 MB PSRAM at 80 MHz.
- The firmware it came with is `geniusai-device` 2.1.3 on ESP-IDF 5.4 (built 2026-06-23), a product firmware with its
  own server protocol. It is not used; the Niro Device firmware replaces it.
- USB-C into a CH340 (`1a86:7522`, `ttyUSB0`) wired to UART0, so the console and flashing are over serial. **DTR and
  RTS do not reset the board**: there is no auto-reset. See "Flashing" below.
- Battery connector (`B+`, `B-`), a `POWER` switch, a speaker connector (`SPK+`, `SPK-`), a square TFT on a flat cable,
  charge LEDs (`充满` full, `充电中` charging), an antenna (`ANT`).
- Broken-out pads on the PCB: `17`, `18`, `2`, `3`, and a header `…C, GND, 11, 12, EN, BAT`.

## Pins

| Function | GPIO | How it was learned |
|---|---|---|
| Button, volume down (`音量减`) | 39 | firmware boot log: input, pull-up, active low |
| Button, BOOT | 0 | the same; also the strapping pin |
| Button, volume up (`音量加`) | 10 | the same |
| Display SPI MOSI | 41 | code: `spi_bus_config_t.mosi_io_num` |
| Display SPI SCLK | 42 | code: `spi_bus_config_t.sclk_io_num` (no MISO) |
| Display CS | 21 | code: `esp_lcd_panel_io_spi_config_t.cs_gpio_num` |
| Display DC | 40 | code, **and** the boot log (output, set up in "Initializing TFT display") |
| Display RST | 45 | code, **and** the boot log (output, the same place) |
| Backlight | 20 | firmware boot log: "Backlight PWM initialized on GPIO 20" (LEDC, 10 bit, 5 kHz) |
| Mic, I2S WS / SCK / DIN | 4 / 5 / 6 | firmware boot log, 16 kHz |
| Speaker, I2S DOUT / BCLK / LRCK | 7 / 15 / 16 | firmware boot log, 24 kHz |
| Battery level | ADC channel 7 | firmware boot log: "ADC initialized on channel 7" |
| Charging status | 2 | boot log: an input without pull, set up by the power manager; the PCB has a pad `2` |

The microphone and the speaker each have their own clock lines (two I2S controllers). No I2C and no codec chip was
seen in the firmware.

The display:

- ST7789 on **SPI2**, SPI mode 3, 80 MHz, 16 bit per pixel, **240 × 240** (a 115 200 byte frame buffer).
- Not known yet, and set by looking at the screen: whether the colours are inverted, whether it is mirrored or
  swapped, and any offset.

## What is not settled

- **The battery's ADC unit.** "Channel 7" is GPIO 8 on ADC1 and GPIO 18 on ADC2 (the PCB has a pad `18`). ADC2 cannot be
  read while Wi-Fi is on, so ADC1 (GPIO 8) is the likelier; the firmware's code would say.
- **That 41 is MOSI and 42 is SCLK** rests on the layout of `spi_bus_config_t` read from the stack. DC and RST were
  confirmed by the log; MOSI, SCLK and CS were not. A wrong one shows as a black screen, which is harmless.
- **The amplifier and the microphone parts** are unknown (a MEMS microphone and an I2S amplifier would fit).
- **GPIO 2** as the charge status is inferred from the log and the PCB, not read from the code.

## Battery, charger and microphone in the firmware (guesses to check)

- **Battery**: ADC1 channel 7 (GPIO 8), read through a divider whose ratio is not known; `CONFIG_NIRO_BATTERY_DIVIDER_X10` (20, a divider of 2) is a guess. The device logs "battery N mV": compare it with a meter on the battery and set the ratio. A reading outside 2.8 to 4.5 V is reported as 255 (unknown). The percentage is a lithium cell's usual curve.
- **Charging**: GPIO 2, taken as active low (a TP4056's CHRG pulls low while charging): `CONFIG_NIRO_CHARGING_ACTIVE_LOW`. If the device says it is charging when it is not, turn it off.
- **Microphone**: I2S 4 / 5 / 6 at 16 kHz, 32-bit slot, left channel, `>> CONFIG_NIRO_MIC_SHIFT` (14) to 16 bits; `CONFIG_NIRO_MIC_RIGHT` if nothing is heard. All of it compiled, none heard.

## Firmware

The firmware for this board is in [`firmware/niro-device`](../firmware/niro-device/README.md). It has been built, and tested against the
daemon on a PC, but has not been run on the board.

## Flashing

- To enter the bootloader: hold BOOT (GPIO 0) **while plugging the USB cable in**. Pressing BOOT after the board has
  started does nothing.
- To reset: touch `EN` to `GND` on the header for a moment. There is no reset button.
- The board's USB link has been unreliable (it drops and returns). Use a short data cable on a port at the back of
  the PC, and do not touch the cable while a read or a write runs.
- The firmware it came with is only partly backed up (the first 4 MB: bootloader, partition table, NVS and the first
  4 MB of the 5 MB `ota_0`). Writing a new image means that firmware cannot be put back from the backup.

## How the values were found

The backup was read with Capstone 6 (Xtensa ESP32-S3): the image's segments were mapped to their addresses, the
`l32r` instructions that load the address of a log string were found from the raw bytes, and the function around them
was disassembled. The display function builds its configuration structures on the stack from constants, which are
legible. The firmware's own boot log (captured from the first byte after a replug) then confirmed what it could.
