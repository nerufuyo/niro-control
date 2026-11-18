#include "spk.h"

#include "board.h"
#include "driver/i2s_std.h"
#include "esp_log.h"

static const char *TAG = "spk";
static i2s_chan_handle_t tx;
static bool running;
static int volume = 70;

int spk_init(void) {
    if (tx) return 0;
    i2s_chan_config_t channel = I2S_CHANNEL_DEFAULT_CONFIG(I2S_NUM_1, I2S_ROLE_MASTER);
    if (i2s_new_channel(&channel, &tx, NULL) != ESP_OK) {
        ESP_LOGW(TAG, "no I2S channel");
        tx = NULL;
        return -1;
    }
    i2s_std_config_t config = {
        .clk_cfg = I2S_STD_CLK_DEFAULT_CONFIG(16000),
        .slot_cfg = I2S_STD_PHILIPS_SLOT_DEFAULT_CONFIG(I2S_DATA_BIT_WIDTH_16BIT, I2S_SLOT_MODE_MONO),
        .gpio_cfg = {.mclk = I2S_GPIO_UNUSED, .bclk = PIN_SPK_BCLK, .ws = PIN_SPK_LRCK, .dout = PIN_SPK_DOUT, .din = I2S_GPIO_UNUSED},
    };
    if (i2s_channel_init_std_mode(tx, &config) != ESP_OK) {
        ESP_LOGW(TAG, "I2S would not start");
        i2s_del_channel(tx);
        tx = NULL;
        return -1;
    }
    return 0;
}

void spk_set_volume(int percent) { volume = percent < 0 ? 0 : percent > 100 ? 100 : percent; }

void spk_play(const int16_t *pcm, size_t n) {
    if (!tx || volume == 0 || n > 480) return;
    if (!running) {
        if (i2s_channel_enable(tx) != ESP_OK) return;
        running = true;
    }
    int16_t scaled[480];
    // Loudness by the square of the setting: the ear hears a ratio, so the middle of the dial is not half the amplitude.
    int gain = volume * volume * 256 / 10000;  // 0..256
    for (size_t i = 0; i < n; i++) scaled[i] = (int16_t)(pcm[i] * gain / 256);
    size_t written = 0;
    i2s_channel_write(tx, scaled, n * sizeof scaled[0], &written, 500);
}

void spk_stop(void) {
    if (tx && running) i2s_channel_disable(tx);
    running = false;
}
