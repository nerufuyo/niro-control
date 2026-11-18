// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 zickrian

//! "Momo Niro": the words that wake a Niro Device. The device sends its microphone while it is waiting; this cuts the
//! sound into utterances (a plain energy gate, nothing is kept but the utterance being cut), and the daemon turns each
//! short one into words and looks for the keyword. Only what follows the keyword is ever asked of the assistant.

use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// 20 ms of 16 kHz audio.
const FRAME: usize = 320;
/// Quiet for this long ends an utterance (0.7 s).
const HANG: usize = 35;
/// The sound just before the gate opened is kept (0.2 s): a word's first sound is soft.
const PRE_ROLL: usize = 10;
/// Shorter than this much speech is a click or a cough (0.4 s).
const MIN_VOICED: usize = 20;
/// An utterance past this is not a wake phrase and a question: it is let go (8 s).
const MAX_FRAMES: usize = 400;
/// The least the gate opens at, whatever the room's own noise (an RMS on 16-bit samples).
const GATE: f32 = 380.0;

/// What is awake after the keyword was heard alone: the next utterance is the question, for this long.
pub const AWAKE: Duration = Duration::from_secs(8);

/// Cuts a stream of audio into utterances.
#[derive(Default)]
pub struct Cutter {
    pending: Vec<i16>,
    pre: std::collections::VecDeque<Vec<i16>>,
    utterance: Vec<i16>,
    open: bool,
    quiet: usize,
    voiced: usize,
    floor: f32,
    /// A too-long utterance was let go: nothing starts again until it is quiet.
    skipping: bool,
}

impl Cutter {
    /// Takes samples; returns an utterance when one has just ended.
    pub fn push(&mut self, samples: &[i16]) -> Option<Vec<i16>> {
        self.pending.extend_from_slice(samples);
        let mut out = None;
        while self.pending.len() >= FRAME {
            let frame: Vec<i16> = self.pending.drain(..FRAME).collect();
            if let Some(done) = self.frame(frame) {
                out = Some(done);
            }
        }
        out
    }

    fn frame(&mut self, frame: Vec<i16>) -> Option<Vec<i16>> {
        let energy = (frame.iter().map(|s| f32::from(*s).powi(2)).sum::<f32>() / FRAME as f32).sqrt();
        // The room's own level, followed slowly while the gate is shut.
        if !self.open {
            self.floor = if self.floor == 0.0 { energy } else { self.floor * 0.98 + energy * 0.02 };
        }
        let loud = energy > (self.floor * 3.0).max(GATE);
        if self.skipping {
            self.skipping = !(!loud);
            return None;
        }
        if !self.open {
            if loud {
                self.open = true;
                self.quiet = 0;
                self.voiced = 1;
                self.utterance = self.pre.drain(..).flatten().collect();
                self.utterance.extend_from_slice(&frame);
            } else {
                self.pre.push_back(frame);
                while self.pre.len() > PRE_ROLL {
                    self.pre.pop_front();
                }
            }
            return None;
        }
        self.utterance.extend_from_slice(&frame);
        if loud {
            self.voiced += 1;
            self.quiet = 0;
        } else {
            self.quiet += 1;
        }
        if self.quiet >= HANG || self.utterance.len() >= MAX_FRAMES * FRAME {
            self.open = false;
            let long = self.utterance.len() >= MAX_FRAMES * FRAME;
            self.skipping = long && loud;
            let utterance = std::mem::take(&mut self.utterance);
            let voiced = std::mem::take(&mut self.voiced);
            return (voiced >= MIN_VOICED && !long).then_some(utterance);
        }
        None
    }
}

/// Whether the keyword is spoken, and what follows it: `None` when it is not said.
pub fn after_keyword(text: &str) -> Option<String> {
    let words: Vec<&str> = text.split_whitespace().collect();
    let clean = |word: &str| -> String { word.chars().filter(|c| c.is_alphanumeric()).collect::<String>().to_lowercase() };
    let cleaned: Vec<String> = words.iter().map(|word| clean(word)).collect();
    for at in 0..cleaned.len() {
        // "momo niro", "mo mo niro", "momoniro"
        let (used, ok) = if cleaned[at].len() >= 6 && distance(&cleaned[at], "momoniro") <= 2 {
            (1, true)
        } else if cleaned[at] == "mo" && cleaned.get(at + 1).is_some_and(|w| w == "mo") {
            (3, cleaned.get(at + 2).is_some_and(|w| distance(w, "niro") <= 1))
        } else {
            (2, distance(&cleaned[at], "momo") <= 1 && cleaned.get(at + 1).is_some_and(|w| distance(w, "niro") <= 1))
        };
        if ok {
            return Some(words[(at + used).min(words.len())..].join(" ").trim_matches(|c: char| c.is_ascii_punctuation() || c.is_whitespace()).to_owned());
        }
    }
    None
}

/// The edit distance between two short words.
fn distance(a: &str, b: &str) -> usize {
    let (a, b): (Vec<char>, Vec<char>) = (a.chars().collect(), b.chars().collect());
    let mut row: Vec<usize> = (0..=b.len()).collect();
    for i in 1..=a.len() {
        let mut diagonal = row[0];
        row[0] = i;
        for j in 1..=b.len() {
            let above = row[j];
            row[j] = (row[j] + 1).min(row[j - 1] + 1).min(diagonal + usize::from(a[i - 1] != b[j - 1]));
            diagonal = above;
        }
    }
    row[b.len()]
}

/// Whether the keyword was heard alone, and so the next thing said is the question.
#[derive(Clone, Default)]
pub struct Awake(Arc<Mutex<Option<Instant>>>);

impl Awake {
    pub fn wake(&self) {
        if let Ok(mut until) = self.0.lock() {
            *until = Some(Instant::now() + AWAKE);
        }
    }

    /// Whether it is awake now, without ending it.
    pub fn active(&self) -> bool {
        self.0.lock().ok().is_some_and(|until| until.is_some_and(|until| Instant::now() < until))
    }

    /// Whether it is awake now; asking ends it.
    pub fn take(&self) -> bool {
        self.0.lock().ok().and_then(|mut until| until.take()).is_some_and(|until| Instant::now() < until)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tone(frames: usize, amp: f32) -> Vec<i16> {
        (0..frames * FRAME).map(|i| ((i as f32 * 0.3).sin() * amp) as i16).collect()
    }

    fn quiet(frames: usize) -> Vec<i16> {
        (0..frames * FRAME).map(|i| ((i * 7919) % 41) as i16 - 20).collect()
    }

    #[test]
    fn the_keyword_is_found_however_it_is_written() {
        for said in ["Momo Niro", "momo, niro.", "Momo Nero", "mo mo niro", "Momoniro", "Momo Miro!", "Hey momo niro"] {
            assert_eq!(after_keyword(said).as_deref(), Some(""), "{said}");
        }
        assert_eq!(after_keyword("Momo Niro, what time is it?").as_deref(), Some("what time is it"));
        assert_eq!(after_keyword("hey Momo Niro open the music").as_deref(), Some("open the music"));
    }

    #[test]
    fn other_talk_is_not_the_keyword() {
        for said in ["", "good morning", "mama nina", "the memo is here", "niro momo", "Momo is nice"] {
            assert_eq!(after_keyword(said), None, "{said}");
        }
    }

    #[test]
    fn a_spoken_stretch_is_cut_out_of_silence() {
        let mut cutter = Cutter::default();
        let mut got = None;
        for chunk in [quiet(40), tone(50, 6000.0), quiet(60)] {
            for part in chunk.chunks(FRAME * 3) {
                if let Some(done) = cutter.push(part) {
                    got = Some(done);
                }
            }
        }
        let got = got.expect("an utterance");
        // The speech, the sound just before it and the silence that ended it.
        assert!(got.len() >= 50 * FRAME && got.len() <= (50 + PRE_ROLL + HANG + 2) * FRAME, "{}", got.len());
    }

    #[test]
    fn a_click_is_not_an_utterance_and_silence_is_nothing() {
        let mut cutter = Cutter::default();
        assert!(cutter.push(&quiet(100)).is_none());
        assert!(cutter.push(&tone(3, 9000.0)).is_none());
        assert!(cutter.push(&quiet(60)).is_none());
    }

    #[test]
    fn a_long_talk_is_let_go() {
        let mut cutter = Cutter::default();
        let mut any = false;
        for chunk in [quiet(30), tone(MAX_FRAMES + 20, 6000.0), quiet(60)] {
            any |= cutter.push(&chunk).is_some();
        }
        assert!(!any);
    }

    #[test]
    fn a_louder_room_raises_the_gate() {
        let mut cutter = Cutter::default();
        // Steady noise at 300 does not open it, however long it goes on.
        for _ in 0..200 {
            assert!(cutter.push(&tone(1, 300.0)).is_none());
        }
        assert!(!cutter.open);
    }

    #[test]
    fn being_awake_lasts_one_question() {
        let awake = Awake::default();
        assert!(!awake.take());
        awake.wake();
        assert!(awake.take());
        assert!(!awake.take());
    }
}
