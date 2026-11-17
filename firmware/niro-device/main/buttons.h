// The three buttons, polled and debounced: a short press (on release), a long press (while held), by pin.
#pragma once
#include "freertos/FreeRTOS.h"
#include "freertos/queue.h"

typedef enum { BTN_UP, BTN_BOOT, BTN_DOWN } button_id_t;
typedef enum { PRESS_SHORT, PRESS_LONG } press_kind_t;
typedef struct { button_id_t id; press_kind_t kind; } button_event_t;

/** Starts polling; events arrive on the returned queue. */
QueueHandle_t buttons_start(void);
