#include "srp_device.h"

#include <stdlib.h>
#include <string.h>

#include "esp_random.h"
#include "esp_srp.h"
#include "mbedtls/bignum.h"
#include "mbedtls/sha512.h"
#include "srp_n3072.h"

#define USERNAME "niro-device"

struct srp_device {
    esp_srp_handle_t *handle;
};

/** v = g^x mod N, with x = H(salt | H(user ":" code)) as esp_srp computes it, written as 384 bytes. */
static int verifier(const char *code, const uint8_t salt[SRP_SALT_LEN], uint8_t out[SRP_B_LEN]) {
    unsigned char inner[64], x[64];
    mbedtls_sha512_context sha;
    mbedtls_sha512_init(&sha);
    mbedtls_sha512_starts(&sha, 0);
    mbedtls_sha512_update(&sha, (const unsigned char *)USERNAME, strlen(USERNAME));
    mbedtls_sha512_update(&sha, (const unsigned char *)":", 1);
    mbedtls_sha512_update(&sha, (const unsigned char *)code, strlen(code));
    mbedtls_sha512_finish(&sha, inner);
    mbedtls_sha512_starts(&sha, 0);
    mbedtls_sha512_update(&sha, salt, SRP_SALT_LEN);
    mbedtls_sha512_update(&sha, inner, sizeof inner);
    mbedtls_sha512_finish(&sha, x);
    mbedtls_sha512_free(&sha);

    mbedtls_mpi n, g, mx, v;
    mbedtls_mpi_init(&n); mbedtls_mpi_init(&g); mbedtls_mpi_init(&mx); mbedtls_mpi_init(&v);
    int rc = mbedtls_mpi_read_binary(&n, SRP_N3072, sizeof SRP_N3072);
    if (!rc) rc = mbedtls_mpi_lset(&g, 5);
    if (!rc) rc = mbedtls_mpi_read_binary(&mx, x, sizeof x);
    if (!rc) rc = mbedtls_mpi_exp_mod(&v, &g, &mx, &n, NULL);
    if (!rc) rc = mbedtls_mpi_write_binary(&v, out, SRP_B_LEN);
    mbedtls_mpi_free(&n); mbedtls_mpi_free(&g); mbedtls_mpi_free(&mx); mbedtls_mpi_free(&v);
    return rc;
}

srp_device_t *srp_device_begin(const char *code, uint8_t salt[SRP_SALT_LEN], uint8_t b[SRP_B_LEN]) {
    uint8_t v[SRP_B_LEN];
    esp_fill_random(salt, SRP_SALT_LEN);
    if (verifier(code, salt, v) != 0) return NULL;

    srp_device_t *dev = calloc(1, sizeof *dev);
    if (!dev) return NULL;
    dev->handle = esp_srp_init(ESP_NG_3072);
    char *pub = NULL;
    int pub_len = 0;
    if (!dev->handle ||
        esp_srp_set_salt_verifier(dev->handle, (const char *)salt, SRP_SALT_LEN, (const char *)v, sizeof v) != ESP_OK ||
        esp_srp_srv_pubkey_from_salt_verifier(dev->handle, &pub, &pub_len) != ESP_OK || !pub || pub_len < 1 ||
        pub_len > SRP_B_LEN) {
        srp_device_free(dev);
        return NULL;
    }
    // esp_srp hands B over at its own length; the daemon is sent it whole, with zeros in front.
    memset(b, 0, SRP_B_LEN);
    memcpy(b + SRP_B_LEN - pub_len, pub, (size_t)pub_len);
    return dev;
}

int srp_device_finish(srp_device_t *dev, const uint8_t *a, size_t a_len, uint8_t key[SRP_KEY_LEN]) {
    char *k = NULL;
    uint16_t k_len = 0;
    if (!dev || !dev->handle || a_len < 1 || a_len > SRP_B_LEN) return -1;
    if (esp_srp_get_session_key(dev->handle, (char *)a, (int)a_len, &k, &k_len) != ESP_OK || !k || k_len != SRP_KEY_LEN)
        return -1;
    memcpy(key, k, SRP_KEY_LEN);
    return 0;
}

void srp_device_free(srp_device_t *dev) {
    if (!dev) return;
    if (dev->handle) esp_srp_free(dev->handle);
    free(dev);
}
