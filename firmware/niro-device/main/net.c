#include "net.h"

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
        if (have_credentials) esp_wifi_connect();
    } else if (base == WIFI_EVENT && id == WIFI_EVENT_STA_DISCONNECTED) {
        xEventGroupClearBits(bits, GOT_IP);
        if (have_credentials) {
            vTaskDelay(pdMS_TO_TICKS(1000));
            esp_wifi_connect();
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
    have_credentials = true;
    apply(ssid, pass);
    esp_wifi_disconnect();
    esp_wifi_connect();
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
