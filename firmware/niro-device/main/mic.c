#include "mic.h"

#include "board.h"
#include "driver/i2s_std.h"
#include "esp_log.h"
#include "sdkconfig.h"

static const char *TAG = "mic";
static i2s_chan_handle_t rx;
static bool running;

int mic_init(void) {
    if (rx) return 0;
    i2s_chan_config_t channel = I2S_CHANNEL_DEFAULT_CONFIG(I2S_NUM_0, I2S_ROLE_MASTER);
    if (i2s_new_channel(&channel, NULL, &rx) != ESP_OK) {
        ESP_LOGW(TAG, "no I2S channel");
        rx = NULL;
        return -1;
    }
    i2s_std_config_t config = {
        .clk_cfg = I2S_STD_CLK_DEFAULT_CONFIG(16000),
        // MEMS microphones send 24 bits in a 32 bit slot; which slot depends on how the L/R pin is tied.
        .slot_cfg = I2S_STD_PHILIPS_SLOT_DEFAULT_CONFIG(I2S_DATA_BIT_WIDTH_32BIT, I2S_SLOT_MODE_MONO),
        .gpio_cfg = {.mclk = I2S_GPIO_UNUSED, .bclk = PIN_MIC_SCK, .ws = PIN_MIC_WS, .dout = I2S_GPIO_UNUSED, .din = PIN_MIC_DIN},
    };
#if CONFIG_NIRO_MIC_RIGHT
    config.slot_cfg.slot_mask = I2S_STD_SLOT_RIGHT;
#endif
    if (i2s_channel_init_std_mode(rx, &config) != ESP_OK) {
        ESP_LOGW(TAG, "I2S would not start");
        i2s_del_channel(rx);
        rx = NULL;
        return -1;
    }
    return 0;
}

int mic_start(void) {
    if (!rx) return -1;
    if (!running && i2s_channel_enable(rx) != ESP_OK) return -1;
    running = true;
    return 0;
}

void mic_stop(void) {
    if (rx && running) i2s_channel_disable(rx);
    running = false;
}

int mic_read(int16_t *out, size_t samples, int timeout_ms) {
    if (!rx || !running || samples > 480) return -1;
    int32_t raw[480];
    size_t got = 0;
    esp_err_t rc = i2s_channel_read(rx, raw, samples * sizeof raw[0], &got, (uint32_t)timeout_ms);
    if (rc == ESP_ERR_TIMEOUT) return 0;
    if (rc != ESP_OK) return -1;
    size_t n = got / sizeof raw[0];
    for (size_t i = 0; i < n; i++) {
        int32_t v = raw[i] >> CONFIG_NIRO_MIC_SHIFT;
        out[i] = (int16_t)(v > 32767 ? 32767 : v < -32768 ? -32768 : v);
    }
    return (int)n;
}
