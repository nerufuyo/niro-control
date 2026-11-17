// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 zickrian

//! The pairing code: six digits the island shows and the user types on the device. It lives two minutes,
//! allows five tries and works once. The code is the password of the key exchange; it is never sent, so
//! this module only decides whether another try may be made, not whether a guess is right.

use std::time::{Duration, Instant};

use crate::share::random;

/// How long a code lives.
pub const LIFETIME: Duration = Duration::from_secs(120);
/// Tries before the code is thrown away.
pub const MAX_TRIES: u8 = 5;
const DIGITS: usize = 6;

/// Why a try was not allowed.
#[derive(Debug, PartialEq, Eq)]
pub enum Refused {
    /// The two minutes passed.
    Expired,
    /// All the tries were used.
    Locked,
    /// The code was already used to pair.
    Used,
}

/// One pairing code and what is left of it.
#[derive(Debug)]
pub struct Pairing {
    code: String,
    expires: Instant,
    tries: u8,
    used: bool,
}

impl Pairing {
    /// A fresh code, valid from `now`.
    pub fn start(now: Instant) -> Self {
        Self {
            code: new_code(),
            expires: now + LIFETIME,
            tries: 0,
            used: false,
        }
    }

    /// The code to show on the island.
    pub fn code(&self) -> &str {
        &self.code
    }

    /// How many tries have been made.
    #[cfg(test)]
    pub fn tries(&self) -> u8 {
        self.tries
    }

    /// Seconds left, for the island's countdown.
    pub fn seconds_left(&self, now: Instant) -> u64 {
        self.expires.saturating_duration_since(now).as_secs()
    }

    /// Whether the code still takes tries, for the mDNS `pair` flag.
    pub fn open(&self, now: Instant) -> bool {
        !self.used && self.tries < MAX_TRIES && now < self.expires
    }

    /// A device starts a key exchange: counts a try and hands out the password for it. The try counts
    /// whether or not the exchange then succeeds, so a device cannot probe the code for free.
    pub fn attempt(&mut self, now: Instant) -> Result<&str, Refused> {
        if self.used {
            return Err(Refused::Used);
        }
        if now >= self.expires {
            return Err(Refused::Expired);
        }
        if self.tries >= MAX_TRIES {
            return Err(Refused::Locked);
        }
        self.tries += 1;
        Ok(&self.code)
    }

    /// The exchange succeeded and the user allowed it: the code is spent.
    pub fn spend(&mut self) {
        self.used = true;
    }
}

/// Six digits, every one equally likely (no bias from taking a remainder).
fn new_code() -> String {
    const LIMIT: u32 = u32::MAX - u32::MAX % 1_000_000;
    loop {
        let n = u32::from_le_bytes(random::<4>());
        if n < LIMIT {
            return format!("{:0width$}", n % 1_000_000, width = DIGITS);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_code_is_six_digits() {
        for _ in 0..200 {
            let code = new_code();
            assert_eq!(code.len(), 6);
            assert!(code.bytes().all(|b| b.is_ascii_digit()), "{code}");
        }
    }

    #[test]
    fn codes_differ() {
        let first = new_code();
        assert!((0..20).any(|_| new_code() != first));
    }

    #[test]
    fn it_allows_five_tries_then_locks() {
        let now = Instant::now();
        let mut pairing = Pairing::start(now);
        for _ in 0..MAX_TRIES {
            assert!(pairing.attempt(now).is_ok());
        }
        assert_eq!(pairing.attempt(now), Err(Refused::Locked));
        assert!(!pairing.open(now));
    }

    #[test]
    fn it_expires_after_two_minutes() {
        let now = Instant::now();
        let mut pairing = Pairing::start(now);
        assert!(pairing.open(now + Duration::from_secs(119)));
        assert_eq!(pairing.seconds_left(now), 120);
        let later = now + LIFETIME;
        assert_eq!(pairing.attempt(later), Err(Refused::Expired));
        assert!(!pairing.open(later));
        assert_eq!(pairing.seconds_left(later), 0);
    }

    #[test]
    fn a_spent_code_works_once() {
        let now = Instant::now();
        let mut pairing = Pairing::start(now);
        assert!(pairing.attempt(now).is_ok());
        pairing.spend();
        assert_eq!(pairing.attempt(now), Err(Refused::Used));
        assert!(!pairing.open(now));
    }

    #[test]
    fn a_try_returns_the_code_to_show() {
        let now = Instant::now();
        let mut pairing = Pairing::start(now);
        let shown = pairing.code().to_owned();
        assert_eq!(pairing.attempt(now), Ok(shown.as_str()));
    }
}
