#include "net.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "esp_event.h"
#include "esp_log.h"
#include "esp_netif.h"
#include "esp_wifi.h"
#include "freertos/FreeRTOS.h"
#include "freertos/event_groups.h"
#include "lwip/sockets.h"
#include "mdns.h"
#include "store.h"

static const char *TAG = "net";
static EventGroupHandle_t bits;
#define GOT_IP BIT0
static bool have_credentials;

static void on_event(void *arg, esp_event_base_t base, int32_t id, void *data) {
    if (base == WIFI_EVENT && id == WIFI_EVENT_STA_START) {
        ESP_LOGI(TAG, "wifi started; a network is %s", have_credentials ? "saved" : "not saved");
        if (have_credentials) {
            esp_err_t err = esp_wifi_connect();
            if (err != ESP_OK) ESP_LOGW(TAG, "connect failed: %s", esp_err_to_name(err));
        }
    } else if (base == WIFI_EVENT && id == WIFI_EVENT_STA_CONNECTED) {
        ESP_LOGI(TAG, "joined the network, waiting for an address");
    } else if (base == WIFI_EVENT && id == WIFI_EVENT_STA_DISCONNECTED) {
        wifi_event_sta_disconnected_t *gone = data;
        ESP_LOGW(TAG, "wifi disconnected, reason %d", gone ? gone->reason : -1);
        xEventGroupClearBits(bits, GOT_IP);
        if (have_credentials) {
            vTaskDelay(pdMS_TO_TICKS(1000));
            esp_err_t err = esp_wifi_connect();
            if (err != ESP_OK) ESP_LOGW(TAG, "connect failed: %s", esp_err_to_name(err));
        }
    } else if (base == IP_EVENT && id == IP_EVENT_STA_GOT_IP) {
        xEventGroupSetBits(bits, GOT_IP);
        ESP_LOGI(TAG, "wifi up");
    }
}

static void apply(const char *ssid, const char *pass) {
    wifi_config_t config = {0};
    strlcpy((char *)config.sta.ssid, ssid, sizeof config.sta.ssid);
    strlcpy((char *)config.sta.password, pass, sizeof config.sta.password);
    config.sta.threshold.authmode = pass[0] ? WIFI_AUTH_WPA2_PSK : WIFI_AUTH_OPEN;
    ESP_ERROR_CHECK(esp_wifi_set_config(WIFI_IF_STA, &config));
}

void net_start(void) {
    bits = xEventGroupCreate();
    ESP_ERROR_CHECK(esp_netif_init());
    ESP_ERROR_CHECK(esp_event_loop_create_default());
    esp_netif_create_default_wifi_sta();
    wifi_init_config_t init = WIFI_INIT_CONFIG_DEFAULT();
    ESP_ERROR_CHECK(esp_wifi_init(&init));
    ESP_ERROR_CHECK(esp_event_handler_register(WIFI_EVENT, ESP_EVENT_ANY_ID, on_event, NULL));
    ESP_ERROR_CHECK(esp_event_handler_register(IP_EVENT, IP_EVENT_STA_GOT_IP, on_event, NULL));
    ESP_ERROR_CHECK(esp_wifi_set_mode(WIFI_MODE_STA));
    char ssid[33], pass[65] = "";
    have_credentials = store_get_wifi(ssid, pass);
    if (have_credentials) apply(ssid, pass);
    ESP_ERROR_CHECK(esp_wifi_start());
    ESP_ERROR_CHECK(mdns_init());
}

bool net_connected(void) { return xEventGroupGetBits(bits) & GOT_IP; }

void net_set_credentials(const char *ssid, const char *pass) {
    store_set_wifi(ssid, pass);
    // Stop the attempt that is running (it holds the driver in "connecting") before the new network is tried.
    have_credentials = false;
    esp_wifi_disconnect();
    vTaskDelay(pdMS_TO_TICKS(300));
    have_credentials = true;
    apply(ssid, pass);
    esp_err_t err = esp_wifi_connect();
    ESP_LOGI(TAG, "joining \"%s\": %s", ssid, esp_err_to_name(err));
}

void net_describe(char *out, size_t cap) {
    char ssid[33], pass[65] = "";
    bool saved = store_get_wifi(ssid, pass);
    snprintf(out, cap, "network: %s%s%s, %s, signal %d dBm", saved ? "\"" : "none", saved ? ssid : "", saved ? "\"" : "",
             net_connected() ? "connected" : "not connected", net_rssi());
}

int net_rssi(void) {
    wifi_ap_record_t ap;
    return esp_wifi_sta_get_ap_info(&ap) == ESP_OK ? ap.rssi : -127;
}

bool net_find_daemon(const char *want_id, bool need_pair, daemon_t *out) {
    mdns_result_t *results = NULL;
    if (mdns_query_ptr("_niro-device", "_tcp", 3000, 8, &results) != ESP_OK || !results) return false;
    bool found = false;
    for (mdns_result_t *r = results; r && !found; r = r->next) {
        char id[40] = "";
        bool pair = false;
        for (size_t i = 0; i < r->txt_count; i++) {
            const char *key = r->txt[i].key, *value = r->txt[i].value;
            if (!key || !value) continue;
            if (!strcmp(key, "id")) strlcpy(id, value, sizeof id);
            else if (!strcmp(key, "pair")) pair = value[0] == '1';
        }
        if (strlen(id) != 32) continue;
        if (want_id && strcmp(want_id, id)) continue;
        if (need_pair && !pair) continue;
        esp_ip4_addr_t ip = {0};
        for (mdns_ip_addr_t *a = r->addr; a; a = a->next)
            if (a->addr.type == ESP_IPADDR_TYPE_V4) {
                ip = a->addr.u_addr.ip4;
                break;
            }
        if (!ip.addr && r->hostname) mdns_query_a(r->hostname, 2000, &ip);
        if (!ip.addr) continue;
        out->ip = ip.addr;
        out->port = r->port;
        out->pair_open = pair;
        strlcpy(out->id, id, sizeof out->id);
        found = true;
    }
    mdns_query_results_free(results);
    return found;
}

int net_connect(const daemon_t *daemon) {
    int fd = socket(AF_INET, SOCK_STREAM, IPPROTO_IP);
    if (fd < 0) return -1;
    struct timeval timeout = {.tv_sec = 5};
    setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &timeout, sizeof timeout);
    int one = 1;
    setsockopt(fd, IPPROTO_TCP, TCP_NODELAY, &one, sizeof one);
    struct sockaddr_in address = {.sin_family = AF_INET, .sin_port = htons(daemon->port), .sin_addr.s_addr = daemon->ip};
    if (connect(fd, (struct sockaddr *)&address, sizeof address) != 0) {
        close(fd);
        return -1;
    }
    return fd;
}

void net_scan(void) {
    // A scan cannot run while the station is busy joining: stop trying for its length, and go on after.
    bool was = have_credentials;
    have_credentials = false;
    esp_wifi_disconnect();
    vTaskDelay(pdMS_TO_TICKS(300));
    wifi_scan_config_t config = {.show_hidden = true};
    esp_err_t err = esp_wifi_scan_start(&config, true);
    if (err != ESP_OK) {
        printf("scan failed: %s\n", esp_err_to_name(err));
    } else {
        uint16_t count = 0;
        esp_wifi_scan_get_ap_num(&count);
        if (count > 30) count = 30;
        wifi_ap_record_t *list = calloc(count ? count : 1, sizeof *list);
        if (list && esp_wifi_scan_get_ap_records(&count, list) == ESP_OK) {
            printf("%u networks (2.4 GHz only):\n", count);
            for (int i = 0; i < count; i++) {
                const char *security = list[i].authmode == WIFI_AUTH_OPEN ? "open" :
                                       list[i].authmode == WIFI_AUTH_WPA3_PSK ? "WPA3" :
                                       list[i].authmode == WIFI_AUTH_WPA2_WPA3_PSK ? "WPA2/WPA3" :
                                       list[i].authmode == WIFI_AUTH_WPA_PSK ? "WPA" : "WPA2";
                printf("  %-32s ch %2d  %4d dBm  %s\n", list[i].ssid[0] ? (char *)list[i].ssid : "(hidden)", list[i].primary,
                       list[i].rssi, security);
            }
        }
        free(list);
    }
    have_credentials = was;
    if (was) esp_wifi_connect();
}
