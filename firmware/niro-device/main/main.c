// The Niro Device: an assistant with a screen and three buttons that pairs with one user's Niro by a code and then
// shows its notifications. See docs/device-protocol.md, docs/device-hardware.md.
#include <stdio.h>
#include <string.h>

#include "board.h"
#include "buttons.h"
#include "cJSON.h"
#include "console.h"
#include "face_task.h"
#include "esp_log.h"
#include "esp_mac.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "gfx.h"
#include "link.h"
#include "lwip/sockets.h"
#include "net.h"
#include "pair.h"
#include "store.h"
#include "ui.h"

static const char *TAG = "niro";
#define FIRMWARE "0.1.0"

static QueueHandle_t buttons;
static char device_id[18];    // the MAC, as the daemon is told it
static char device_name[24];  // "Niro Device 9D34"

static int64_t now_ms(void) { return esp_timer_get_time() / 1000; }

/** The face with a few words under it (19 characters at most): how the device says what it is doing. */
static void mood(face_mood_t m, const char *caption) {
    face_task_mood(m, caption);
    face_show();
}
static void sleep_ms(int ms) { vTaskDelay(pdMS_TO_TICKS(ms)); }

static bool next_button(button_event_t *event, int wait_ms) { return xQueueReceive(buttons, event, pdMS_TO_TICKS(wait_ms)) == pdTRUE; }

/** Tries the code on the daemon that has one open, and says how it went. */
static void run_pairing(const char *code) {
    mood(FACE_SEARCHING, "LOOKING FOR PC");
    daemon_t daemon;
    bool found = false;
    for (int attempt = 0; attempt < 4 && !found; attempt++) found = net_find_daemon(NULL, true, &daemon);
    if (!found) {
        mood(FACE_SAD, "NO PC IN PAIR MODE");
        sleep_ms(4000);
        return;
    }
    int fd = net_connect(&daemon);
    if (fd < 0) {
        mood(FACE_SAD, "CANNOT REACH PC");
        sleep_ms(3000);
        return;
    }
    mood(FACE_THINKING, "ALLOW IT ON YOUR PC");
    uint8_t daemon_id[16], key[32];
    pair_result_t result = pair_with_daemon(fd, code, device_id, device_name, daemon_id, key);
    close(fd);
    switch (result) {
    case PAIR_OK:
        store_set_pairing(daemon_id, key);
        mood(FACE_HAPPY, "PAIRED!");
        break;
    case PAIR_CODE: mood(FACE_SAD, "WRONG CODE"); break;
    case PAIR_DENIED: mood(FACE_SAD, "NOT ALLOWED"); break;
    case PAIR_NETWORK: mood(FACE_SAD, "CANNOT REACH PC"); break;
    default: mood(FACE_SAD, "PAIRING FAILED"); break;
    }
    sleep_ms(2500);
}

/** Six digits typed with the buttons: up and down change one, BOOT moves on, a long BOOT gives up. */
static void enter_code(void) {
    xQueueReset(buttons);
    uint8_t digits[6] = {0};
    int cursor = 0;
    for (;;) {
        ui_code_entry(digits, cursor, "UP DOWN  BOOT NEXT");
        button_event_t event;
        if (!next_button(&event, 60000)) return;
        if (event.kind == PRESS_LONG && event.id == BTN_BOOT) return;
        if (event.kind != PRESS_SHORT) continue;
        if (event.id == BTN_UP) digits[cursor] = (digits[cursor] + 1) % 10;
        else if (event.id == BTN_DOWN) digits[cursor] = (digits[cursor] + 9) % 10;
        else if (++cursor == 6) {
            char code[7];
            for (int i = 0; i < 6; i++) code[i] = (char)('0' + digits[i]);
            code[6] = 0;
            run_pairing(code);
            return;
        }
    }
}

static void unpaired(void) {
    mood(FACE_CURIOUS, "BOOT: PAIR ME");
    button_event_t event;
    if (next_button(&event, 1000) && event.id == BTN_BOOT && event.kind == PRESS_SHORT) enter_code();
}

/** The mood a `face` message names, or -1. */
static int face_in(const char *json) {
    cJSON *msg = cJSON_Parse(json);
    const cJSON *name = msg ? cJSON_GetObjectItem(msg, "name") : NULL;
    int found = cJSON_IsString(name) ? face_from_name(name->valuestring) : -1;
    cJSON_Delete(msg);
    return found;
}

/** Is it urgent? */
static bool urgent_in(const char *json) {
    cJSON *msg = cJSON_Parse(json);
    bool urgent = cJSON_IsTrue(cJSON_GetObjectItem(msg, "urgent"));
    cJSON_Delete(msg);
    return urgent;
}

static void show_notification(const char *json) {
    cJSON *msg = cJSON_Parse(json);
    if (!msg) return;
    const cJSON *t = cJSON_GetObjectItem(msg, "t");
    if (cJSON_IsString(t) && !strcmp(t->valuestring, "notify")) {
        const cJSON *title = cJSON_GetObjectItem(msg, "title"), *body = cJSON_GetObjectItem(msg, "body");
        const cJSON *urgent = cJSON_GetObjectItem(msg, "urgent");
        ui_notification(cJSON_IsString(title) ? title->valuestring : "", cJSON_IsString(body) ? body->valuestring : "",
                        cJSON_IsTrue(urgent));
    }
    cJSON_Delete(msg);
}

/** What the daemon sent: 1 a notification, 2 goodbye, 3 a face, 0 anything else. */
static int kind_of(const char *json) {
    cJSON *msg = cJSON_Parse(json);
    const cJSON *t = msg ? cJSON_GetObjectItem(msg, "t") : NULL;
    int kind = 0;
    if (cJSON_IsString(t)) kind = !strcmp(t->valuestring, "notify") ? 1 : !strcmp(t->valuestring, "bye") ? 2 : !strcmp(t->valuestring, "face") ? 3 : 0;
    cJSON_Delete(msg);
    return kind;
}

/** Connects to the paired daemon and serves the connection until it ends. */
static void serve(const uint8_t daemon_id[16], const uint8_t key[32]) {
    static int refused;  // in a row; a daemon that no longer knows us gives no answer
    char id_hex[33];
    niro_hex_encode(daemon_id, 16, id_hex);
    daemon_t daemon;
    int fd = -1;
    if (net_find_daemon(id_hex, false, &daemon)) fd = net_connect(&daemon);
    link_t link;
    if (fd < 0 || link_open(&link, fd, key, device_id) != 0) {
        if (fd >= 0) {
            close(fd);
            refused++;
        }
        if (refused >= 4) {
            mood(FACE_SAD, "HOLD BOOT: FORGET PC");
            button_event_t event;
            if (next_button(&event, 5000) && event.id == BTN_BOOT && event.kind == PRESS_LONG) {
                store_clear_pairing();
                refused = 0;
            }
        } else {
            mood(FACE_SAD, "OFFLINE");
            sleep_ms(5000);
        }
        return;
    }
    refused = 0;
    ESP_LOGI(TAG, "connected");
    mood(FACE_HAPPY, "CONNECTED");
    int64_t connected_at = now_ms();

    int64_t last_ping = 0, last_status = -30000, shown_until = 0;
    bool notifying = false;
    for (;;) {
        int64_t now = now_ms();
        if (connected_at && now - connected_at > 4000) {
            connected_at = 0;
            mood(FACE_IDLE, NULL);
        }
        if (now - last_ping >= 15000) {
            if (link_send(&link, "{\"t\":\"ping\"}") != 0) break;
            last_ping = now;
        }
        if (now - last_status >= 30000) {
            char status[160];
            // The battery is not read yet: 255 says so.
            snprintf(status, sizeof status, "{\"t\":\"status\",\"battery\":255,\"charging\":false,\"temp_c\":0.0,\"rssi\":%d,\"fw\":\"%s\"}",
                     net_rssi(), FIRMWARE);
            if (link_send(&link, status) != 0) break;
            last_status = now;
        }
        char text[LINK_PAYLOAD_MAX + 1];
        size_t len = 0;
        int got = link_recv(&link, text, sizeof text, &len, 200);
        if (got < 0) break;
        if (got == 1 && len) {
            int kind = kind_of(text);
            if (kind == 2) break;
            face_task_poke();
            if (kind == 3 && !notifying) {
                int m = face_in(text);
                if (m >= 0) mood((face_mood_t)m, NULL);
            }
            if (kind == 1) {
                // The slime reacts first, then the words.
                mood(urgent_in(text) ? FACE_ALERT : FACE_HAPPY, urgent_in(text) ? "ATTENTION!" : "NEW MESSAGE");
                sleep_ms(1400);
                show_notification(text);
                notifying = true;
                shown_until = now_ms() + 30000;
            }
        }
        button_event_t event;
        while (next_button(&event, 0))
            if (notifying) {
                notifying = false;
                mood(FACE_IDLE, NULL);
            }
        if (notifying && now_ms() > shown_until) {
            notifying = false;
            mood(FACE_IDLE, NULL);
        }
    }
    close(fd);
    ESP_LOGI(TAG, "disconnected");
    mood(FACE_SAD, "OFFLINE");
    sleep_ms(3000);
}

void app_main(void) {
    store_init();
    gfx_init();
    face_task_start();
    mood(FACE_WAKING, NULL);
    buttons = buttons_start();
    net_start();
    console_start();

    uint8_t mac[6];
    esp_read_mac(mac, ESP_MAC_WIFI_STA);
    snprintf(device_id, sizeof device_id, "%02x:%02x:%02x:%02x:%02x:%02x", mac[0], mac[1], mac[2], mac[3], mac[4], mac[5]);
    snprintf(device_name, sizeof device_name, "Niro Device %02X%02X", mac[4], mac[5]);
    ESP_LOGI(TAG, "%s (%s) firmware %s", device_name, device_id, FIRMWARE);

    for (;;) {
        char ssid[33], pass[65] = "";
        if (!store_get_wifi(ssid, pass)) {
            mood(FACE_SEARCHING, "NO WIFI: USE SERIAL");
            sleep_ms(2000);
            continue;
        }
        if (!net_connected()) {
            mood(FACE_SEARCHING, "JOINING WIFI");
            sleep_ms(1500);
            continue;
        }
        uint8_t daemon_id[16], key[32];
        if (store_get_pairing(daemon_id, key)) serve(daemon_id, key);
        else unpaired();
    }
}
