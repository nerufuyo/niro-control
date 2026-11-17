#!/bin/bash
# Builds the device's half of pairing for the PC: main/srp_device.c (the very file the board runs) on top of ESP-IDF's
# own esp_srp.c and an mbedTLS built from ESP-IDF's sources. The daemon's test plays the other half against it:
#
#   firmware/niro-device/test/host/build.sh [out-dir]
#   NIRO_ESP_SRP_HARNESS=<out-dir>/harness cargo test -p island-daemon -- --ignored agrees_with_the_real_esp_srp
#   NIRO_DEVICE_SIM=<out-dir>/device_sim dbus-run-session -- cargo test -p island-daemon -- --ignored firmware_e2e
#
# Needs ESP-IDF (IDF_PATH, default ~/esp/esp-idf) and gcc.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
IDF="${IDF_PATH:-$HOME/esp/esp-idf}"
OUT="${1:-$(mktemp -d)}"
PC="$IDF/components/protocomm"
MB="$IDF/components/mbedtls/mbedtls"
FW="$HERE/../../main"
mkdir -p "$OUT/obj"
for f in "$MB"/library/*.c; do
    gcc -O2 -w -c -I"$MB/include" -I"$MB/library" -I"$MB/tf-psa-crypto/include" -o "$OUT/obj/$(basename "$f" .c).o" "$f" 2>>"$OUT/mbedtls-errors.txt" || true
done
gcc -O2 -Wall -o "$OUT/harness" "$HERE/harness.c" "$FW/srp_device.c" \
    "$PC/src/crypto/srp6a/esp_srp.c" "$PC/src/crypto/srp6a/esp_srp_mpi.c" "$OUT"/obj/*.o \
    -I"$HERE/stub" -I"$FW" -I"$PC/include/crypto/srp6a" -I"$PC/src/crypto/srp6a" -I"$MB/include" -I"$MB/tf-psa-crypto/include"
# The firmware's own link and pair code, with cJSON from ESP-IDF, as a command line device for the daemon's tests.
CJ="$IDF/components/json/cJSON"
gcc -O2 -Wall -Wno-unused-function -o "$OUT/device_sim" "$HERE/device_sim.c" "$FW/link.c" "$FW/pair.c" "$FW/srp_device.c" "$CJ/cJSON.c" \
    "$PC/src/crypto/srp6a/esp_srp.c" "$PC/src/crypto/srp6a/esp_srp_mpi.c" "$OUT"/obj/*.o -lm \
    -I"$HERE/stub" -I"$FW" -I"$CJ" -I"$PC/include/crypto/srp6a" -I"$PC/src/crypto/srp6a" -I"$MB/include" -I"$MB/tf-psa-crypto/include"
echo "$OUT/harness"
echo "$OUT/device_sim"
