// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 zickrian

//! The daemon's side of pairing: an SRP-6a client that agrees with ESP-IDF's `esp_srp` (the device is the
//! SRP server, because `esp_srp` has no client; it makes the salt and verifier from the code the user
//! types, and this side knows the code from the island).
//!
//! The `srp` crate is not used whole: it does not agree with `esp_srp` on three things, so only its
//! modular arithmetic and `x` are used and the rest follows `esp_srp.c` (ESP-IDF v5.4):
//!
//! | | `srp` crate | `esp_srp` (followed here) |
//! |---|---|---|
//! | `u` | `H(A \| B)`, unpadded | `H(PAD(A) \| PAD(B))`, padded to the length of N |
//! | key | the raw secret `S` | `K = H(S)` |
//! | proofs M1, M2 | `H(A,B,K)` | RFC 2945 |
//!
//! `H` is SHA-512, the group is the 3072-bit one (`g = 5`) and `x = H(salt | H(user ":" code))`. The proofs are
//! not used: once both sides hold `K`, the pairing confirms it with its own MAC (see the protocol document).
//!
//! Not confirmed against a device yet: whether `esp_srp` writes `S` with its minimal length (assumed here) or
//! padded before hashing. A real pairing with the board settles it.

use num_bigint::BigUint;
use sha2::{Digest, Sha512};
use srp::client::SrpClient;
use srp::groups::G_3072;

use crate::share::random;

/// The length of N in bytes: A and B are padded to it for `u`.
const N_LEN: usize = 384;
/// The user name SRP hashes with the code. Both sides use the same fixed one.
pub const USERNAME: &[u8] = b"niro-device";
/// Length of the session key `K`.
pub const KEY_LEN: usize = 64;

/// Why a pairing exchange failed.
#[derive(Debug, PartialEq, Eq)]
pub enum Failed {
    /// The device's public value is zero modulo N, or `u` is zero: never valid.
    BadValue,
}

/// One pairing exchange, from the daemon's side.
pub struct Client {
    a: BigUint,
    a_pub: BigUint,
}

impl Client {
    /// A new exchange with a fresh secret.
    pub fn new() -> Self {
        Self::with_secret(&random::<48>())
    }

    fn with_secret(secret: &[u8]) -> Self {
        let a = BigUint::from_bytes_be(secret);
        let a_pub = SrpClient::<Sha512>::new(&G_3072).compute_a_pub(&a);
        Self { a, a_pub }
    }

    /// `A`, padded to the length of N, to send to the device.
    pub fn public(&self) -> Vec<u8> {
        pad(&self.a_pub)
    }

    /// Takes the device's salt and `B` and the code, and gives `K`.
    pub fn finish(self, code: &str, salt: &[u8], b_pub: &[u8]) -> Result<[u8; KEY_LEN], Failed> {
        let group = &*G_3072;
        let client = SrpClient::<Sha512>::new(group);
        let b = BigUint::from_bytes_be(b_pub);
        if &b % &group.n == BigUint::default() {
            return Err(Failed::BadValue);
        }
        let u = compute_u(&self.a_pub, &b);
        if u == BigUint::default() {
            return Err(Failed::BadValue);
        }
        let k = compute_k(&group.n, &group.g);
        let identity = SrpClient::<Sha512>::compute_identity_hash(USERNAME, code.as_bytes());
        let x = SrpClient::<Sha512>::compute_x(identity.as_slice(), salt);
        let secret = client.compute_premaster_secret(&b, &k, &x, &self.a, &u);
        Ok(Sha512::digest(secret.to_bytes_be()).into())
    }
}

/// `u = H(PAD(A) | PAD(B))`.
fn compute_u(a: &BigUint, b: &BigUint) -> BigUint {
    let mut hash = Sha512::new();
    hash.update(pad(a));
    hash.update(pad(b));
    BigUint::from_bytes_be(&hash.finalize())
}

/// `k = H(PAD(N) | PAD(g))`.
fn compute_k(n: &BigUint, g: &BigUint) -> BigUint {
    let mut hash = Sha512::new();
    hash.update(pad(n));
    hash.update(pad(g));
    BigUint::from_bytes_be(&hash.finalize())
}

/// Big-endian, with leading zeros up to the length of N.
fn pad(value: &BigUint) -> Vec<u8> {
    let bytes = value.to_bytes_be();
    let mut out = vec![0u8; N_LEN.saturating_sub(bytes.len())];
    out.extend_from_slice(&bytes);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// What `esp_srp` does on the device, written from its source: the salt and verifier from the code
    /// (`x = H(salt | H(user ":" code))`, `v = g^x`), then `B = k v + g^b` and `K = H((A v^u)^b)`.
    struct Device {
        salt: Vec<u8>,
        v: BigUint,
        b: BigUint,
        b_pub: BigUint,
    }

    impl Device {
        fn new(code: &str, salt: &[u8], b_secret: &[u8]) -> Self {
            let n = &G_3072.n;
            let g = &G_3072.g;
            let inner = Sha512::new()
                .chain_update(USERNAME)
                .chain_update(b":")
                .chain_update(code.as_bytes())
                .finalize();
            let x = BigUint::from_bytes_be(
                &Sha512::new()
                    .chain_update(salt)
                    .chain_update(inner)
                    .finalize(),
            );
            let v = g.modpow(&x, n);
            let b = BigUint::from_bytes_be(b_secret);
            let b_pub = (compute_k(n, g) * &v + g.modpow(&b, n)) % n;
            Self {
                salt: salt.to_vec(),
                v,
                b,
                b_pub,
            }
        }

        fn key(&self, a_pub: &BigUint) -> [u8; KEY_LEN] {
            let n = &G_3072.n;
            let u = compute_u(a_pub, &self.b_pub);
            let s = (a_pub * self.v.modpow(&u, n) % n).modpow(&self.b, n);
            Sha512::digest(s.to_bytes_be()).into()
        }
    }

    fn pair(code: &str, typed: &str) -> ([u8; KEY_LEN], [u8; KEY_LEN]) {
        let device = Device::new(typed, &random::<16>(), &random::<48>());
        let client = Client::new();
        let a_pub = BigUint::from_bytes_be(&client.public());
        let device_key = device.key(&a_pub);
        let client_key = client
            .finish(code, &device.salt, &pad(&device.b_pub))
            .unwrap();
        (client_key, device_key)
    }

    #[test]
    fn both_sides_reach_the_same_key_with_the_same_code() {
        for _ in 0..3 {
            let (client, device) = pair("123456", "123456");
            assert_eq!(client, device);
        }
    }

    #[test]
    fn a_different_code_gives_a_different_key() {
        let (client, device) = pair("123456", "123457");
        assert_ne!(client, device);
    }

    #[test]
    fn each_exchange_has_its_own_key() {
        let (first, _) = pair("123456", "123456");
        let (second, _) = pair("123456", "123456");
        assert_ne!(first, second);
    }

    #[test]
    fn a_and_b_are_padded_for_u() {
        // A value with leading zero bytes hashes as its 384-byte form, not as its short one.
        let small = BigUint::from(0x0102u32);
        let mut padded = vec![0u8; N_LEN - 2];
        padded.extend_from_slice(&[1, 2]);
        assert_eq!(pad(&small), padded);
        let other = BigUint::from(7u8);
        let expected = BigUint::from_bytes_be(
            &Sha512::new()
                .chain_update(&padded)
                .chain_update(pad(&other))
                .finalize(),
        );
        assert_eq!(compute_u(&small, &other), expected);
    }

    #[test]
    fn the_public_value_has_the_length_of_n() {
        assert_eq!(Client::new().public().len(), N_LEN);
        assert_eq!(Client::with_secret(&[1]).public().len(), N_LEN);
    }

    #[test]
    fn a_zero_b_is_refused() {
        let client = Client::new();
        assert_eq!(
            client.finish("123456", b"salt", &[0u8; 4]),
            Err(Failed::BadValue)
        );
    }

    #[test]
    fn a_b_equal_to_n_is_refused() {
        let client = Client::new();
        let n = G_3072.n.to_bytes_be();
        assert_eq!(client.finish("123456", b"salt", &n), Err(Failed::BadValue));
    }

    #[test]
    fn the_group_is_the_3072_bit_one_with_g_5() {
        assert_eq!(G_3072.n.to_bytes_be().len(), N_LEN);
        assert_eq!(G_3072.g, BigUint::from(5u8));
    }
}
