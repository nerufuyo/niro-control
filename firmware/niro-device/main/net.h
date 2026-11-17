// Wi-Fi, and finding the daemon on the local network by mDNS (_niro-device._tcp).
#pragma once
#include <stdbool.h>
#include <stdint.h>

typedef struct {
    uint32_t ip;          // network order
    uint16_t port;
    char id[33];          // the daemon's id, 32 hex digits
    bool pair_open;       // a pairing code is open
} daemon_t;

void net_start(void);
bool net_connected(void);
/** Saves the network and joins it. */
void net_set_credentials(const char *ssid, const char *pass);
/** Looks for the daemon: the one with `want_id` (32 hex digits), or any, and with a code open when `need_pair`. */
bool net_find_daemon(const char *want_id, bool need_pair, daemon_t *out);
/** A connected TCP socket to it, or -1. */
int net_connect(const daemon_t *daemon);
int net_rssi(void);
