// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 zickrian

//! Pairing over the socket, the daemon's side. The user typed the code on the device; the island shows it.
//! The device made a salt and `B` from it (see `srp.rs`), so both ends reach the same key `K` only when they
//! hold the same code. Each proves it with a MAC over `K`, the user is asked to allow the device, and only
//! then does the long-term device key travel, sealed with a key from `K`. A wrong code ends the connection without a
//! word; a refusal says `pair.denied` first; a timeout ends it. No key is given in any of them.

use std::future::Future;

use chacha20poly1305::aead::{Aead, KeyInit};
use chacha20poly1305::{ChaCha20Poly1305, Key, Nonce};
use hkdf::Hkdf;
use hmac::{Hmac, Mac};
use sha2::Sha256;
use tokio::io::{AsyncRead, AsyncWrite};

use super::link::{Clear, Error, PairHello, read_clear, unhex, write_clear};
use super::srp::{Client, KEY_LEN};
use crate::share::hex;

/// The length `A` and `B` are padded to in what the MACs cover.
const N_LEN: usize = 384;

/// A device asking to pair, as the user sees it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Offer {
    pub device_id: String,
    pub name: String,
}

struct Keys {
    mac: [u8; 32],
    seal: [u8; 32],
}

fn derive(k: &[u8; KEY_LEN]) -> Keys {
    let hkdf = Hkdf::<Sha256>::new(Some(b"niro-device v1 pair"), k);
    let mut keys = Keys {
        mac: [0; 32],
        seal: [0; 32],
    };
    hkdf.expand(b"mac", &mut keys.mac).expect("32 bytes");
    hkdf.expand(b"seal", &mut keys.seal).expect("32 bytes");
    keys
}

fn padded(bytes: &[u8]) -> Vec<u8> {
    let mut out = vec![0u8; N_LEN.saturating_sub(bytes.len())];
    out.extend_from_slice(bytes);
    out
}

/// What both MACs cover: `A` and `B`, each padded.
fn transcript(a: &[u8], b: &[u8]) -> Vec<u8> {
    [padded(a), padded(b)].concat()
}

fn mac(key: &[u8; 32], who: &[u8], transcript: &[u8]) -> Hmac<Sha256> {
    let mut mac = <Hmac<Sha256> as Mac>::new_from_slice(key).expect("any key length");
    mac.update(who);
    mac.update(transcript);
    mac
}

/// Pairs a device that opened with `pair.hello`. `approve` asks the user and, when allowed, pairs the device
/// and gives its new key; None means the user said no. The code is counted as tried before this runs.
pub async fn enroll<S, F, Fut>(
    mut stream: S,
    hello: PairHello,
    code: &str,
    daemon_id: &str,
    approve: F,
) -> Result<(), Error>
where
    S: AsyncRead + AsyncWrite + Unpin,
    F: FnOnce(Offer) -> Fut,
    Fut: Future<Output = Option<[u8; 32]>>,
{
    let daemon_id: [u8; 16] = unhex(daemon_id).ok_or(Error::Protocol("daemon id"))?;
    let client = Client::new();
    let a = client.public();
    write_clear(&mut stream, &Clear::PairA { a: hex(&a) }).await?;
    let k = client
        .finish(code, &hello.salt, &hello.b)
        .map_err(|_| Error::Protocol("b"))?;
    let keys = derive(&k);
    let transcript = transcript(&a, &hello.b);

    let Clear::PairProof { mac: proof } = read_clear(&mut stream).await? else {
        return Err(Error::Protocol("expected proof"));
    };
    let proof: [u8; 32] = unhex(&proof).ok_or(Error::Auth)?;
    // A wrong code gives another K, so this fails; the MAC compares in constant time.
    mac(&keys.mac, b"device", &transcript)
        .verify_slice(&proof)
        .map_err(|_| Error::Auth)?;

    let Some(device_key) = approve(Offer {
        device_id: hello.device_id,
        name: hello.name,
    })
    .await
    else {
        // Said, so the device can tell a refusal from a wrong code (which gets no word at all).
        let _ = write_clear(&mut stream, &Clear::PairDenied).await;
        return Err(Error::Declined);
    };

    let mut secret = Vec::with_capacity(48);
    secret.extend_from_slice(&daemon_id);
    secret.extend_from_slice(&device_key);
    // The key is used for this one message, so a fixed nonce is safe.
    let sealed = ChaCha20Poly1305::new(Key::from_slice(&keys.seal))
        .encrypt(Nonce::from_slice(&[0u8; 12]), secret.as_slice())
        .expect("sealing 48 bytes cannot fail");
    let done = mac(&keys.mac, b"daemon", &transcript).finalize().into_bytes();
    write_clear(
        &mut stream,
        &Clear::PairDone {
            mac: hex(&done),
            sealed: hex(&sealed),
        },
    )
    .await
}

/// The device's side, as the firmware does it, for the tests: gives the daemon id and the device key.
#[cfg(test)]
pub async fn pair_as_device<S: AsyncRead + AsyncWrite + Unpin>(
    mut stream: S,
    code: &str,
    device_id: &str,
    name: &str,
) -> Result<([u8; 16], [u8; 32]), Error> {
    use super::srp::sim::Device;
    use crate::share::random;
    use num_bigint::BigUint;

    let device = Device::new(code, &random::<16>(), &random::<48>());
    let b = padded(&device.b_pub.to_bytes_be());
    write_clear(
        &mut stream,
        &Clear::PairHello {
            v: super::link::VERSION,
            device_id: device_id.to_owned(),
            name: name.to_owned(),
            salt: hex(&device.salt),
            b: hex(&b),
        },
    )
    .await?;
    let Clear::PairA { a } = read_clear(&mut stream).await? else {
        return Err(Error::Protocol("expected a"));
    };
    let a_bytes = super::link::unhex_vec(&a, 1, 384).ok_or(Error::Protocol("a"))?;
    let k = device.key(&BigUint::from_bytes_be(&a_bytes));
    let keys = derive(&k);
    let transcript = transcript(&a_bytes, &b);
    let proof = mac(&keys.mac, b"device", &transcript).finalize().into_bytes();
    write_clear(&mut stream, &Clear::PairProof { mac: hex(&proof) }).await?;
    let Clear::PairDone { mac: answer, sealed } = read_clear(&mut stream).await? else {
        return Err(Error::Protocol("expected done"));
    };
    let answer: [u8; 32] = unhex(&answer).ok_or(Error::Auth)?;
    mac(&keys.mac, b"daemon", &transcript)
        .verify_slice(&answer)
        .map_err(|_| Error::Auth)?;
    let sealed = super::link::unhex_vec(&sealed, 1, 256).ok_or(Error::Protocol("sealed"))?;
    let secret = ChaCha20Poly1305::new(Key::from_slice(&keys.seal))
        .decrypt(Nonce::from_slice(&[0u8; 12]), sealed.as_slice())
        .map_err(|_| Error::Sealed)?;
    if secret.len() != 48 {
        return Err(Error::Protocol("secret"));
    }
    let mut daemon_id = [0u8; 16];
    let mut device_key = [0u8; 32];
    daemon_id.copy_from_slice(&secret[..16]);
    device_key.copy_from_slice(&secret[16..]);
    Ok((daemon_id, device_key))
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex};

    use tokio::io::duplex;

    use super::super::link::{Opening, open};
    use super::*;

    const MAC: &str = "10:b4:1d:e9:9d:34";
    const DAEMON: &str = "000102030405060708090a0b0c0d0e0f";
    const KEY: [u8; 32] = [9; 32];

    /// Runs both ends; `approve` records what it was asked and answers `answer`.
    async fn run(
        daemon_code: &str,
        typed: &str,
        answer: Option<[u8; 32]>,
    ) -> (
        Result<(), Error>,
        Result<([u8; 16], [u8; 32]), Error>,
        Vec<Offer>,
    ) {
        let (daemon_end, device_end) = duplex(64 * 1024);
        let asked = Arc::new(Mutex::new(Vec::new()));
        let log = asked.clone();
        let daemon = async move {
            let mut stream = daemon_end;
            let Opening::Pair(hello) = open(&mut stream).await? else {
                return Err(Error::Protocol("expected pair"));
            };
            enroll(stream, hello, daemon_code, DAEMON, move |offer| async move {
                log.lock().unwrap().push(offer);
                answer
            })
            .await
        };
        let device = pair_as_device(device_end, typed, MAC, "Desk");
        let (daemon, device) = tokio::join!(daemon, device);
        let asked = asked.lock().unwrap().clone();
        (daemon, device, asked)
    }

    #[tokio::test]
    async fn the_right_code_pairs_and_the_key_arrives() {
        let (daemon, device, asked) = run("123456", "123456", Some(KEY)).await;
        daemon.unwrap();
        let (daemon_id, key) = device.unwrap();
        assert_eq!(key, KEY);
        assert_eq!(hex(&daemon_id), DAEMON);
        assert_eq!(
            asked,
            vec![Offer {
                device_id: MAC.into(),
                name: "Desk".into()
            }]
        );
    }

    #[tokio::test]
    async fn a_wrong_code_fails_before_the_user_is_asked() {
        let (daemon, device, asked) = run("123456", "654321", Some(KEY)).await;
        assert!(matches!(daemon, Err(Error::Auth)));
        assert!(device.is_err());
        assert!(asked.is_empty());
    }

    #[tokio::test]
    async fn a_refusal_gives_no_key() {
        let (daemon, device, asked) = run("123456", "123456", None).await;
        assert!(matches!(daemon, Err(Error::Declined)));
        assert!(device.is_err());
        assert_eq!(asked.len(), 1);
    }

    /// A stream that records every byte read from it.
    struct Tap<S> {
        inner: S,
        seen: Arc<Mutex<Vec<u8>>>,
    }

    impl<S: AsyncRead + Unpin> AsyncRead for Tap<S> {
        fn poll_read(
            mut self: std::pin::Pin<&mut Self>,
            cx: &mut std::task::Context<'_>,
            buf: &mut tokio::io::ReadBuf<'_>,
        ) -> std::task::Poll<std::io::Result<()>> {
            let before = buf.filled().len();
            let poll = std::pin::Pin::new(&mut self.inner).poll_read(cx, buf);
            if let std::task::Poll::Ready(Ok(())) = poll {
                let new = buf.filled()[before..].to_vec();
                self.seen.lock().unwrap().extend(new);
            }
            poll
        }
    }

    impl<S: AsyncWrite + Unpin> AsyncWrite for Tap<S> {
        fn poll_write(
            mut self: std::pin::Pin<&mut Self>,
            cx: &mut std::task::Context<'_>,
            data: &[u8],
        ) -> std::task::Poll<std::io::Result<usize>> {
            std::pin::Pin::new(&mut self.inner).poll_write(cx, data)
        }
        fn poll_flush(
            mut self: std::pin::Pin<&mut Self>,
            cx: &mut std::task::Context<'_>,
        ) -> std::task::Poll<std::io::Result<()>> {
            std::pin::Pin::new(&mut self.inner).poll_flush(cx)
        }
        fn poll_shutdown(
            mut self: std::pin::Pin<&mut Self>,
            cx: &mut std::task::Context<'_>,
        ) -> std::task::Poll<std::io::Result<()>> {
            std::pin::Pin::new(&mut self.inner).poll_shutdown(cx)
        }
    }

    fn contains(haystack: &[u8], needle: &[u8]) -> bool {
        haystack.windows(needle.len()).any(|window| window == needle)
    }

    #[tokio::test]
    async fn the_key_does_not_travel_in_the_clear() {
        let (daemon_end, device_end) = duplex(64 * 1024);
        let seen = Arc::new(Mutex::new(Vec::new()));
        let tap = Tap {
            inner: device_end,
            seen: seen.clone(),
        };
        let daemon = async move {
            let mut stream = daemon_end;
            let Opening::Pair(hello) = open(&mut stream).await.unwrap() else {
                panic!("not pair");
            };
            enroll(stream, hello, "123456", DAEMON, |_| async { Some(KEY) }).await
        };
        let (daemon, device) = tokio::join!(daemon, pair_as_device(tap, "123456", MAC, "Desk"));
        daemon.unwrap();
        assert_eq!(device.unwrap().1, KEY);
        let seen = seen.lock().unwrap();
        // Everything the daemon sent: its A, its MAC and the sealed secret. Neither the key nor the daemon
        // id appears, as bytes or as hex.
        assert!(seen.len() > 100);
        for secret in [&KEY[..], hex(&KEY).as_bytes(), DAEMON.as_bytes()] {
            assert!(!contains(&seen, secret));
        }
        assert!(!contains(&seen, &[0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]));
    }

    #[test]
    fn padded_values_keep_their_length() {
        assert_eq!(padded(&[1, 2]).len(), N_LEN);
        assert_eq!(&padded(&[1, 2])[N_LEN - 2..], &[1, 2]);
        assert_eq!(padded(&[7; N_LEN]).len(), N_LEN);
    }
}
