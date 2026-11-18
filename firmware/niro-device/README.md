# Niro Device firmware

Firmware for the ESP32-S3 assistant board (a 240 × 240 screen, three buttons, a speaker and a microphone) that pairs with
one user's Niro by a six-digit code and shows the notifications Niro sends it. The protocol is in
[`docs/device-protocol.md`](../../docs/device-protocol.md); the board's pins, and how each was learned, are in
[`docs/device-hardware.md`](../../docs/device-hardware.md).

**This firmware has been built and tested on a PC against the daemon, and has not been run on the board.** See
"What is not proven" before flashing it.

## What it does

1. Joins the Wi-Fi network you give it over the serial console (`wifi <ssid> <password>`; also `forget`, `unpair`, `restart`).
2. Not paired: shows "NOT PAIRED". In Niro (the Niro Device page) press **Add a device**; on the board press **BOOT**, type the
   six digits with **UP** / **DOWN** (BOOT moves to the next digit, a long BOOT gives up), and allow the device on the PC.
3. Paired: finds the daemon on the local network (mDNS, `_niro-device._tcp`), connects, and shows `CONNECTED`. It answers the
   daemon's pings, reports its signal strength every 30 seconds, and shows a notification (any button dismisses it).
4. If the daemon stops knowing it (it was forgotten on the PC), the screen says so and a long BOOT forgets the pairing here too.

The screen shows [Niro, a little slime](MASCOT.md), whose face follows what the device is doing (waking, looking for Wi-Fi, curious when it is not
paired, happy when it is connected, alert for an urgent notification, sad when offline, sleepy when left alone) and what the daemon sets.

Not done yet: audio (the microphone and the speaker), asking questions, and the battery level (it reports 255, "unknown").

## Build

ESP-IDF 5.4 (`~/esp/esp-idf`), with a Python it supports (3.9 to 3.13; the system's 3.15 is too new):

```sh
cd ~/esp/esp-idf && ./install.sh esp32s3 && . ./export.sh
cd firmware/niro-device
idf.py set-target esp32s3 && idf.py build
```

The display's orientation and colours are not known for this board; `idf.py menuconfig` → *Niro Device* sets them (the colours
inverted, the axes mirrored or swapped, an offset).

## Flashing

**Writing the firmware replaces the one the board came with, which cannot be put back:** only the first 4 MB of its flash was
backed up (`~/niro-device-backups/`), not all of its 5 MB app.

- Enter the bootloader by holding **BOOT** while plugging the USB cable in (pressing it after the board is running does nothing; there
  is no reset button, `EN` on the header to `GND` resets).
- The board's USB link drops easily: a short data cable on a rear port, and do not touch it during the write.
- `idf.py -p /dev/ttyUSB0 flash`, or esptool with the `flash_args` the build leaves in `build/`.

## Tests

The daemon's tests build the firmware's own C for the PC and run it against the daemon, over real sockets:

```sh
firmware/niro-device/test/host/build.sh /tmp/niro-host      # needs ESP-IDF and gcc; prints the two programs it made
NIRO_ESP_SRP_HARNESS=/tmp/niro-host/harness \
    cargo test -p island-daemon -- --ignored agrees_with_the_real_esp_srp          # 1200 SRP sessions against esp_srp.c
NIRO_DEVICE_SIM=/tmp/niro-host/device_sim \
    dbus-run-session -- cargo test -p island-daemon -- --ignored firmware_e2e      # the whole pairing and a connection
```

## Using it

Pair it (BOOT, then type the six digits). Then **hold the UP button** (the volume-up one, GPIO 10) and speak; let go to send. The
slime listens, thinks, and the answer appears on the screen: DOWN turns the pages, BOOT closes it. The PC does the hearing (whisper, set up
in the island's assistant) and the answering (the AI chosen in Settings): an unset-up assistant is said so on the screen. Notifications
(an AI that needs you or is done, a reminder, a meeting, the PC's battery) come the same way, with the slime's mood to match.

## What is not proven

- **Nothing here has run on the board** (the battery reading, the charger pin, the microphone, the answer screen and the talk button included: see `docs/device-hardware.md` for what is a guess). The code compiles for the ESP32-S3 (about 930 KB of the 3 MB the app may use), and the parts that
  do not touch the hardware (`srp_device.c`, `link.c`, `pair.c`) run on the PC against the daemon. The display, the buttons, Wi-Fi, mDNS on the
  board's own stack and the console have only been compiled.
- The display's pins MOSI 41, SCLK 42 and CS 21 come from reading the old firmware's code, not its log (DC 40 and RST 45 were confirmed by
  the log). A wrong one shows a black screen.
- The mascot has been looked at on the PC, not on the screen, and how fast it runs on the board is not known (see [MASCOT.md](MASCOT.md)).
- The fonts, colours and layout have not been seen on the screen.
- `esp_srp`'s own salt handling has a flaw (one salt in 256 is read one byte too long); `srp_device.c` makes the salt itself to avoid it.
