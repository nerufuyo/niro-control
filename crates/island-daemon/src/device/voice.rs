// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 zickrian

//! A question asked to a Niro Device: its microphone's audio comes in, is turned into words, is answered by the
//! assistant, and goes back as text. The audio is 16-bit little-endian PCM at 16 kHz (Opus comes later). Nothing
//! is kept: the samples live only until they are words.

use std::future::Future;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use log::{debug, warn};
use tokio::sync::mpsc::{UnboundedSender, unbounded_channel};
use tokio::time::timeout;

use super::proto::{Face, ToDevice};
use crate::assistant::Command;

/// The longest question: 30 seconds at 16 kHz. The rest is let go.
const MAX_SAMPLES: usize = 30 * 16_000;
/// Less than this is a tap, not a question (a third of a second).
const MIN_SAMPLES: usize = 16_000 / 3;
/// How long turning the audio into words may take, and how long the assistant may take to answer.
const HEARING: Duration = Duration::from_secs(60);
const ANSWERING: Duration = Duration::from_secs(180);

/// The longest answer sent, in characters, and the most its JSON text may take, in bytes.
const MAX_ANSWER: usize = 400;
const MAX_ESCAPED: usize = 800;

const NOTHING_HEARD: &str = "I did not catch that. Try again.";
const NOT_SET_UP: &str = "Voice is not set up on the computer yet.";
const NO_ASSISTANT: &str = "The assistant is not running.";
const SLOW: &str = "That took too long. Try again.";

static ASSISTANT: std::sync::OnceLock<UnboundedSender<Command>> = std::sync::OnceLock::new();

/// Where a device's questions go: the assistant's loop. Set once, as the daemon starts.
pub fn set_assistant(assistant: UnboundedSender<Command>) {
    let _ = ASSISTANT.set(assistant);
}

/// The assistant, once the daemon has one.
pub fn assistant() -> Option<UnboundedSender<Command>> {
    ASSISTANT.get().cloned()
}

/// What a device has said since it began to listen.
pub struct Heard {
    samples: Vec<i16>,
    lang: String,
    adpcm: bool,
}

impl Heard {
    /// A new recording, if the daemon takes what the device sends: 16 kHz, PCM or ADPCM.
    pub fn begin(lang: &str, codec: &str, rate: u32) -> Option<Self> {
        (matches!(codec, "pcm" | "adpcm") && rate == 16_000).then(|| Self {
            adpcm: codec == "adpcm",
            samples: Vec::new(),
            lang: lang.chars().filter(|c| c.is_ascii_alphabetic() || *c == ',').take(24).collect(),
        })
    }

    /// Adds a frame of audio; what is past the longest question is let go.
    pub fn push(&mut self, frame: &[u8]) {
        let room = MAX_SAMPLES.saturating_sub(self.samples.len());
        if self.adpcm {
            // A frame that is not one says nothing; the question goes on without it.
            if let Some(samples) = super::adpcm::decode(frame) {
                self.samples.extend(samples.into_iter().take(room));
            }
        } else {
            self.samples.extend(frame.chunks_exact(2).take(room).map(|pair| i16::from_le_bytes([pair[0], pair[1]])));
        }
    }

    /// Whether there is enough to be a question.
    pub fn is_question(&self) -> bool {
        self.samples.len() >= MIN_SAMPLES
    }
}

/// Whether a question is being answered for a connection: one at a time.
#[derive(Clone, Default)]
pub struct Busy(Arc<AtomicBool>);

impl Busy {
    fn take(&self) -> bool {
        !self.0.swap(true, Ordering::SeqCst)
    }

    fn free(&self) {
        self.0.store(false, Ordering::SeqCst);
    }
}

/// Answers `heard` to the device (`outbox`), on its own task: the connection goes on meanwhile.
pub fn answer(heard: Heard, busy: &Busy, outbox: UnboundedSender<ToDevice>, assistant: Option<UnboundedSender<Command>>) {
    answer_with(
        heard,
        busy,
        outbox,
        assistant,
        |audio, lang| async move { crate::assistant::transcribe(&audio, &lang).await },
        |text, lang| async move { super::tts::speak(&text, &lang).await },
    );
}

fn answer_with<F, Fut, S, Spoken>(
    heard: Heard,
    busy: &Busy,
    outbox: UnboundedSender<ToDevice>,
    assistant: Option<UnboundedSender<Command>>,
    transcribe: F,
    speak: S,
) where
    F: FnOnce(Vec<i16>, String) -> Fut + Send + 'static,
    Fut: Future<Output = anyhow::Result<String>> + Send,
    S: FnOnce(String, String) -> Spoken + Send + 'static,
    Spoken: Future<Output = Option<Vec<Vec<u8>>>> + Send,
{
    if !busy.take() {
        say(&outbox, "I am still answering the last one.");
        return;
    }
    let busy = busy.clone();
    tokio::spawn(async move {
        let words = reply(heard, &outbox, assistant, transcribe, speak).await;
        busy.free();
        say_face(&outbox, if words { Face::Happy } else { Face::Curious });
    });
}

/// The whole turn; whether it ended in an answer.
async fn reply<F, Fut, S, Spoken>(
    heard: Heard,
    outbox: &UnboundedSender<ToDevice>,
    assistant: Option<UnboundedSender<Command>>,
    transcribe: F,
    speak: S,
) -> bool
where
    F: FnOnce(Vec<i16>, String) -> Fut,
    Fut: Future<Output = anyhow::Result<String>>,
    S: FnOnce(String, String) -> Spoken,
    Spoken: Future<Output = Option<Vec<Vec<u8>>>>,
{
    if !heard.is_question() {
        say(outbox, NOTHING_HEARD);
        return false;
    }
    say_face(outbox, Face::Thinking);
    let lang = heard.lang.clone();
    let text = match timeout(HEARING, transcribe(heard.samples, heard.lang)).await {
        Ok(Ok(text)) => text.trim().to_owned(),
        Ok(Err(err)) => {
            warn!("could not understand a device's question: {err:#}");
            say(outbox, if format!("{err:#}").contains("not set up") { NOT_SET_UP } else { NOTHING_HEARD });
            return false;
        }
        Err(_) => {
            say(outbox, SLOW);
            return false;
        }
    };
    if text.is_empty() {
        say(outbox, NOTHING_HEARD);
        return false;
    }
    debug!("a device asked: {} characters", text.chars().count());
    let _ = outbox.send(ToDevice::Stt { text: text.clone(), r#final: true });
    let Some(assistant) = assistant else {
        say(outbox, NO_ASSISTANT);
        return false;
    };
    let (send, mut said) = unbounded_channel();
    if assistant.send(Command::FromDevice(text, send)).is_err() {
        say(outbox, NO_ASSISTANT);
        return false;
    }
    match timeout(ANSWERING, said.recv()).await {
        Ok(Some(answer)) => {
            say_face(outbox, Face::Speaking);
            let answer = fit(&answer);
            let speech = speak(answer.clone(), lang).await;
            send_answer(outbox, &answer, speech.is_some());
            for frame in speech.into_iter().flatten() {
                let _ = outbox.send(ToDevice::Audio(frame));
            }
            let _ = outbox.send(ToDevice::AudioEnd);
            true
        }
        Ok(None) => {
            say(outbox, NO_ASSISTANT);
            false
        }
        Err(_) => {
            say(outbox, SLOW);
            false
        }
    }
}

fn say(outbox: &UnboundedSender<ToDevice>, text: &str) {
    send_answer(outbox, &fit(text), false);
}

fn send_answer(outbox: &UnboundedSender<ToDevice>, text: &str, audio: bool) {
    let id = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as u64);
    let _ = outbox.send(ToDevice::Answer { id, text: text.to_owned(), done: true, audio });
}

/// What the device can take: its receive buffer is 1024 bytes, so the escaped text is kept under 800, and a screen shows
/// three pages of a few lines anyway. A cut answer ends in an ellipsis.
fn fit(text: &str) -> String {
    let mut text: String = text.trim().to_owned();
    let cut = |text: &mut String| {
        while text.ends_with(char::is_whitespace) {
            text.pop();
        }
        text.push('…');
    };
    if text.chars().count() > MAX_ANSWER {
        text = text.chars().take(MAX_ANSWER - 1).collect();
        cut(&mut text);
    }
    while serde_json::to_string(&text).map_or(0, |json| json.len()) > MAX_ESCAPED {
        text.pop();
        text.pop();
        cut(&mut text);
    }
    text
}

fn say_face(outbox: &UnboundedSender<ToDevice>, name: Face) {
    let _ = outbox.send(ToDevice::Face { name });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pcm(samples: usize) -> Vec<u8> {
        (0..samples).flat_map(|i| (i as i16).to_le_bytes()).collect()
    }

    fn heard(samples: usize) -> Heard {
        let mut heard = Heard::begin("id,en", "pcm", 16_000).unwrap();
        heard.push(&pcm(samples));
        heard
    }

    async fn run(heard: Heard, words: &'static str, assistant: bool) -> Vec<ToDevice> {
        let (outbox, mut out) = unbounded_channel();
        let busy = Busy::default();
        let ask = assistant.then(|| {
            let (ask, mut commands) = unbounded_channel();
            tokio::spawn(async move {
                while let Some(Command::FromDevice(text, reply)) = commands.recv().await {
                    let _ = reply.send(format!("You said: {text}"));
                }
            });
            ask
        });
        answer_with(heard, &busy, outbox, ask, move |_, _| async move { Ok(words.to_owned()) }, |_, _| async { Some(vec![vec![1, 2, 3]]) });
        let mut all = Vec::new();
        while let Ok(Some(message)) = timeout(Duration::from_millis(300), out.recv()).await {
            all.push(message);
        }
        all
    }

    #[test]
    fn only_16k_pcm_is_taken() {
        assert!(Heard::begin("", "pcm", 16_000).is_some());
        assert!(Heard::begin("", "adpcm", 16_000).is_some());
        assert!(Heard::begin("", "opus", 16_000).is_none());
        assert!(Heard::begin("", "pcm", 8_000).is_none());
    }

    #[test]
    fn frames_become_samples_and_the_longest_question_is_cut() {
        let mut heard = Heard::begin("", "pcm", 16_000).unwrap();
        heard.push(&[0x01, 0x00, 0xff, 0xff, 0x7f]);
        assert_eq!(heard.samples, [1, -1]);
        heard.push(&pcm(MAX_SAMPLES));
        assert_eq!(heard.samples.len(), MAX_SAMPLES);
    }

    #[test]
    fn adpcm_frames_become_samples_too() {
        let mut heard = Heard::begin("", "adpcm", 16_000).unwrap();
        let mut encoder = super::super::adpcm::Encoder::default();
        heard.push(&encoder.frame(&[100; 320]));
        heard.push(&[1, 2]);
        assert_eq!(heard.samples.len(), 320);
    }

    #[test]
    fn the_language_cannot_carry_anything_but_codes() {
        let heard = Heard::begin("id,en --evil $(x)", "pcm", 16_000).unwrap();
        assert!(heard.lang.chars().all(|c| c.is_ascii_alphabetic() || c == ','));
    }

    #[tokio::test]
    async fn a_question_is_heard_answered_and_the_slime_is_happy() {
        let out = run(heard(20_000), "what time is it", true).await;
        assert!(matches!(&out[0], ToDevice::Face { name: Face::Thinking }));
        assert!(matches!(&out[1], ToDevice::Stt { text, r#final: true } if text == "what time is it"));
        assert!(matches!(&out[2], ToDevice::Face { name: Face::Speaking }));
        assert!(matches!(&out[3], ToDevice::Answer { text, done: true, .. } if text == "You said: what time is it"));
        // The words with audio: true, then the speech frame by frame and its end, then the slime is happy.
        assert!(matches!(&out[3], ToDevice::Answer { audio: true, .. }));
        assert!(matches!(&out[4], ToDevice::Audio(frame) if frame == &[1, 2, 3]));
        assert!(matches!(&out[5], ToDevice::AudioEnd));
        assert!(matches!(&out[6], ToDevice::Face { name: Face::Happy }));
    }

    #[tokio::test]
    async fn a_tap_and_silence_are_told_so_and_the_slime_is_curious() {
        for out in [run(heard(100), "x", true).await, run(heard(20_000), "  ", true).await] {
            assert!(out.iter().any(|m| matches!(m, ToDevice::Answer { text, .. } if text == NOTHING_HEARD)));
            assert!(matches!(out.last(), Some(ToDevice::Face { name: Face::Curious })));
        }
    }

    #[tokio::test]
    async fn without_the_assistant_it_says_so() {
        let out = run(heard(20_000), "hello", false).await;
        assert!(out.iter().any(|m| matches!(m, ToDevice::Answer { text, .. } if text == NO_ASSISTANT)));
    }

    #[test]
    fn an_answer_always_fits_the_device() {
        assert_eq!(fit("  short  "), "short");
        for text in ["word ".repeat(500), "\"".repeat(500), "漢".repeat(500), "\n\\".repeat(300)] {
            let fitted = fit(&text);
            assert!(serde_json::to_string(&fitted).unwrap().len() <= MAX_ESCAPED, "{fitted:.20}");
            assert!(fitted.ends_with('…'));
        }
    }

    #[tokio::test]
    async fn only_one_question_at_a_time() {
        let busy = Busy::default();
        assert!(busy.take());
        let (outbox, mut out) = unbounded_channel();
        answer_with(heard(20_000), &busy, outbox, None, |_, _| async { Ok("x".into()) }, |_, _| async { None });
        assert!(matches!(out.recv().await, Some(ToDevice::Answer { text, .. }) if text.contains("still answering")));
    }
}
