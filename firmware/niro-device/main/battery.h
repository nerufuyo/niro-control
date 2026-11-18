// The battery, read from the ADC (docs/device-hardware.md: "ADC initialized on channel 7", the charge pin 2).
#pragma once
#include <stdbool.h>
#include <stdint.h>

/** A lithium cell's charge, 0 to 100, from its voltage in millivolts at rest (a piecewise line through the usual
 * discharge curve). Out of any cell's range, 255: the pin is not a battery, or is not wired. */
static inline uint8_t battery_percent_from_mv(int mv) {
    static const struct { int mv, pct; } curve[] = {
        {3300, 0}, {3500, 5}, {3600, 15}, {3700, 35}, {3800, 55}, {3900, 70}, {4000, 82}, {4100, 93}, {4200, 100},
    };
    const int n = (int)(sizeof curve / sizeof curve[0]);
    if (mv < 2800 || mv > 4500) return 255;
    if (mv <= curve[0].mv) return 0;
    if (mv >= curve[n - 1].mv) return 100;
    for (int i = 1; i < n; i++)
        if (mv <= curve[i].mv)
            return (uint8_t)(curve[i - 1].pct + (curve[i].pct - curve[i - 1].pct) * (mv - curve[i - 1].mv) / (curve[i].mv - curve[i - 1].mv));
    return 255;
}

/** Sets up the ADC and the charge pin. Safe to call once; reading fails quietly if it did not work. */
void battery_init(void);
/** The cell's charge, 0 to 100, or 255 when it cannot be read. Averages a few samples. */
uint8_t battery_percent(void);
/** The cell's voltage in millivolts, or -1 when it cannot be read (for the log: the divider is a guess to check). */
int battery_mv(void);
/** Whether the charger says it is charging. */
bool battery_charging(void);
