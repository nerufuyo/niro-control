// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 zickrian

//! The assistant's words as sound for a Niro Device's speaker: espeak-ng makes the speech on this computer, which is
//! cut into 20 ms frames of 16 kHz ADPCM. Nothing leaves the PC and nothing is kept. Without espeak-ng there is
//! no sound, only text.

use std::process::Stdio;
use std::time::Duration;

use tokio::process::Command;
use tokio::time::timeout;

use super::adpcm::Encoder;

/// Samples a frame, 20 ms at 16 kHz.
const FRAME: usize = 320;
/// The longest speech sent: 60 seconds.
const MAX_SAMPLES: usize = 60 * 16_000;
const MAKING: Duration = Duration::from_secs(20);

/// Niro's voice is a slime's: light, young and soft, neither a man's nor a woman's. espeak-ng cannot be anyone in particular;
/// a higher pitch, a gentle female variant and an unhurried pace come closest to that.
const SPEED: &str = "152";
const PITCH: &str = "74";
const VARIANT: &str = "+f3";

/// The espeak-ng voice for a language: the device's if it gave one, else this computer's (`LANG`), else English.
fn voice(language: &str) -> String {
    let from = |text: &str| -> Option<String> {
        let code: String = text.chars().take_while(|c| c.is_ascii_alphabetic() || *c == '-').collect();
        (2..=8).contains(&code.len()).then(|| code.to_ascii_lowercase())
    };
    from(language.split(',').next().unwrap_or(""))
        .or_else(|| std::env::var("LANG").ok().and_then(|lang| from(&lang)))
        .unwrap_or_else(|| "en".into())
}

/// The speech as frames for the speaker; `None` when there is no espeak-ng, or it did not make any.
pub async fn speak(text: &str, language: &str) -> Option<Vec<Vec<u8>>> {
    let child = Command::new("espeak-ng")
        .args(["--stdout", "-s", SPEED, "-p", PITCH, "-v", &format!("{}{}", voice(language), VARIANT), "--"])
        .arg(text)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .ok()?;
    let output = timeout(MAKING, child.wait_with_output()).await.ok()?.ok()?;
    let (rate, samples) = wav_samples(&output.stdout)?;
    let samples = resample(&samples, rate);
    (!samples.is_empty()).then(|| frames(&samples))
}

/// The sample rate and the samples of a mono 16-bit WAV (the size fields may be wrong: espeak streams).
fn wav_samples(wav: &[u8]) -> Option<(u32, Vec<i16>)> {
    if wav.len() < 44 || &wav[..4] != b"RIFF" || &wav[8..12] != b"WAVE" {
        return None;
    }
    let rate = u32::from_le_bytes(wav[24..28].try_into().ok()?);
    let channels = u16::from_le_bytes(wav[22..24].try_into().ok()?);
    let bits = u16::from_le_bytes(wav[34..36].try_into().ok()?);
    if channels != 1 || bits != 16 || !(8_000..=48_000).contains(&rate) {
        return None;
    }
    let at = wav.windows(4).position(|w| w == b"data")? + 8;
    let data = wav.get(at..)?;
    Some((rate, data.as_chunks::<2>().0.iter().map(|p| i16::from_le_bytes([p[0], p[1]])).collect()))
}

/// The samples at 16 kHz, by straight lines between them (speech, not music), cut at the longest speech.
fn resample(samples: &[i16], rate: u32) -> Vec<i16> {
    if rate == 16_000 {
        return samples.iter().copied().take(MAX_SAMPLES).collect();
    }
    let count = (samples.len() as u64 * 16_000 / u64::from(rate)).min(MAX_SAMPLES as u64) as usize;
    (0..count)
        .map(|i| {
            let at = i as f64 * f64::from(rate) / 16_000.0;
            let low = at as usize;
            let part = at - low as f64;
            let a = f64::from(samples[low.min(samples.len() - 1)]);
            let b = f64::from(samples[(low + 1).min(samples.len() - 1)]);
            (a + (b - a) * part) as i16
        })
        .collect()
}

/// 20 ms frames of ADPCM, the last one filled with silence.
fn frames(samples: &[i16]) -> Vec<Vec<u8>> {
    let mut encoder = Encoder::default();
    samples
        .chunks(FRAME)
        .map(|chunk| {
            let mut padded = chunk.to_vec();
            padded.resize(FRAME, 0);
            encoder.frame(&padded)
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn wav(rate: u32, samples: &[i16]) -> Vec<u8> {
        let mut out = b"RIFF\xff\xff\xff\x7fWAVEfmt \x10\0\0\0\x01\0\x01\0".to_vec();
        out.extend(rate.to_le_bytes());
        out.extend((rate * 2).to_le_bytes());
        out.extend([2, 0, 16, 0]);
        out.extend(b"data\xff\xff\xff\x7f");
        out.extend(samples.iter().flat_map(|s| s.to_le_bytes()));
        out
    }

    #[test]
    fn a_wav_is_read_and_a_bad_one_is_refused() {
        let (rate, samples) = wav_samples(&wav(22_050, &[1, -2, 3])).unwrap();
        assert_eq!((rate, samples), (22_050, vec![1, -2, 3]));
        assert!(wav_samples(b"nonsense").is_none());
        let mut stereo = wav(22_050, &[1]);
        stereo[22] = 2;
        assert!(wav_samples(&stereo).is_none());
    }

    #[test]
    fn resampling_to_16k_keeps_the_length_in_time() {
        let tone: Vec<i16> = (0..22_050).map(|i| ((i as f32 * 0.05).sin() * 8000.0) as i16).collect();
        let at_16k = resample(&tone, 22_050);
        assert!((15_990..=16_010).contains(&at_16k.len()), "{}", at_16k.len());
        assert_eq!(resample(&[5, 6, 7], 16_000), [5, 6, 7]);
    }

    #[test]
    fn frames_are_whole_and_the_longest_speech_is_cut() {
        let all = frames(&vec![100; 1000]);
        assert_eq!(all.len(), 4);
        assert!(all.iter().all(|f| f.len() == 3 + FRAME / 2));
        assert_eq!(resample(&vec![0; 16_000 * 90], 16_000).len(), MAX_SAMPLES);
    }

    #[test]
    fn the_voice_is_a_plain_code() {
        assert_eq!(voice("id,en"), "id");
        assert_eq!(voice("EN-us"), "en-us");
        assert_eq!(voice("--evil $(x)").chars().all(|c| c.is_ascii_alphabetic() || c == '-'), true);
    }

    #[tokio::test]
    async fn espeak_makes_speech_where_it_is_installed() {
        if std::process::Command::new("espeak-ng").arg("--version").output().is_err() {
            return;
        }
        let frames = speak("hello there", "en").await.expect("speech");
        assert!(frames.len() > 10, "{}", frames.len());
    }
}
