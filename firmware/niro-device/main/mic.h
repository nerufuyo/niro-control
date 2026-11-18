// The microphone: an I2S MEMS microphone on its own clock lines, read as 16 kHz, 16-bit mono.
#pragma once
#include <stddef.h>
#include <stdint.h>

/** Sets the I2S channel up (idle until `mic_start`). 0 on success. */
int mic_init(void);
/** Starts the clock; samples flow until `mic_stop`. */
int mic_start(void);
void mic_stop(void);
/** Reads up to `samples` into `out`, waiting at most `timeout_ms`; the count read (0 on timeout, -1 on failure). */
int mic_read(int16_t *out, size_t samples, int timeout_ms);
