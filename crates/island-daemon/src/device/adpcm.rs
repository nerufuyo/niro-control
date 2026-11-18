// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 zickrian

//! IMA ADPCM, 4 bits a sample: a quarter of PCM's size (64 kbit/s at 16 kHz) with no library on either side. A frame is
//! self-contained to decode: 3 bytes (the predictor as i16 little-endian, the step index) then two samples a byte, the
//! low nibble first. The encoder keeps its state from frame to frame, so a frame starts where the last ended. The same
//! code is `firmware/niro-device/main/adpcm.c`; `tests` holds frames each made, which the other reads.

const STEPS: [i32; 89] = [
    7, 8, 9, 10, 11, 12, 13, 14, 16, 17, 19, 21, 23, 25, 28, 31, 34, 37, 41, 45, 50, 55, 60, 66, 73, 80, 88, 97, 107, 118, 130,
    143, 157, 173, 190, 209, 230, 253, 279, 307, 337, 371, 408, 449, 494, 544, 598, 658, 724, 796, 876, 963, 1060, 1166, 1282,
    1411, 1552, 1707, 1878, 2066, 2272, 2499, 2749, 3024, 3327, 3660, 4026, 4428, 4871, 5358, 5894, 6484, 7132, 7845, 8630,
    9493, 10442, 11487, 12635, 13899, 15289, 16818, 18500, 20350, 22385, 24623, 27086, 29794, 32767,
];
const INDEX: [i32; 8] = [-1, -1, -1, -1, 2, 4, 6, 8];

/// One more sample of the signal from a nibble: the predictor and the index move.
fn step(pred: &mut i32, index: &mut i32, nibble: u8) -> i16 {
    let size = STEPS[*index as usize];
    let mut diff = size >> 3;
    if nibble & 4 != 0 {
        diff += size;
    }
    if nibble & 2 != 0 {
        diff += size >> 1;
    }
    if nibble & 1 != 0 {
        diff += size >> 2;
    }
    *pred = if nibble & 8 != 0 { *pred - diff } else { *pred + diff }.clamp(-32768, 32767);
    *index = (*index + INDEX[(nibble & 7) as usize]).clamp(0, 88);
    *pred as i16
}

/// Turns PCM into frames, keeping its state between them.
#[derive(Default)]
pub struct Encoder {
    pred: i32,
    index: i32,
}

impl Encoder {
    /// One frame: an even number of samples.
    pub fn frame(&mut self, samples: &[i16]) -> Vec<u8> {
        let mut out = Vec::with_capacity(3 + samples.len() / 2);
        out.extend_from_slice(&(self.pred as i16).to_le_bytes());
        out.push(self.index as u8);
        let mut low: Option<u8> = None;
        for &sample in samples {
            let size = STEPS[self.index as usize];
            let mut diff = i32::from(sample) - self.pred;
            let mut nibble = 0u8;
            if diff < 0 {
                nibble = 8;
                diff = -diff;
            }
            let mut rest = size;
            if diff >= rest {
                nibble |= 4;
                diff -= rest;
            }
            rest >>= 1;
            if diff >= rest {
                nibble |= 2;
                diff -= rest;
            }
            rest >>= 1;
            if diff >= rest {
                nibble |= 1;
            }
            step(&mut self.pred, &mut self.index, nibble);
            match low.take() {
                None => low = Some(nibble),
                Some(first) => out.push(first | (nibble << 4)),
            }
        }
        if let Some(first) = low {
            out.push(first);
        }
        out
    }
}

/// The samples of one frame; `None` when it is not one (too short, a step index out of range).
pub fn decode(frame: &[u8]) -> Option<Vec<i16>> {
    let (head, body) = frame.split_at_checked(3)?;
    let mut pred = i32::from(i16::from_le_bytes([head[0], head[1]]));
    let mut index = i32::from(head[2]);
    if index > 88 {
        return None;
    }
    let mut out = Vec::with_capacity(body.len() * 2);
    for byte in body {
        out.push(step(&mut pred, &mut index, byte & 15));
        out.push(step(&mut pred, &mut index, byte >> 4));
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tone(n: usize, from: usize) -> Vec<i16> {
        (from..from + n).map(|i| ((i as f32 * 0.07).sin() * 9000.0 + (i as f32 * 0.31).sin() * 2500.0) as i16).collect()
    }

    #[test]
    fn a_tone_comes_back_close_across_frames() {
        let mut encoder = Encoder::default();
        let mut worst = 0i32;
        for n in 0..20 {
            let samples = tone(320, n * 320);
            let frame = encoder.frame(&samples);
            assert_eq!(frame.len(), 3 + 160);
            let back = decode(&frame).unwrap();
            assert_eq!(back.len(), 320);
            // The first frames still adapt: judge the settled ones.
            if n >= 2 {
                worst = worst.max(samples.iter().zip(&back).map(|(a, b)| (i32::from(*a) - i32::from(*b)).abs()).max().unwrap());
            }
        }
        assert!(worst < 1200, "worst error {worst} of 11500");
    }

    /// The firmware's C made this frame from `SAMPLES` and decoded it to `C_DECODES`; Rust must do the same, bit for bit.
    #[test]
    fn rust_and_the_firmware_c_agree_bit_for_bit() {
        const SAMPLES: [i16; 16] = [0, 4314, 7573, 8977, 8183, 5386, 1270, -3157, -6811, -8797, -8630, -6349, -2514, 1936, 5912, 8441];
        const C_FRAME: [u8; 11] = [0x00, 0x00, 0x00, 0x70, 0x77, 0x77, 0xf7, 0xef, 0x28, 0x42, 0x22];
        const C_DECODES: [i16; 16] = [0, 11, 41, 104, 240, 533, 1164, -193, -3103, -8508, -9244, -5896, -2853, 2128, 5476, 8519];
        assert_eq!(Encoder::default().frame(&SAMPLES), C_FRAME);
        assert_eq!(decode(&C_FRAME).unwrap(), C_DECODES);
    }

    #[test]
    fn silence_stays_silent_and_bad_frames_are_refused() {
        let frame = Encoder::default().frame(&[0; 320]);
        assert!(decode(&frame).unwrap().iter().all(|s| s.abs() < 8));
        assert!(decode(&[0, 0]).is_none());
        assert!(decode(&[0, 0, 200, 1]).is_none());
        assert_eq!(decode(&[1, 0, 0]).unwrap().len(), 0);
    }

    #[test]
    fn extremes_do_not_overflow() {
        let mut loud = Vec::new();
        for i in 0..320 {
            loud.push(if i % 2 == 0 { i16::MAX } else { i16::MIN });
        }
        let back = decode(&Encoder::default().frame(&loud)).unwrap();
        assert_eq!(back.len(), 320);
    }
}
