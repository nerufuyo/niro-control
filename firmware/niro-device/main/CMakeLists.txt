idf_component_register(
    SRCS "main.c" "gfx.c" "buttons.c" "store.c" "net.c" "link.c" "pair.c" "ui.c" "console.c" "face.c" "draw.c" "face_task.c" "srp_device.c" "battery.c" "mic.c" "adpcm.c" "spk.c" "hud.c"
    INCLUDE_DIRS "."
    REQUIRES nvs_flash esp_driver_gpio esp_driver_ledc esp_driver_spi esp_lcd esp_timer esp_wifi esp_netif esp_event
             lwip mdns json console protocomm mbedtls esp_system esp_hw_support esp_adc esp_driver_i2s
)
