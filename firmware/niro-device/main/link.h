// A paired device's connection: how it proves itself and how everything after is sealed. The daemon's side is
// crates/island-daemon/src/device/link.rs; the two must agree on every label, order and size.
#pragma once
#include <stddef.h>
#include <stdint.h>

#define LINK_PAYLOAD_MAX 1024  // the most a sealed frame carries here; the daemon allows more

typedef struct {
    int fd;
    uint8_t send_key[32];  // device to daemon
    uint8_t recv_key[32];  // daemon to device
    uint64_t send_counter, recv_counter;
} link_t;

void niro_hex_encode(const uint8_t *bytes, size_t len, char *out);  // out holds 2 * len + 1
int niro_hex_decode(const char *hex, uint8_t *out, size_t max);     // the bytes, or -1
int niro_ct_equal(const uint8_t *a, const uint8_t *b, size_t len);  // 1 when equal, in constant time
int niro_hmac_sha256(const uint8_t *key, size_t key_len, const uint8_t *data, size_t len, uint8_t out[32]);
int niro_hkdf_sha256(const uint8_t *salt, size_t salt_len, const uint8_t *ikm, size_t ikm_len, const char *info, uint8_t out[32]);

/** One clear frame: a two-byte length and a JSON text. */
int link_clear_send(int fd, const char *json);
/** The next clear frame, as a NUL-ended text; its length, 0 on timeout, -1 on failure. */
int link_clear_recv(int fd, char *buf, size_t cap, int timeout_ms);

/** Opens the connection of a paired device. 0 when the daemon answered and proved it holds the key too. */
int link_open(link_t *link, int fd, const uint8_t device_key[32], const char *device_id);
/** A JSON control message. */
int link_send(link_t *link, const char *json);
/** The next sealed frame: 1 for a message (text in `buf`, `*len` long), 2 for a frame of audio (the bytes in `buf`), 0 for a timeout, -1 for the end. */
int link_recv(link_t *link, char *buf, size_t cap, size_t *len, int timeout_ms);
/** A frame of audio: 16-bit little-endian PCM at 16 kHz (the daemon's `voice.rs`), at most LINK_PAYLOAD_MAX bytes. */
int link_send_audio(link_t *link, const uint8_t *pcm, size_t len);
