// The device's half of the pairing, built from the firmware's own srp_device.c on top of ESP-IDF's esp_srp.c.
// usage: harness <code> <seed> <count>. For each session it prints "SALT <hex>", "B <hex>", reads "A <hex>"
// and prints "K <hex>" (the 64-byte session key).
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "esp_random.h"
#include "srp_device.h"

static unsigned long long rng;
static unsigned long long next(void) { rng ^= rng << 13; rng ^= rng >> 7; rng ^= rng << 17; return rng; }
void esp_fill_random(void *buf, size_t len) { unsigned char *p = buf; for (size_t i = 0; i < len; i++) p[i] = (unsigned char)(next() >> 24); }
uint32_t esp_random(void) { return (uint32_t)(next() >> 16); }

static void hex(const char *tag, const unsigned char *b, int n) { printf("%s ", tag); for (int i = 0; i < n; i++) printf("%02x", b[i]); printf("\n"); fflush(stdout); }
static int unhex(const char *s, unsigned char *out, int max) {
    int n = 0; for (; s[0] && s[1] && s[0] != '\n' && n < max; s += 2, n++) { unsigned v; sscanf(s, "%2x", &v); out[n] = (unsigned char)v; } return n; }

int main(int argc, char **argv) {
    if (argc < 4) return 2;
    const char *code = argv[1]; rng = strtoull(argv[2], 0, 10) * 2654435761ULL + 88172645463325252ULL; int count = atoi(argv[3]);
    static char line[4096]; static unsigned char abuf[512];
    for (int i = 0; i < count; i++) {
        uint8_t salt[SRP_SALT_LEN], b[SRP_B_LEN], key[SRP_KEY_LEN];
        srp_device_t *dev = srp_device_begin(code, salt, b);
        if (!dev) { fprintf(stderr, "begin failed\n"); return 1; }
        hex("SALT", salt, SRP_SALT_LEN); hex("B", b, SRP_B_LEN);
        if (!fgets(line, sizeof line, stdin)) return 1;
        int la = unhex(line + 2, abuf, sizeof abuf);
        if (srp_device_finish(dev, abuf, (size_t)la, key) != 0) { fprintf(stderr, "finish failed\n"); return 1; }
        hex("K", key, SRP_KEY_LEN);
        srp_device_free(dev);
    }
    return 0;
}
