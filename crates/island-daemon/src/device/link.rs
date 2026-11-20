// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 zickrian

//! The connection of a paired device: how it proves itself and how everything after is sealed. See
//! "Connection" in `docs/device-protocol.md`.
//!
//! Frames are `u16` length (big endian) and that many bytes. The four handshake frames are clear JSON; every
//! frame after is ChaCha20-Poly1305, with one key for each direction and a counter for a nonce, so a frame
//! that is changed, repeated, dropped or reordered fails to open and the connection ends.

use std::io;

use chacha20poly1305::aead::{Aead, KeyInit};
use chacha20poly1305::{ChaCha20Poly1305, Key, Nonce};
use hkdf::Hkdf;
use hmac::{Hmac, Mac};
use serde::{Deserialize, Serialize};
use sha2::Sha256;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, ReadHalf, WriteHalf};

use super::proto::{FromDevice, ToDevice};
use crate::share::{hex, random};

/// The protocol version in `hello`.
pub(super) const VERSION: u8 = 1;
/// The most a frame carries before sealing: a control message or a few audio frames.
pub const MAX_PLAIN: usize = 16 * 1024;
const TAG: usize = 16;
/// What a clear handshake frame may hold.
const MAX_CLEAR: usize = 2048;
/// What one frame may hold on the wire: the type byte, the data and the tag.
const MAX_FRAME: usize = 1 + MAX_PLAIN + TAG;
/// The type byte inside a sealed frame.
const CONTROL: u8 = 0;
const AUDIO: u8 = 1;

/// Why a connection ended or was not accepted.
#[derive(Debug)]
pub enum Error {
    /// The socket failed or closed.
    Io(io::Error),
    /// Something that is not the protocol: bad JSON, a wrong length, a wrong version.
    Protocol(&'static str),
    /// The device is not paired. Nothing was answered.
    Unknown,
    /// The device did not prove it holds the key.
    Auth,
    /// A sealed frame did not open (changed, repeated, dropped or reordered).
    Sealed,
    /// The user did not allow the device to pair, or did not answer in time.
    Declined,
}

impl From<io::Error> for Error {
    fn from(err: io::Error) -> Self {
        Self::Io(err)
    }
}

#[derive(Serialize, Deserialize)]
#[serde(tag = "t")]
pub(super) enum Clear {
    #[serde(rename = "hello")]
    Hello {
        v: u8,
        device_id: String,
        nonce: String,
    },
    #[serde(rename = "challenge")]
    Challenge { daemon_id: String, nonce: String },
    #[serde(rename = "auth")]
    Auth { mac: String },
    #[serde(rename = "ready")]
    Ready { mac: String },
    /// A device that wants to pair: it made a salt and `B` from the code the user typed on it.
    #[serde(rename = "pair.hello")]
    PairHello {
        v: u8,
        device_id: String,
        name: String,
        salt: String,
        b: String,
    },
    #[serde(rename = "pair.a")]
    PairA { a: String },
    #[serde(rename = "pair.proof")]
    PairProof { mac: String },
    #[serde(rename = "pair.done")]
    PairDone { mac: String, sealed: String },
    /// The user did not allow the device (or did not answer): said before the connection closes, so a device can
    /// tell a refusal from a wrong code, which is a connection closed without a word.
    #[serde(rename = "pair.denied")]
    PairDenied,
}

/// What a sealed frame holds.
#[derive(Debug, PartialEq)]
pub enum Incoming {
    Control(FromDevice),
    Audio(Vec<u8>),
}

/// One direction of the sealed channel: a key and the counter that is the next nonce.
struct Seal {
    cipher: ChaCha20Poly1305,
    counter: u64,
}

impl Seal {
    fn new(key: &[u8; 32]) -> Self {
        Self {
            cipher: ChaCha20Poly1305::new(Key::from_slice(key)),
            counter: 0,
        }
    }

    fn nonce(&mut self) -> [u8; 12] {
        let mut nonce = [0u8; 12];
        nonce[4..].copy_from_slice(&self.counter.to_be_bytes());
        self.counter += 1;
        nonce
    }

    fn seal(&mut self, kind: u8, data: &[u8]) -> Vec<u8> {
        let mut plain = Vec::with_capacity(1 + data.len());
        plain.push(kind);
        plain.extend_from_slice(data);
        let nonce = self.nonce();
        self.cipher
            .encrypt(Nonce::from_slice(&nonce), plain.as_slice())
            .expect("sealing a frame that fits cannot fail")
    }

    fn open(&mut self, frame: &[u8]) -> Result<(u8, Vec<u8>), Error> {
        let nonce = self.nonce();
        let mut plain = self
            .cipher
            .decrypt(Nonce::from_slice(&nonce), frame)
            .map_err(|_| Error::Sealed)?;
        if plain.is_empty() {
            return Err(Error::Sealed);
        }
        let kind = plain.remove(0);
        Ok((kind, plain))
    }
}

/// The keys of one connection, from the device key and the two nonces both sides chose.
struct Keys {
    /// Device to daemon.
    from_device: [u8; 32],
    /// Daemon to device.
    to_device: [u8; 32],
    mac: [u8; 32],
}

fn derive(device_key: &[u8; 32], nonce_d: &[u8], nonce_s: &[u8]) -> Keys {
    let salt = [nonce_d, nonce_s].concat();
    let hkdf = Hkdf::<Sha256>::new(Some(&salt), device_key);
    let mut keys = Keys {
        from_device: [0; 32],
        to_device: [0; 32],
        mac: [0; 32],
    };
    for (info, out) in [
        (&b"niro-device v1 d2s"[..], &mut keys.from_device),
        (&b"niro-device v1 s2d"[..], &mut keys.to_device),
        (&b"niro-device v1 mac"[..], &mut keys.mac),
    ] {
        hkdf.expand(info, out).expect("32 bytes is a valid length");
    }
    keys
}

fn mac(key: &[u8; 32], who: &[u8], nonce: &[u8]) -> Hmac<Sha256> {
    let mut mac = <Hmac<Sha256> as Mac>::new_from_slice(key).expect("any key length");
    mac.update(who);
    mac.update(nonce);
    mac
}

pub(super) fn unhex<const N: usize>(text: &str) -> Option<[u8; N]> {
    if text.len() != N * 2 {
        return None;
    }
    let mut out = [0u8; N];
    for (byte, pair) in out.iter_mut().zip(text.as_bytes().chunks(2)) {
        *byte = u8::from_str_radix(std::str::from_utf8(pair).ok()?, 16).ok()?;
    }
    Some(out)
}

pub(super) async fn write_frame<W: AsyncWrite + Unpin>(stream: &mut W, bytes: &[u8]) -> Result<(), Error> {
    let len = u16::try_from(bytes.len()).map_err(|_| Error::Protocol("frame too long"))?;
    stream.write_all(&len.to_be_bytes()).await?;
    stream.write_all(bytes).await?;
    stream.flush().await?;
    Ok(())
}

/// Reads one frame; a length over `max` is refused before any of it is read.
pub(super) async fn read_frame<R: AsyncRead + Unpin>(stream: &mut R, max: usize) -> Result<Vec<u8>, Error> {
    let mut len = [0u8; 2];
    stream.read_exact(&mut len).await?;
    let len = usize::from(u16::from_be_bytes(len));
    if len > max {
        return Err(Error::Protocol("frame too long"));
    }
    let mut frame = vec![0u8; len];
    stream.read_exact(&mut frame).await?;
    Ok(frame)
}

pub(super) async fn write_clear<W: AsyncWrite + Unpin>(stream: &mut W, message: &Clear) -> Result<(), Error> {
    let json = serde_json::to_vec(message).map_err(|_| Error::Protocol("encode"))?;
    write_frame(stream, &json).await
}

pub(super) async fn read_clear<R: AsyncRead + Unpin>(stream: &mut R) -> Result<Clear, Error> {
    // A clear frame is under a thousand bytes (the largest holds `B`, 768 hex digits); nothing larger is
    // read before a device is known.
    let frame = read_frame(stream, MAX_CLEAR).await?;
    serde_json::from_slice(&frame).map_err(|_| Error::Protocol("handshake"))
}

/// A device that proved it holds its key, and the sealed channel to it.
pub struct Link<S> {
    stream: S,
    device_id: String,
    send: Seal,
    receive: Seal,
}

impl<S: AsyncRead + AsyncWrite + Unpin> Link<S> {
    pub fn device_id(&self) -> &str {
        &self.device_id
    }

    pub async fn send(&mut self, message: &ToDevice) -> Result<(), Error> {
        send_control(&mut self.stream, &mut self.send, message).await
    }

    pub async fn send_audio(&mut self, frame: &[u8]) -> Result<(), Error> {
        send_sealed(&mut self.stream, &mut self.send, AUDIO, frame).await
    }

    pub async fn receive(&mut self) -> Result<Incoming, Error> {
        receive_one(&mut self.stream, &mut self.receive).await
    }

    /// The two directions apart, so one task can read while another writes: a read that is cut short
    /// in a `select!` would lose bytes of a frame.
    pub fn split(self) -> (String, Reader<ReadHalf<S>>, Writer<WriteHalf<S>>) {
        let (read, write) = tokio::io::split(self.stream);
        (
            self.device_id,
            Reader {
                stream: read,
                receive: self.receive,
            },
            Writer {
                stream: write,
                send: self.send,
            },
        )
    }
}

/// The reading half of a [`Link`].
pub struct Reader<R> {
    stream: R,
    receive: Seal,
}

impl<R: AsyncRead + Unpin> Reader<R> {
    pub async fn receive(&mut self) -> Result<Incoming, Error> {
        receive_one(&mut self.stream, &mut self.receive).await
    }
}

/// The writing half of a [`Link`].
pub struct Writer<W> {
    stream: W,
    send: Seal,
}

impl<W: AsyncWrite + Unpin> Writer<W> {
    pub async fn send(&mut self, message: &ToDevice) -> Result<(), Error> {
        send_control(&mut self.stream, &mut self.send, message).await
    }

    pub async fn send_audio(&mut self, frame: &[u8]) -> Result<(), Error> {
        send_sealed(&mut self.stream, &mut self.send, AUDIO, frame).await
    }
}

async fn send_control<W: AsyncWrite + Unpin>(
    stream: &mut W,
    seal: &mut Seal,
    message: &ToDevice,
) -> Result<(), Error> {
    let json = serde_json::to_vec(message).map_err(|_| Error::Protocol("encode"))?;
    send_sealed(stream, seal, CONTROL, &json).await
}

async fn send_sealed<W: AsyncWrite + Unpin>(
    stream: &mut W,
    seal: &mut Seal,
    kind: u8,
    data: &[u8],
) -> Result<(), Error> {
    if data.len() > MAX_PLAIN {
        return Err(Error::Protocol("frame too long"));
    }
    let sealed = seal.seal(kind, data);
    write_frame(stream, &sealed).await
}

async fn receive_one<R: AsyncRead + Unpin>(
    stream: &mut R,
    seal: &mut Seal,
) -> Result<Incoming, Error> {
    let frame = read_frame(stream, MAX_FRAME).await?;
    let (kind, data) = seal.open(&frame)?;
    match kind {
        CONTROL => serde_json::from_slice(&data)
            .map(Incoming::Control)
            .map_err(|_| Error::Protocol("message")),
        AUDIO => Ok(Incoming::Audio(data)),
        _ => Err(Error::Protocol("frame type")),
    }
}

/// What a device opens a connection with.
pub(super) enum Opening {
    /// A paired device coming back.
    Hello { device_id: String, nonce: [u8; 16] },
    /// A device that wants to pair.
    Pair(PairHello),
}

/// The pairing request: the device's id and name, and the salt and `B` it made from the code.
pub(super) struct PairHello {
    pub device_id: String,
    pub name: String,
    pub salt: Vec<u8>,
    pub b: Vec<u8>,
}

/// Reads how a device opens the connection.
pub(super) async fn open<S: AsyncRead + Unpin>(stream: &mut S) -> Result<Opening, Error> {
    match read_clear(stream).await? {
        Clear::Hello {
            v,
            device_id,
            nonce,
        } => {
            if v != VERSION {
                return Err(Error::Protocol("version"));
            }
            let nonce = unhex(&nonce).ok_or(Error::Protocol("nonce"))?;
            Ok(Opening::Hello { device_id, nonce })
        }
        Clear::PairHello {
            v,
            device_id,
            name,
            salt,
            b,
        } => {
            if v != VERSION {
                return Err(Error::Protocol("version"));
            }
            let salt = unhex_vec(&salt, 8, 64).ok_or(Error::Protocol("salt"))?;
            let b = unhex_vec(&b, 1, 384).ok_or(Error::Protocol("b"))?;
            Ok(Opening::Pair(PairHello {
                device_id,
                name,
                salt,
                b,
            }))
        }
        _ => Err(Error::Protocol("expected hello")),
    }
}

/// Hex of `min` to `max` bytes.
pub(super) fn unhex_vec(text: &str, min: usize, max: usize) -> Option<Vec<u8>> {
    let len = text.len() / 2;
    if !text.len().is_multiple_of(2) || !(min..=max).contains(&len) {
        return None;
    }
    text.as_bytes()
        .chunks(2)
        .map(|pair| u8::from_str_radix(std::str::from_utf8(pair).ok()?, 16).ok())
        .collect()
}

/// The daemon's side for a paired device: it is answered only when it is paired and then proves it
/// holds the key. `key_of` gives a paired device's key.
pub(super) async fn accept_hello<S, F>(
    mut stream: S,
    daemon_id: &str,
    device_id: String,
    nonce_d: [u8; 16],
    key_of: F,
) -> Result<Link<S>, Error>
where
    S: AsyncRead + AsyncWrite + Unpin,
    F: FnOnce(&str) -> Option<[u8; 32]>,
{
    // An unknown device gets no answer at all, so it learns nothing, not even that it was once paired.
    let key = key_of(&device_id).ok_or(Error::Unknown)?;
    let nonce_s = random::<16>();
    write_clear(
        &mut stream,
        &Clear::Challenge {
            daemon_id: daemon_id.to_owned(),
            nonce: hex(&nonce_s),
        },
    )
    .await?;
    let keys = derive(&key, &nonce_d, &nonce_s);
    let Clear::Auth { mac: proof } = read_clear(&mut stream).await? else {
        return Err(Error::Protocol("expected auth"));
    };
    let proof: [u8; 32] = unhex(&proof).ok_or(Error::Auth)?;
    // Compared in constant time by the MAC itself.
    mac(&keys.mac, b"device", &nonce_s)
        .verify_slice(&proof)
        .map_err(|_| Error::Auth)?;
    let ready = mac(&keys.mac, b"daemon", &nonce_d).finalize().into_bytes();
    write_clear(&mut stream, &Clear::Ready { mac: hex(&ready) }).await?;
    Ok(Link {
        stream,
        device_id,
        send: Seal::new(&keys.to_device),
        receive: Seal::new(&keys.from_device),
    })
}

/// Opens and accepts a paired device in one step (the tests; the server looks at the opening first).
#[cfg(test)]
pub async fn accept<S, F>(mut stream: S, daemon_id: &str, key_of: F) -> Result<Link<S>, Error>
where
    S: AsyncRead + AsyncWrite + Unpin,
    F: FnOnce(&str) -> Option<[u8; 32]>,
{
    match open(&mut stream).await? {
        Opening::Hello { device_id, nonce } => {
            accept_hello(stream, daemon_id, device_id, nonce, key_of).await
        }
        Opening::Pair(_) => Err(Error::Protocol("expected hello")),
    }
}

/// The device's side, as the firmware does it. The daemon does not need it; the tests and a device
/// simulator do.
#[cfg(test)]
pub async fn connect<S: AsyncRead + AsyncWrite + Unpin>(
    mut stream: S,
    device_id: &str,
    key: &[u8; 32],
) -> Result<DeviceLink<S>, Error> {
    let nonce_d = random::<16>();
    write_clear(
        &mut stream,
        &Clear::Hello {
            v: VERSION,
            device_id: device_id.to_owned(),
            nonce: hex(&nonce_d),
        },
    )
    .await?;
    let Clear::Challenge { nonce, .. } = read_clear(&mut stream).await? else {
        return Err(Error::Protocol("expected challenge"));
    };
    let nonce_s: [u8; 16] = unhex(&nonce).ok_or(Error::Protocol("nonce"))?;
    let keys = derive(key, &nonce_d, &nonce_s);
    let proof = mac(&keys.mac, b"device", &nonce_s).finalize().into_bytes();
    write_clear(&mut stream, &Clear::Auth { mac: hex(&proof) }).await?;
    let Clear::Ready { mac: answer } = read_clear(&mut stream).await? else {
        return Err(Error::Protocol("expected ready"));
    };
    let answer: [u8; 32] = unhex(&answer).ok_or(Error::Auth)?;
    mac(&keys.mac, b"daemon", &nonce_d)
        .verify_slice(&answer)
        .map_err(|_| Error::Auth)?;
    Ok(DeviceLink {
        stream,
        send: Seal::new(&keys.from_device),
        receive: Seal::new(&keys.to_device),
    })
}

/// The device end of a connection, for tests.
#[cfg(test)]
pub struct DeviceLink<S> {
    stream: S,
    send: Seal,
    receive: Seal,
}

#[cfg(test)]
impl<S: AsyncRead + AsyncWrite + Unpin> DeviceLink<S> {
    pub async fn send(&mut self, message: &FromDevice) -> Result<(), Error> {
        let json = serde_json::to_vec(message).unwrap();
        let sealed = self.send.seal(CONTROL, &json);
        write_frame(&mut self.stream, &sealed).await
    }

    pub async fn send_audio(&mut self, frame: &[u8]) -> Result<(), Error> {
        let sealed = self.send.seal(AUDIO, frame);
        write_frame(&mut self.stream, &sealed).await
    }

    pub async fn receive(&mut self) -> Result<ToDevice, Error> {
        let frame = read_frame(&mut self.stream, MAX_FRAME).await?;
        let (kind, data) = self.receive.open(&frame)?;
        assert_eq!(kind, CONTROL);
        serde_json::from_slice(&data).map_err(|_| Error::Protocol("message"))
    }

    /// Writes a sealed frame the way the device would, but by hand, to try what the daemon refuses.
    pub async fn send_raw(&mut self, bytes: &[u8]) -> Result<(), Error> {
        write_frame(&mut self.stream, bytes).await
    }

    pub fn seal_next(&mut self, message: &FromDevice) -> Vec<u8> {
        self.send
            .seal(CONTROL, &serde_json::to_vec(message).unwrap())
    }
}

#[cfg(test)]
mod tests {
    use tokio::io::duplex;

    use super::*;
    use crate::device::proto::Action;

    const MAC: &str = "10:b4:1d:e9:9d:34";
    const KEY: [u8; 32] = [7; 32];

    fn lookup(id: &str) -> Option<[u8; 32]> {
        (id == MAC).then_some(KEY)
    }

    async fn pair_up(
        device_key: [u8; 32],
    ) -> (
        Result<Link<tokio::io::DuplexStream>, Error>,
        Result<DeviceLink<tokio::io::DuplexStream>, Error>,
    ) {
        let (daemon_end, device_end) = duplex(64 * 1024);
        let daemon = accept(daemon_end, "daemon-id", lookup);
        let device = connect(device_end, MAC, &device_key);
        tokio::join!(daemon, device)
    }

    fn button() -> FromDevice {
        FromDevice::Button {
            id: 1,
            action: Action::Press,
        }
    }

    #[tokio::test]
    async fn a_paired_device_connects_and_talks_both_ways() {
        let (daemon, device) = pair_up(KEY).await;
        let (mut daemon, mut device) = (daemon.unwrap(), device.unwrap());
        assert_eq!(daemon.device_id(), MAC);
        device.send(&button()).await.unwrap();
        assert_eq!(daemon.receive().await.unwrap(), Incoming::Control(button()));
        daemon.send(&ToDevice::Pong).await.unwrap();
        assert_eq!(device.receive().await.unwrap(), ToDevice::Pong);
        device.send_audio(&[1, 2, 3]).await.unwrap();
        assert_eq!(daemon.receive().await.unwrap(), Incoming::Audio(vec![1, 2, 3]));
    }

    #[tokio::test]
    async fn a_device_that_is_not_paired_gets_no_answer() {
        let (daemon_end, mut device_end) = duplex(4096);
        let hello = Clear::Hello {
            v: VERSION,
            device_id: "aa:bb:cc".into(),
            nonce: hex(&random::<16>()),
        };
        write_clear(&mut device_end, &hello).await.unwrap();
        let result = accept(daemon_end, "daemon-id", lookup).await;
        assert!(matches!(result, Err(Error::Unknown)));
        // The daemon's end is gone and wrote nothing.
        let mut rest = Vec::new();
        device_end.read_to_end(&mut rest).await.unwrap();
        assert!(rest.is_empty());
    }

    #[tokio::test]
    async fn a_wrong_key_is_refused_and_gets_no_ready() {
        let (daemon, device) = pair_up([8; 32]).await;
        assert!(matches!(daemon, Err(Error::Auth)));
        assert!(device.is_err());
    }

    #[tokio::test]
    async fn a_changed_frame_ends_the_connection() {
        let (daemon, device) = pair_up(KEY).await;
        let (mut daemon, mut device) = (daemon.unwrap(), device.unwrap());
        let mut sealed = device.seal_next(&button());
        let last = sealed.len() - 1;
        sealed[last] ^= 1;
        device.send_raw(&sealed).await.unwrap();
        assert!(matches!(daemon.receive().await, Err(Error::Sealed)));
    }

    #[tokio::test]
    async fn a_repeated_frame_is_refused() {
        let (daemon, device) = pair_up(KEY).await;
        let (mut daemon, mut device) = (daemon.unwrap(), device.unwrap());
        let sealed = device.seal_next(&button());
        device.send_raw(&sealed).await.unwrap();
        device.send_raw(&sealed).await.unwrap();
        assert!(daemon.receive().await.is_ok());
        assert!(matches!(daemon.receive().await, Err(Error::Sealed)));
    }

    #[tokio::test]
    async fn a_dropped_frame_is_noticed() {
        let (daemon, device) = pair_up(KEY).await;
        let (mut daemon, mut device) = (daemon.unwrap(), device.unwrap());
        let _lost = device.seal_next(&button());
        device.send(&button()).await.unwrap();
        assert!(matches!(daemon.receive().await, Err(Error::Sealed)));
    }

    #[tokio::test]
    async fn the_two_directions_use_different_keys() {
        let keys = derive(&KEY, &[1; 16], &[2; 16]);
        assert_ne!(keys.from_device, keys.to_device);
        assert_ne!(keys.mac, keys.from_device);
        // A frame the daemon sends does not open as one the device sent.
        let mut daemon_send = Seal::new(&keys.to_device);
        let mut daemon_receive = Seal::new(&keys.from_device);
        let sealed = daemon_send.seal(CONTROL, b"{}");
        assert!(matches!(daemon_receive.open(&sealed), Err(Error::Sealed)));
    }

    #[tokio::test]
    async fn each_connection_has_its_own_keys() {
        let first = derive(&KEY, &random::<16>(), &random::<16>());
        let second = derive(&KEY, &random::<16>(), &random::<16>());
        assert_ne!(first.from_device, second.from_device);
    }

    #[tokio::test]
    async fn a_frame_over_the_limit_is_refused_before_it_is_read() {
        let (mut writer, mut reader) = duplex(64);
        writer.write_all(&u16::MAX.to_be_bytes()).await.unwrap();
        let result = read_frame(&mut reader, MAX_FRAME).await;
        assert!(matches!(result, Err(Error::Protocol("frame too long"))));
    }

    #[tokio::test]
    async fn a_split_link_reads_and_writes_apart() {
        let (daemon, device) = pair_up(KEY).await;
        let (daemon, mut device) = (daemon.unwrap(), device.unwrap());
        let (id, mut reader, mut writer) = daemon.split();
        assert_eq!(id, MAC);
        device.send(&button()).await.unwrap();
        writer.send(&ToDevice::Pong).await.unwrap();
        assert_eq!(reader.receive().await.unwrap(), Incoming::Control(button()));
        assert_eq!(device.receive().await.unwrap(), ToDevice::Pong);
    }

    #[tokio::test]
    async fn a_wrong_version_is_refused() {
        let (daemon_end, mut device_end) = duplex(4096);
        let hello = Clear::Hello {
            v: 9,
            device_id: MAC.into(),
            nonce: hex(&random::<16>()),
        };
        write_clear(&mut device_end, &hello).await.unwrap();
        let result = accept(daemon_end, "daemon-id", lookup).await;
        assert!(matches!(result, Err(Error::Protocol("version"))));
    }

    #[test]
    fn hex_decoding_is_strict() {
        assert_eq!(unhex::<2>("0aff"), Some([0x0a, 0xff]));
        assert_eq!(unhex::<2>("0af"), None);
        assert_eq!(unhex::<2>("0agg"), None);
    }
}
