// The speaker: an I2S amplifier on its own clock lines, fed 16 kHz, 16-bit mono.
#pragma once
#include <stddef.h>
#include <stdint.h>

/** Sets the I2S channel up (idle until the first `spk_play`). 0 on success. */
int spk_init(void);
/** The loudness, 0 (mute) to 100. */
void spk_set_volume(int percent);
/** Plays `n` samples, waiting until they are in the amplifier's buffer (so it paces the sender). */
void spk_play(const int16_t *pcm, size_t n);
/** The speech is over: the clock stops. */
void spk_stop(void);
