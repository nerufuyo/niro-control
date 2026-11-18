#include "battery.h"

#include "board.h"
#include "esp_adc/adc_oneshot.h"
#include "esp_adc/adc_cali.h"
#include "esp_adc/adc_cali_scheme.h"
#include "driver/gpio.h"
#include "esp_log.h"
#include "sdkconfig.h"

static const char *TAG = "battery";
static adc_oneshot_unit_handle_t unit;
static adc_cali_handle_t cali;
static bool ready;

void battery_init(void) {
    if (ready) return;
    adc_oneshot_unit_init_cfg_t unit_cfg = {.unit_id = ADC_UNIT_1};
    if (adc_oneshot_new_unit(&unit_cfg, &unit) != ESP_OK) {
        ESP_LOGW(TAG, "no ADC");
        return;
    }
    adc_oneshot_chan_cfg_t chan_cfg = {.atten = ADC_ATTEN_DB_12, .bitwidth = ADC_BITWIDTH_DEFAULT};
    if (adc_oneshot_config_channel(unit, ADC_CHANNEL_7, &chan_cfg) != ESP_OK) {
        ESP_LOGW(TAG, "no battery channel");
        return;
    }
    adc_cali_curve_fitting_config_t cali_cfg = {.unit_id = ADC_UNIT_1, .chan = ADC_CHANNEL_7, .atten = ADC_ATTEN_DB_12, .bitwidth = ADC_BITWIDTH_DEFAULT};
    if (adc_cali_create_scheme_curve_fitting(&cali_cfg, &cali) != ESP_OK) cali = NULL;
    gpio_config_t charge = {.pin_bit_mask = 1ULL << PIN_CHARGING, .mode = GPIO_MODE_INPUT};
    gpio_config(&charge);
    ready = true;
}

int battery_mv(void) {
    if (!ready) return -1;
    int sum = 0, got = 0;
    for (int i = 0; i < 8; i++) {
        int raw;
        if (adc_oneshot_read(unit, ADC_CHANNEL_7, &raw) == ESP_OK) {
            sum += raw;
            got++;
        }
    }
    if (!got) return -1;
    int raw = sum / got, pin_mv;
    if (cali) {
        if (adc_cali_raw_to_voltage(cali, raw, &pin_mv) != ESP_OK) return -1;
    } else {
        pin_mv = raw * 3100 / 4095;  // no calibration: roughly full scale at 12 dB
    }
    // The pin sits behind a divider; its ratio is a guess (Kconfig) until measured against a meter.
    return pin_mv * CONFIG_NIRO_BATTERY_DIVIDER_X10 / 10;
}

uint8_t battery_percent(void) {
    int mv = battery_mv();
    return mv < 0 ? 255 : battery_percent_from_mv(mv);
}

bool battery_charging(void) {
    if (!ready) return false;
    int level = gpio_get_level(PIN_CHARGING);
    return CONFIG_NIRO_CHARGING_ACTIVE_LOW ? level == 0 : level == 1;
}
