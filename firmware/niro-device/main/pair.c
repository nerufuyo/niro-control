#include "pair.h"

#include <stdio.h>
#include <string.h>

#include "cJSON.h"
#include "esp_log.h"
#include "link.h"
#include "mbedtls/chachapoly.h"
#include "srp_device.h"

static const char *TAG = "pair";
#define N_LEN SRP_B_LEN  // A and B are padded to the length of N in what the MACs cover

/** Pads `bytes` with zeros in front to 384. */
static void pad(const uint8_t *bytes, size_t len, uint8_t out[N_LEN]) {
    memset(out, 0, N_LEN);
    memcpy(out + N_LEN - len, bytes, len);
}

pair_result_t pair_with_daemon(int fd, const char *code, const char *device_id, const char *name,
                               uint8_t daemon_id[16], uint8_t device_key[32]) {
    uint8_t salt[SRP_SALT_LEN], b[SRP_B_LEN], k[SRP_KEY_LEN];
    srp_device_t *srp = srp_device_begin(code, salt, b);
    if (!srp) return PAIR_PROTOCOL;
    pair_result_t result = PAIR_PROTOCOL;

    // The request: who we are, and the salt and B made from the code.
    static char json[1400];
    char salt_hex[2 * SRP_SALT_LEN + 1];
    static char b_hex[2 * SRP_B_LEN + 1];
    niro_hex_encode(salt, SRP_SALT_LEN, salt_hex);
    niro_hex_encode(b, SRP_B_LEN, b_hex);
    snprintf(json, sizeof json, "{\"t\":\"pair.hello\",\"v\":1,\"device_id\":\"%s\",\"name\":\"%s\",\"salt\":\"%s\",\"b\":\"%s\"}",
             device_id, name, salt_hex, b_hex);
    if (link_clear_send(fd, json) != 0) {
        result = PAIR_NETWORK;
        goto done;
    }

    // The daemon's A.
    static char reply[1400];
    if (link_clear_recv(fd, reply, sizeof reply, 5000) <= 0) {
        result = PAIR_NETWORK;
        goto done;
    }
    uint8_t a[N_LEN];
    int a_len = -1;
    cJSON *msg = cJSON_Parse(reply);
    const cJSON *t = cJSON_GetObjectItem(msg, "t"), *a_item = cJSON_GetObjectItem(msg, "a");
    if (cJSON_IsString(t) && !strcmp(t->valuestring, "pair.a") && cJSON_IsString(a_item))
        a_len = niro_hex_decode(a_item->valuestring, a, sizeof a);
    cJSON_Delete(msg);
    if (a_len < 1 || srp_device_finish(srp, a, (size_t)a_len, k) != 0) goto done;

    // From K: a MAC key and a sealing key.
    uint8_t mac_key[32], seal_key[32];
    static const uint8_t PAIR_SALT[] = "niro-device v1 pair";
    if (niro_hkdf_sha256(PAIR_SALT, sizeof PAIR_SALT - 1, k, sizeof k, "mac", mac_key) ||
        niro_hkdf_sha256(PAIR_SALT, sizeof PAIR_SALT - 1, k, sizeof k, "seal", seal_key))
        goto done;

    // What both MACs cover: A and B, each padded to 384 bytes.
    uint8_t transcript[2 * N_LEN], data[6 + 2 * N_LEN], proof[32];
    pad(a, (size_t)a_len, transcript);
    memcpy(transcript + N_LEN, b, N_LEN);
    memcpy(data, "device", 6);
    memcpy(data + 6, transcript, sizeof transcript);
    if (niro_hmac_sha256(mac_key, 32, data, sizeof data, proof)) goto done;
    char proof_hex[65];
    niro_hex_encode(proof, 32, proof_hex);
    snprintf(json, sizeof json, "{\"t\":\"pair.proof\",\"mac\":\"%s\"}", proof_hex);
    if (link_clear_send(fd, json) != 0) {
        result = PAIR_NETWORK;
        goto done;
    }

    // A wrong code is a connection closed without a word; a refusal says "pair.denied"; no answer in time is a user who
    // did not answer.
    int got = link_clear_recv(fd, reply, sizeof reply, 75000);
    if (got < 0) {
        result = PAIR_CODE;
        goto done;
    }
    if (got == 0) {
        result = PAIR_DENIED;
        goto done;
    }
    msg = cJSON_Parse(reply);
    t = cJSON_GetObjectItem(msg, "t");
    if (cJSON_IsString(t) && !strcmp(t->valuestring, "pair.denied")) {
        cJSON_Delete(msg);
        result = PAIR_DENIED;
        goto done;
    }
    const cJSON *mac_item = cJSON_GetObjectItem(msg, "mac"), *sealed_item = cJSON_GetObjectItem(msg, "sealed");
    uint8_t answer[32], want[32], sealed[48 + 16];
    int sealed_len = -1;
    int ok = cJSON_IsString(t) && !strcmp(t->valuestring, "pair.done") && cJSON_IsString(mac_item) &&
             cJSON_IsString(sealed_item) && niro_hex_decode(mac_item->valuestring, answer, 32) == 32;
    if (ok) sealed_len = niro_hex_decode(sealed_item->valuestring, sealed, sizeof sealed);
    cJSON_Delete(msg);
    memcpy(data, "daemon", 6);
    if (!ok || sealed_len != 48 + 16 || niro_hmac_sha256(mac_key, 32, data, sizeof data, want) || !niro_ct_equal(answer, want, 32)) {
        ESP_LOGW(TAG, "the daemon's answer did not check out");
        goto done;
    }

    // The key is used for this one message, so a nonce of zeros is safe.
    uint8_t secret[48], nonce[12] = {0};
    mbedtls_chachapoly_context ctx;
    mbedtls_chachapoly_init(&ctx);
    int rc = mbedtls_chachapoly_setkey(&ctx, seal_key);
    if (!rc) rc = mbedtls_chachapoly_auth_decrypt(&ctx, 48, nonce, NULL, 0, sealed + 48, sealed, secret);
    mbedtls_chachapoly_free(&ctx);
    if (rc) goto done;
    memcpy(daemon_id, secret, 16);
    memcpy(device_key, secret + 16, 32);
    result = PAIR_OK;

done:
    srp_device_free(srp);
    return result;
}
