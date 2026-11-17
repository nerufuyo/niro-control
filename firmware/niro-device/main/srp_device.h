// The device's half of pairing: SRP-6a as ESP-IDF's esp_srp does it, with the salt made here.
//
// Why not esp_srp_srv_pubkey: it makes the salt itself and turns it into bytes of minimal length, so one salt in
// 256 (a leading zero byte) is 15 bytes long where the code reads 16, and the hashed salt is then whatever the heap
// holds after it. Here the salt is made whole, the verifier from it, and esp_srp is given both. This file is built
// for the board and, unchanged, for the PC (tests/ in the daemon's crate pairs it with the daemon's client).
#pragma once
#include <stddef.h>
#include <stdint.h>

#define SRP_SALT_LEN 16
#define SRP_B_LEN 384
#define SRP_KEY_LEN 64

typedef struct srp_device srp_device_t;

/** Starts an exchange from the code typed on the device: fills `salt` and `b` (B, big endian, 384 bytes), or NULL. */
srp_device_t *srp_device_begin(const char *code, uint8_t salt[SRP_SALT_LEN], uint8_t b[SRP_B_LEN]);

/** Takes A as the daemon sent it and gives the session key K (64 bytes). 0 on success. */
int srp_device_finish(srp_device_t *dev, const uint8_t *a, size_t a_len, uint8_t key[SRP_KEY_LEN]);

void srp_device_free(srp_device_t *dev);
