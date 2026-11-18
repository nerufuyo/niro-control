// IMA ADPCM, 4 bits a sample (the daemon's device/adpcm.rs is the same code): a frame is the predictor (i16 little-endian), the
// step index, then two samples a byte, the low nibble first. The encoder's state carries from frame to frame.
#pragma once
#include <stddef.h>
#include <stdint.h>

typedef struct { int pred, index; } adpcm_t;

/** `n` samples into `out` (3 + (n + 1) / 2 bytes); the bytes written. */
size_t adpcm_encode(adpcm_t *state, const int16_t *pcm, size_t n, uint8_t *out);
/** A frame into samples (`cap` at most); the count, or -1 when it is not a frame. */
int adpcm_decode(const uint8_t *frame, size_t len, int16_t *pcm, size_t cap);
