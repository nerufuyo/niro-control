#include "store.h"

#include <string.h>

#include "nvs.h"
#include "nvs_flash.h"

#define NS "niro"

void store_init(void) {
    esp_err_t err = nvs_flash_init();
    if (err == ESP_ERR_NVS_NO_FREE_PAGES || err == ESP_ERR_NVS_NEW_VERSION_FOUND) {
        ESP_ERROR_CHECK(nvs_flash_erase());
        err = nvs_flash_init();
    }
    ESP_ERROR_CHECK(err);
}

bool store_get_wifi(char ssid[33], char pass[65]) {
    nvs_handle_t h;
    if (nvs_open(NS, NVS_READONLY, &h) != ESP_OK) return false;
    size_t a = 33, b = 65;
    bool ok = nvs_get_str(h, "ssid", ssid, &a) == ESP_OK && ssid[0];
    if (ok && nvs_get_str(h, "pass", pass, &b) != ESP_OK) pass[0] = 0;
    nvs_close(h);
    return ok;
}

void store_set_wifi(const char *ssid, const char *pass) {
    nvs_handle_t h;
    if (nvs_open(NS, NVS_READWRITE, &h) != ESP_OK) return;
    nvs_set_str(h, "ssid", ssid);
    nvs_set_str(h, "pass", pass);
    nvs_commit(h);
    nvs_close(h);
}

void store_clear_wifi(void) {
    nvs_handle_t h;
    if (nvs_open(NS, NVS_READWRITE, &h) != ESP_OK) return;
    nvs_erase_key(h, "ssid");
    nvs_erase_key(h, "pass");
    nvs_commit(h);
    nvs_close(h);
}

bool store_get_pairing(uint8_t daemon_id[16], uint8_t device_key[32]) {
    nvs_handle_t h;
    if (nvs_open(NS, NVS_READONLY, &h) != ESP_OK) return false;
    size_t a = 16, b = 32;
    bool ok = nvs_get_blob(h, "daemon", daemon_id, &a) == ESP_OK && a == 16 &&
              nvs_get_blob(h, "key", device_key, &b) == ESP_OK && b == 32;
    nvs_close(h);
    return ok;
}

void store_set_pairing(const uint8_t daemon_id[16], const uint8_t device_key[32]) {
    nvs_handle_t h;
    if (nvs_open(NS, NVS_READWRITE, &h) != ESP_OK) return;
    nvs_set_blob(h, "daemon", daemon_id, 16);
    nvs_set_blob(h, "key", device_key, 32);
    nvs_commit(h);
    nvs_close(h);
}

void store_clear_pairing(void) {
    nvs_handle_t h;
    if (nvs_open(NS, NVS_READWRITE, &h) != ESP_OK) return;
    nvs_erase_key(h, "daemon");
    nvs_erase_key(h, "key");
    nvs_commit(h);
    nvs_close(h);
}
