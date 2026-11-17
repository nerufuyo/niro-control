#include "gfx.h"

#include <string.h>

#include "board.h"
#include "driver/ledc.h"
#include "driver/spi_master.h"
#include "esp_heap_caps.h"
#include "esp_lcd_panel_io.h"
#include "esp_lcd_panel_ops.h"
#include "esp_lcd_panel_vendor.h"
#include "esp_log.h"
#include "font5x7.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "sdkconfig.h"

static const char *TAG = "gfx";

// A Kconfig bool that is off is not defined at all, so each is read with #ifdef.
#ifdef CONFIG_NIRO_LCD_INVERT
#define LCD_INVERT true
#else
#define LCD_INVERT false
#endif
#ifdef CONFIG_NIRO_LCD_SWAP_XY
#define LCD_SWAP_XY true
#else
#define LCD_SWAP_XY false
#endif
#ifdef CONFIG_NIRO_LCD_MIRROR_X
#define LCD_MIRROR_X true
#else
#define LCD_MIRROR_X false
#endif
#ifdef CONFIG_NIRO_LCD_MIRROR_Y
#define LCD_MIRROR_Y true
#else
#define LCD_MIRROR_Y false
#endif
static esp_lcd_panel_handle_t panel;
static uint16_t *fb;
static SemaphoreHandle_t sent;

/** The panel takes its colours big endian; the buffer holds them already swapped. */
static inline uint16_t swap(uint16_t c) { return (uint16_t)((c >> 8) | (c << 8)); }

static bool on_sent(esp_lcd_panel_io_handle_t io, esp_lcd_panel_io_event_data_t *data, void *ctx) {
    BaseType_t woken = pdFALSE;
    xSemaphoreGiveFromISR(sent, &woken);
    return woken == pdTRUE;
}

void gfx_init(void) {
    ledc_timer_config_t timer = {
        .speed_mode = LEDC_LOW_SPEED_MODE, .duty_resolution = LEDC_TIMER_10_BIT, .timer_num = LEDC_TIMER_0,
        .freq_hz = 5000, .clk_cfg = LEDC_AUTO_CLK,
    };
    ESP_ERROR_CHECK(ledc_timer_config(&timer));
    ledc_channel_config_t channel = {
        .gpio_num = PIN_LCD_BL, .speed_mode = LEDC_LOW_SPEED_MODE, .channel = LEDC_CHANNEL_0,
        .timer_sel = LEDC_TIMER_0, .duty = 0, .hpoint = 0,
    };
    ESP_ERROR_CHECK(ledc_channel_config(&channel));

    spi_bus_config_t bus = {
        .mosi_io_num = PIN_LCD_MOSI, .miso_io_num = -1, .sclk_io_num = PIN_LCD_SCLK,
        .quadwp_io_num = -1, .quadhd_io_num = -1, .max_transfer_sz = LCD_W * LCD_H * 2,
    };
    ESP_ERROR_CHECK(spi_bus_initialize(SPI2_HOST, &bus, SPI_DMA_CH_AUTO));

    sent = xSemaphoreCreateBinary();
    esp_lcd_panel_io_handle_t io;
    esp_lcd_panel_io_spi_config_t io_config = {
        .cs_gpio_num = PIN_LCD_CS, .dc_gpio_num = PIN_LCD_DC, .spi_mode = 3, .pclk_hz = 80 * 1000 * 1000,
        .trans_queue_depth = 10, .lcd_cmd_bits = 8, .lcd_param_bits = 8,
        .on_color_trans_done = on_sent,
    };
    ESP_ERROR_CHECK(esp_lcd_new_panel_io_spi((esp_lcd_spi_bus_handle_t)SPI2_HOST, &io_config, &io));

    esp_lcd_panel_dev_config_t panel_config = {
        .reset_gpio_num = PIN_LCD_RST, .rgb_ele_order = LCD_RGB_ELEMENT_ORDER_RGB, .bits_per_pixel = 16,
    };
    ESP_ERROR_CHECK(esp_lcd_new_panel_st7789(io, &panel_config, &panel));
    ESP_ERROR_CHECK(esp_lcd_panel_reset(panel));
    ESP_ERROR_CHECK(esp_lcd_panel_init(panel));
    ESP_ERROR_CHECK(esp_lcd_panel_invert_color(panel, LCD_INVERT));
    ESP_ERROR_CHECK(esp_lcd_panel_swap_xy(panel, LCD_SWAP_XY));
    ESP_ERROR_CHECK(esp_lcd_panel_mirror(panel, LCD_MIRROR_X, LCD_MIRROR_Y));
    ESP_ERROR_CHECK(esp_lcd_panel_set_gap(panel, CONFIG_NIRO_LCD_GAP_X, CONFIG_NIRO_LCD_GAP_Y));

    fb = heap_caps_malloc(LCD_W * LCD_H * 2, MALLOC_CAP_DMA | MALLOC_CAP_INTERNAL);
    if (!fb) {
        ESP_LOGE(TAG, "no memory for the frame buffer");
        abort();
    }
    gfx_clear(COL_BLACK);
    gfx_flush();
    ESP_ERROR_CHECK(esp_lcd_panel_disp_on_off(panel, true));
    gfx_backlight(100);
    ESP_LOGI(TAG, "display ready: %dx%d", LCD_W, LCD_H);
}

void gfx_backlight(int percent) {
    if (percent < 0) percent = 0;
    if (percent > 100) percent = 100;
    ledc_set_duty(LEDC_LOW_SPEED_MODE, LEDC_CHANNEL_0, (uint32_t)(1023 * percent / 100));
    ledc_update_duty(LEDC_LOW_SPEED_MODE, LEDC_CHANNEL_0);
}

void gfx_clear(uint16_t colour) {
    uint16_t c = swap(colour);
    for (int i = 0; i < LCD_W * LCD_H; i++) fb[i] = c;
}

void gfx_rect(int x, int y, int w, int h, uint16_t colour) {
    uint16_t c = swap(colour);
    for (int j = y; j < y + h; j++) {
        if (j < 0 || j >= LCD_H) continue;
        for (int i = x; i < x + w; i++)
            if (i >= 0 && i < LCD_W) fb[j * LCD_W + i] = c;
    }
}

static void glyph(int x, int y, int scale, uint16_t fg, uint16_t bg, char ch) {
    const uint8_t *cols = (ch >= 32 && ch <= 126) ? FONT5X7[ch - 32] : FONT5X7[0];
    for (int cx = 0; cx < 6; cx++) {
        uint8_t bits = cx < 5 ? cols[cx] : 0;
        for (int cy = 0; cy < 8; cy++) gfx_rect(x + cx * scale, y + cy * scale, scale, scale, (bits >> cy) & 1 ? fg : bg);
    }
}

void gfx_text(int x, int y, int scale, uint16_t fg, uint16_t bg, const char *text) {
    for (; *text; text++, x += 6 * scale) glyph(x, y, scale, fg, bg, *text);
}

void gfx_text_center(int y, int scale, uint16_t fg, uint16_t bg, const char *text) {
    int width = (int)strlen(text) * 6 * scale;
    gfx_text((LCD_W - width) / 2, y, scale, fg, bg, text);
}

void gfx_flush(void) {
    ESP_ERROR_CHECK(esp_lcd_panel_draw_bitmap(panel, 0, 0, LCD_W, LCD_H, fb));
    xSemaphoreTake(sent, pdMS_TO_TICKS(1000));
}
