// The firmware's own link.c and pair.c, built for the PC and driven from the command line, so the daemon's test can
// pair and connect with them over a real socket.
//   device_sim pair  HOST PORT CODE DEVICE_ID NAME   -> "OK <daemon id hex> <device key hex>" or "FAIL <n>"
//   device_sim hello HOST PORT KEY_HEX DEVICE_ID     -> "CONNECTED", then "MSG <json>" for each message until the end
#include <arpa/inet.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/select.h>

#include "esp_random.h"
#include "link.h"
#include "pair.h"

static unsigned long long rng = 88172645463325252ULL;
static unsigned long long next(void) { rng ^= rng << 13; rng ^= rng >> 7; rng ^= rng << 17; return rng; }
void esp_fill_random(void *buf, size_t len) {
    FILE *f = fopen("/dev/urandom", "rb");
    if (f && fread(buf, 1, len, f) == len) { fclose(f); return; }
    if (f) fclose(f);
    unsigned char *p = buf;
    for (size_t i = 0; i < len; i++) p[i] = (unsigned char)(next() >> 24);
}
uint32_t esp_random(void) { uint32_t v; esp_fill_random(&v, sizeof v); return v; }

static int dial(const char *host, int port) {
    int fd = socket(AF_INET, SOCK_STREAM, 0);
    struct sockaddr_in a = {.sin_family = AF_INET, .sin_port = htons((uint16_t)port)};
    inet_pton(AF_INET, host, &a.sin_addr);
    if (connect(fd, (struct sockaddr *)&a, sizeof a) != 0) { perror("connect"); return -1; }
    return fd;
}

int main(int argc, char **argv) {
    if (argc < 6) return 2;
    int fd = dial(argv[2], atoi(argv[3]));
    if (fd < 0) return 3;
    if (!strcmp(argv[1], "pair")) {
        uint8_t daemon_id[16], key[32];
        pair_result_t r = pair_with_daemon(fd, argv[4], argv[5], argc > 6 ? argv[6] : "Sim", daemon_id, key);
        if (r != PAIR_OK) { printf("FAIL %d\n", (int)r); return 1; }
        char a[33], b[65];
        niro_hex_encode(daemon_id, 16, a);
        niro_hex_encode(key, 32, b);
        printf("OK %s %s\n", a, b);
        return 0;
    }
    uint8_t key[32];
    if (niro_hex_decode(argv[4], key, 32) != 32) return 2;
    link_t link;
    if (link_open(&link, fd, key, argv[5]) != 0) { printf("REFUSED\n"); return 1; }
    printf("CONNECTED\n"); fflush(stdout);
    link_send(&link, "{\"t\":\"status\",\"battery\":255,\"charging\":false,\"temp_c\":0.0,\"rssi\":-55,\"fw\":\"sim\"}");
    link_send(&link, "{\"t\":\"ping\"}");
    for (;;) {
        char text[LINK_PAYLOAD_MAX + 1]; size_t len = 0;
        int got = link_recv(&link, text, sizeof text, &len, 8000);
        if (got < 0) { printf("END\n"); return 0; }
        if (got == 1 && len) { printf("MSG %s\n", text); fflush(stdout); }
        if (got == 0) { printf("IDLE\n"); return 0; }
    }
}
