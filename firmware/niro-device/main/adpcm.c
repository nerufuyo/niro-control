#include "adpcm.h"

static const int16_t STEPS[89] = {
    7, 8, 9, 10, 11, 12, 13, 14, 16, 17, 19, 21, 23, 25, 28, 31, 34, 37, 41, 45, 50, 55, 60, 66, 73, 80, 88, 97, 107, 118, 130,
    143, 157, 173, 190, 209, 230, 253, 279, 307, 337, 371, 408, 449, 494, 544, 598, 658, 724, 796, 876, 963, 1060, 1166, 1282,
    1411, 1552, 1707, 1878, 2066, 2272, 2499, 2749, 3024, 3327, 3660, 4026, 4428, 4871, 5358, 5894, 6484, 7132, 7845, 8630,
    9493, 10442, 11487, 12635, 13899, 15289, 16818, 18500, 20350, 22385, 24623, 27086, 29794, 32767,
};
static const int8_t INDEX[8] = {-1, -1, -1, -1, 2, 4, 6, 8};

static int16_t step(int *pred, int *index, int nibble) {
    int size = STEPS[*index], diff = size >> 3;
    if (nibble & 4) diff += size;
    if (nibble & 2) diff += size >> 1;
    if (nibble & 1) diff += size >> 2;
    int p = (nibble & 8) ? *pred - diff : *pred + diff;
    *pred = p > 32767 ? 32767 : p < -32768 ? -32768 : p;
    int i = *index + INDEX[nibble & 7];
    *index = i < 0 ? 0 : i > 88 ? 88 : i;
    return (int16_t)*pred;
}

size_t adpcm_encode(adpcm_t *s, const int16_t *pcm, size_t n, uint8_t *out) {
    size_t at = 0;
    out[at++] = (uint8_t)(s->pred & 0xff);
    out[at++] = (uint8_t)((s->pred >> 8) & 0xff);
    out[at++] = (uint8_t)s->index;
    int low = -1;
    for (size_t i = 0; i < n; i++) {
        int size = STEPS[s->index], diff = pcm[i] - s->pred, nibble = 0;
        if (diff < 0) { nibble = 8; diff = -diff; }
        int rest = size;
        if (diff >= rest) { nibble |= 4; diff -= rest; }
        rest >>= 1;
        if (diff >= rest) { nibble |= 2; diff -= rest; }
        rest >>= 1;
        if (diff >= rest) nibble |= 1;
        step(&s->pred, &s->index, nibble);
        if (low < 0) low = nibble;
        else { out[at++] = (uint8_t)(low | (nibble << 4)); low = -1; }
    }
    if (low >= 0) out[at++] = (uint8_t)low;
    return at;
}

int adpcm_decode(const uint8_t *frame, size_t len, int16_t *pcm, size_t cap) {
    if (len < 3 || frame[2] > 88 || (len - 3) * 2 > cap) return -1;
    int pred = (int16_t)(frame[0] | (frame[1] << 8)), index = frame[2];
    size_t n = 0;
    for (size_t i = 3; i < len; i++) {
        pcm[n++] = step(&pred, &index, frame[i] & 15);
        pcm[n++] = step(&pred, &index, frame[i] >> 4);
    }
    return (int)n;
}
