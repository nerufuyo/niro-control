#include "console.h"

#include <stdio.h>
#include <string.h>

#include "argtable3/argtable3.h"
#include "esp_console.h"
#include "esp_system.h"
#include "net.h"
#include "store.h"

static struct {
    struct arg_str *ssid, *pass;
    struct arg_end *end;
} wifi_args;

static int cmd_wifi(int argc, char **argv) {
    if (arg_parse(argc, argv, (void **)&wifi_args) != 0) {
        arg_print_errors(stderr, wifi_args.end, argv[0]);
        return 1;
    }
    net_set_credentials(wifi_args.ssid->sval[0], wifi_args.pass->count ? wifi_args.pass->sval[0] : "");
    printf("joining %s\n", wifi_args.ssid->sval[0]);
    return 0;
}

static int cmd_forget(int argc, char **argv) {
    store_clear_wifi();
    printf("wifi forgotten; restart to apply\n");
    return 0;
}

static int cmd_unpair(int argc, char **argv) {
    store_clear_pairing();
    printf("pairing forgotten; restarting\n");
    esp_restart();
    return 0;
}

static int cmd_status(int argc, char **argv) {
    char line[128];
    net_describe(line, sizeof line);
    uint8_t id[16], key[32];
    printf("%s; %s\n", line, store_get_pairing(id, key) ? "paired" : "not paired");
    return 0;
}

static int cmd_scan(int argc, char **argv) {
    net_scan();
    return 0;
}

static int cmd_restart(int argc, char **argv) {
    esp_restart();
    return 0;
}

void console_start(void) {
    esp_console_repl_t *repl = NULL;
    esp_console_repl_config_t repl_config = ESP_CONSOLE_REPL_CONFIG_DEFAULT();
    repl_config.prompt = "niro> ";
    esp_console_dev_uart_config_t uart = ESP_CONSOLE_DEV_UART_CONFIG_DEFAULT();
    ESP_ERROR_CHECK(esp_console_new_repl_uart(&uart, &repl_config, &repl));

    wifi_args.ssid = arg_str1(NULL, NULL, "<ssid>", "the network's name");
    wifi_args.pass = arg_str0(NULL, NULL, "<password>", "its password, none for an open network");
    wifi_args.end = arg_end(2);
    const esp_console_cmd_t wifi = {.command = "wifi", .help = "Join a Wi-Fi network and remember it", .func = cmd_wifi,
                                    .argtable = &wifi_args};
    const esp_console_cmd_t forget = {.command = "forget", .help = "Forget the Wi-Fi network", .func = cmd_forget};
    const esp_console_cmd_t unpair = {.command = "unpair", .help = "Forget the pairing and restart", .func = cmd_unpair};
    const esp_console_cmd_t restart = {.command = "restart", .help = "Restart", .func = cmd_restart};
    const esp_console_cmd_t status = {.command = "status", .help = "Show the network and whether it is paired", .func = cmd_status};
    const esp_console_cmd_t scan = {.command = "scan", .help = "List the Wi-Fi networks in range", .func = cmd_scan};
    ESP_ERROR_CHECK(esp_console_cmd_register(&scan));
    ESP_ERROR_CHECK(esp_console_cmd_register(&status));
    ESP_ERROR_CHECK(esp_console_cmd_register(&wifi));
    ESP_ERROR_CHECK(esp_console_cmd_register(&forget));
    ESP_ERROR_CHECK(esp_console_cmd_register(&unpair));
    ESP_ERROR_CHECK(esp_console_cmd_register(&restart));
    ESP_ERROR_CHECK(esp_console_start_repl(repl));
}
