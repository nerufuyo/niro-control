#include "buttons.h"

#include "board.h"
#include "driver/gpio.h"
#include "esp_timer.h"
#include "freertos/task.h"

#define POLL_MS 10
#define DEBOUNCE_MS 30
#define LONG_MS 800

static QueueHandle_t events;
static const int PINS[3] = {PIN_BTN_UP, PIN_BTN_BOOT, PIN_BTN_DOWN};

static void poll(void *arg) {
    bool down[3] = {0};
    bool long_sent[3] = {0};
    int64_t since[3] = {0};
    for (;;) {
        int64_t now = esp_timer_get_time() / 1000;
        for (int i = 0; i < 3; i++) {
            bool low = gpio_get_level(PINS[i]) == 0;
            if (low && !down[i]) {
                down[i] = true;
                long_sent[i] = false;
                since[i] = now;
            } else if (low && down[i] && !long_sent[i] && now - since[i] >= LONG_MS) {
                long_sent[i] = true;
                button_event_t event = {i, PRESS_LONG};
                xQueueSend(events, &event, 0);
            } else if (!low && down[i]) {
                down[i] = false;
                if (!long_sent[i] && now - since[i] >= DEBOUNCE_MS) {
                    button_event_t event = {i, PRESS_SHORT};
                    xQueueSend(events, &event, 0);
                }
            }
        }
        vTaskDelay(pdMS_TO_TICKS(POLL_MS));
    }
}

QueueHandle_t buttons_start(void) {
    for (int i = 0; i < 3; i++) {
        gpio_config_t config = {
            .pin_bit_mask = 1ULL << PINS[i], .mode = GPIO_MODE_INPUT, .pull_up_en = GPIO_PULLUP_ENABLE,
        };
        gpio_config(&config);
    }
    events = xQueueCreate(8, sizeof(button_event_t));
    xTaskCreate(poll, "buttons", 3072, NULL, 5, NULL);
    return events;
}
