#include "face_task.h"

#include <string.h>

#include "draw.h"
#include "esp_log.h"
#include "esp_random.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "freertos/task.h"
#include "gfx.h"

static SemaphoreHandle_t lock;  // held while a frame is built and sent, and while the face's state is changed
static volatile bool active;
static char caption[24];

static const char *TAG = "face";

static void task(void *arg) {
    int64_t last = esp_timer_get_time();
    int64_t report = last, draw_us = 0;
    int frames = 0;
    for (;;) {
        if (active) {
            xSemaphoreTake(lock, portMAX_DELAY);
            if (active) {
                int64_t now = esp_timer_get_time();
                face_step((int)((now - last) / 1000));
                last = now;
                uint16_t *canvas = gfx_canvas();
                int64_t drawn = esp_timer_get_time();
                face_draw(canvas);
                draw_us += esp_timer_get_time() - drawn;
                frames++;
                if (caption[0]) {
                    int width = (int)strlen(caption) * 12;
                    draw_text(canvas, (240 - width) / 2, 218, 2, (rgb_t){190, 220, 255}, .95f, caption);
                }
                gfx_flush();
                if (now - report >= 5000000) {
                    ESP_LOGI(TAG, "%d fps, drawing a frame takes %d ms", (int)(frames * 1000000LL / (now - report)),
                             frames ? (int)(draw_us / frames / 1000) : 0);
                    report = now; frames = 0; draw_us = 0;
                }
            }
            xSemaphoreGive(lock);
        } else {
            last = esp_timer_get_time();
        }
        vTaskDelay(pdMS_TO_TICKS(8));
    }
}

void face_task_start(void) {
    lock = xSemaphoreCreateMutex();
    face_init(esp_random());
    xTaskCreate(task, "face", 6144, NULL, 4, NULL);
}

void face_show(void) { active = true; }

void face_hide(void) {
    active = false;
    xSemaphoreTake(lock, portMAX_DELAY);  // a frame in progress finishes first
    xSemaphoreGive(lock);
}

void face_task_mood(face_mood_t mood, const char *text) {
    xSemaphoreTake(lock, portMAX_DELAY);
    face_set(mood);
    strlcpy(caption, text ? text : "", sizeof caption);
    xSemaphoreGive(lock);
}

void face_task_poke(void) {
    xSemaphoreTake(lock, portMAX_DELAY);
    face_poke();
    xSemaphoreGive(lock);
}
