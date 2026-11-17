// What survives a restart, in NVS: the Wi-Fi network, and who this device is paired with.
#pragma once
#include <stdbool.h>
#include <stdint.h>

void store_init(void);
bool store_get_wifi(char ssid[33], char pass[65]);
void store_set_wifi(const char *ssid, const char *pass);
void store_clear_wifi(void);
bool store_get_pairing(uint8_t daemon_id[16], uint8_t device_key[32]);
void store_set_pairing(const uint8_t daemon_id[16], const uint8_t device_key[32]);
void store_clear_pairing(void);
