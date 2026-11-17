#include "link.h"

#include <errno.h>
#include <stdio.h>
#include <string.h>

#include "cJSON.h"
#include "esp_log.h"
#include "esp_random.h"
#include "lwip/sockets.h"
#include "mbedtls/chachapoly.h"
#include "mbedtls/hkdf.h"
#include "mbedtls/md.h"

static const char *TAG = "link";
#define TAG_LEN 16
#define TYPE_CONTROL 0

void niro_hex_encode(const uint8_t *bytes, size_t len, char *out) {
    static const char digits[] = "0123456789abcdef";
    for (size_t i = 0; i < len; i++) {
        out[2 * i] = digits[bytes[i] >> 4];
        out[2 * i + 1] = digits[bytes[i] & 15];
    }
    out[2 * len] = 0;
}

static int nibble(char c) {
    if (c >= '0' && c <= '9') return c - '0';
    if (c >= 'a' && c <= 'f') return c - 'a' + 10;
    if (c >= 'A' && c <= 'F') return c - 'A' + 10;
    return -1;
}

int niro_hex_decode(const char *hex, uint8_t *out, size_t max) {
    size_t len = strlen(hex);
    if (len % 2 || len / 2 > max) return -1;
    for (size_t i = 0; i < len / 2; i++) {
        int hi = nibble(hex[2 * i]), lo = nibble(hex[2 * i + 1]);
        if (hi < 0 || lo < 0) return -1;
        out[i] = (uint8_t)(hi << 4 | lo);
    }
    return (int)(len / 2);
}

int niro_ct_equal(const uint8_t *a, const uint8_t *b, size_t len) {
    uint8_t diff = 0;
    for (size_t i = 0; i < len; i++) diff |= a[i] ^ b[i];
    return diff == 0;
}

int niro_hmac_sha256(const uint8_t *key, size_t key_len, const uint8_t *data, size_t len, uint8_t out[32]) {
    return mbedtls_md_hmac(mbedtls_md_info_from_type(MBEDTLS_MD_SHA256), key, key_len, data, len, out);
}

int niro_hkdf_sha256(const uint8_t *salt, size_t salt_len, const uint8_t *ikm, size_t ikm_len, const char *info, uint8_t out[32]) {
    return mbedtls_hkdf(mbedtls_md_info_from_type(MBEDTLS_MD_SHA256), salt, salt_len, ikm, ikm_len,
                        (const uint8_t *)info, strlen(info), out, 32);
}

static int send_all(int fd, const uint8_t *bytes, size_t len) {
    while (len) {
        int sent = send(fd, bytes, len, 0);
        if (sent <= 0) return -1;
        bytes += sent;
        len -= (size_t)sent;
    }
    return 0;
}

/** Reads `len` bytes. 1 when a timeout hit before the first byte, -1 on failure or a stop part way, 0 when read. */
static int recv_exact(int fd, uint8_t *bytes, size_t len, int timeout_ms) {
    size_t got = 0;
    while (got < len) {
        struct timeval timeout = {.tv_sec = timeout_ms / 1000, .tv_usec = (timeout_ms % 1000) * 1000};
        setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &timeout, sizeof timeout);
        int n = recv(fd, bytes + got, len - got, 0);
        if (n > 0) {
            got += (size_t)n;
        } else if (n == 0) {
            return -1;
        } else if (errno == EAGAIN || errno == EWOULDBLOCK) {
            return got == 0 ? 1 : -1;
        } else {
            return -1;
        }
    }
    return 0;
}

static int write_frame(int fd, const uint8_t *body, size_t len) {
    uint8_t frame[2 + 2048];
    if (len > 2048) return -1;
    frame[0] = (uint8_t)(len >> 8);
    frame[1] = (uint8_t)len;
    memcpy(frame + 2, body, len);
    return send_all(fd, frame, 2 + len);
}

/** A frame's body: its length, 0 on a timeout, -1 on failure. */
static int read_frame(int fd, uint8_t *buf, size_t cap, int timeout_ms) {
    uint8_t head[2];
    int rc = recv_exact(fd, head, 2, timeout_ms);
    if (rc != 0) return rc == 1 ? 0 : -1;
    size_t len = (size_t)head[0] << 8 | head[1];
    if (len > cap) return -1;
    if (len && recv_exact(fd, buf, len, 5000) != 0) return -1;
    return len ? (int)len : -1;
}

int link_clear_send(int fd, const char *json) { return write_frame(fd, (const uint8_t *)json, strlen(json)); }

int link_clear_recv(int fd, char *buf, size_t cap, int timeout_ms) {
    int len = read_frame(fd, (uint8_t *)buf, cap - 1, timeout_ms);
    if (len > 0) buf[len] = 0;
    return len;
}

static void nonce_for(uint64_t counter, uint8_t nonce[12]) {
    memset(nonce, 0, 12);
    for (int i = 0; i < 8; i++) nonce[11 - i] = (uint8_t)(counter >> (8 * i));
}

int link_open(link_t *link, int fd, const uint8_t device_key[32], const char *device_id) {
    memset(link, 0, sizeof *link);
    link->fd = fd;
    uint8_t nonce_d[16], nonce_s[16];
    esp_fill_random(nonce_d, sizeof nonce_d);
    char nonce_hex[33], json[256];
    niro_hex_encode(nonce_d, 16, nonce_hex);
    snprintf(json, sizeof json, "{\"t\":\"hello\",\"v\":1,\"device_id\":\"%s\",\"nonce\":\"%s\"}", device_id, nonce_hex);
    if (link_clear_send(fd, json) != 0) return -1;

    // An unknown device gets no answer: the daemon closes the connection.
    char reply[512];
    if (link_clear_recv(fd, reply, sizeof reply, 5000) <= 0) return -1;
    cJSON *challenge = cJSON_Parse(reply);
    const cJSON *t = cJSON_GetObjectItem(challenge, "t"), *nonce_item = cJSON_GetObjectItem(challenge, "nonce");
    int ok = cJSON_IsString(t) && !strcmp(t->valuestring, "challenge") && cJSON_IsString(nonce_item) &&
             niro_hex_decode(nonce_item->valuestring, nonce_s, 16) == 16;
    cJSON_Delete(challenge);
    if (!ok) return -1;

    uint8_t salt[32], mac_key[32];
    memcpy(salt, nonce_d, 16);
    memcpy(salt + 16, nonce_s, 16);
    if (niro_hkdf_sha256(salt, 32, device_key, 32, "niro-device v1 d2s", link->send_key) ||
        niro_hkdf_sha256(salt, 32, device_key, 32, "niro-device v1 s2d", link->recv_key) ||
        niro_hkdf_sha256(salt, 32, device_key, 32, "niro-device v1 mac", mac_key))
        return -1;

    uint8_t data[6 + 16], proof[32];
    memcpy(data, "device", 6);
    memcpy(data + 6, nonce_s, 16);
    if (niro_hmac_sha256(mac_key, 32, data, sizeof data, proof)) return -1;
    char proof_hex[65];
    niro_hex_encode(proof, 32, proof_hex);
    snprintf(json, sizeof json, "{\"t\":\"auth\",\"mac\":\"%s\"}", proof_hex);
    if (link_clear_send(fd, json) != 0) return -1;

    if (link_clear_recv(fd, reply, sizeof reply, 5000) <= 0) return -1;
    cJSON *ready = cJSON_Parse(reply);
    t = cJSON_GetObjectItem(ready, "t");
    const cJSON *mac_item = cJSON_GetObjectItem(ready, "mac");
    uint8_t answer[32], want[32];
    memcpy(data, "daemon", 6);
    memcpy(data + 6, nonce_d, 16);
    ok = cJSON_IsString(t) && !strcmp(t->valuestring, "ready") && cJSON_IsString(mac_item) &&
         niro_hex_decode(mac_item->valuestring, answer, 32) == 32 && niro_hmac_sha256(mac_key, 32, data, sizeof data, want) == 0 &&
         niro_ct_equal(answer, want, 32);
    cJSON_Delete(ready);
    if (!ok) {
        ESP_LOGW(TAG, "the daemon did not prove it holds the key");
        return -1;
    }
    return 0;
}

int link_send(link_t *link, const char *json) {
    size_t len = strlen(json);
    if (len > LINK_PAYLOAD_MAX) return -1;
    uint8_t plain[1 + LINK_PAYLOAD_MAX], frame[LINK_PAYLOAD_MAX + 1 + TAG_LEN], nonce[12];
    plain[0] = TYPE_CONTROL;
    memcpy(plain + 1, json, len);
    nonce_for(link->send_counter++, nonce);
    mbedtls_chachapoly_context ctx;
    mbedtls_chachapoly_init(&ctx);
    int rc = mbedtls_chachapoly_setkey(&ctx, link->send_key);
    if (!rc) rc = mbedtls_chachapoly_encrypt_and_tag(&ctx, len + 1, nonce, NULL, 0, plain, frame, frame + len + 1);
    mbedtls_chachapoly_free(&ctx);
    return rc ? -1 : write_frame(link->fd, frame, len + 1 + TAG_LEN);
}

int link_recv(link_t *link, char *buf, size_t cap, size_t *len, int timeout_ms) {
    uint8_t frame[LINK_PAYLOAD_MAX + 1 + TAG_LEN], plain[1 + LINK_PAYLOAD_MAX], nonce[12];
    int n = read_frame(link->fd, frame, sizeof frame, timeout_ms);
    if (n <= 0) return n;
    if (n < 1 + TAG_LEN) return -1;
    size_t body = (size_t)n - TAG_LEN;
    nonce_for(link->recv_counter++, nonce);
    mbedtls_chachapoly_context ctx;
    mbedtls_chachapoly_init(&ctx);
    int rc = mbedtls_chachapoly_setkey(&ctx, link->recv_key);
    // A frame that does not open (changed, repeated, dropped, reordered) ends the connection.
    if (!rc) rc = mbedtls_chachapoly_auth_decrypt(&ctx, body, nonce, NULL, 0, frame + body, frame, plain);
    mbedtls_chachapoly_free(&ctx);
    if (rc) return -1;
    if (plain[0] != TYPE_CONTROL) {
        // Audio and the rest are not used yet: a frame that says nothing.
        buf[0] = 0;
        *len = 0;
        return 1;
    }
    size_t text = body - 1;
    if (text >= cap) return -1;
    memcpy(buf, plain + 1, text);
    buf[text] = 0;
    *len = text;
    return 1;
}
