// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 zickrian

//! The devices paired with this Niro, each with the key only the two of them hold. Kept in
//! `~/.local/share/island/devices.json` (the store writes it private to the user).

use serde::{Deserialize, Serialize};
use subtle::ConstantTimeEq;

use crate::share::{hex, random};

/// One paired device.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Paired {
    /// The device's MAC, as it tells it (shown, never trusted on its own: the key proves it).
    pub device_id: String,
    pub name: String,
    /// 32 random bytes in hex, made for this device at pairing.
    pub key: String,
    pub paired_at_ms: i64,
}

/// The list kept on disk.
#[derive(Debug, Default, Serialize, Deserialize)]
pub struct PairedDevices {
    pub devices: Vec<Paired>,
}

impl PairedDevices {
    /// Pairs a device and returns its new key. A device already paired gets a new key, and the old one
    /// stops working: pairing again is how a lost key is replaced.
    pub fn add(&mut self, device_id: &str, name: &str, now_ms: i64) -> String {
        self.devices.retain(|device| device.device_id != device_id);
        let key = hex(&random::<32>());
        self.devices.push(Paired {
            device_id: device_id.to_owned(),
            name: name.to_owned(),
            key: key.clone(),
            paired_at_ms: now_ms,
        });
        key
    }

    /// Forgets a device; true when it was paired.
    pub fn forget(&mut self, device_id: &str) -> bool {
        let before = self.devices.len();
        self.devices.retain(|device| device.device_id != device_id);
        self.devices.len() != before
    }

    /// The device with this id, if paired.
    pub fn find(&self, device_id: &str) -> Option<&Paired> {
        self.devices
            .iter()
            .find(|device| device.device_id == device_id)
    }

    /// Whether `key` is this device's key, compared in constant time.
    pub fn key_matches(&self, device_id: &str, key: &str) -> bool {
        self.find(device_id)
            .is_some_and(|device| device.key.as_bytes().ct_eq(key.as_bytes()).into())
    }

    /// Renames a device; true when it was paired.
    pub fn rename(&mut self, device_id: &str, name: &str) -> bool {
        match self
            .devices
            .iter_mut()
            .find(|device| device.device_id == device_id)
        {
            Some(device) => {
                device.name = name.to_owned();
                true
            }
            None => false,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const MAC: &str = "10:b4:1d:e9:9d:34";

    #[test]
    fn pairing_gives_a_64_digit_hex_key() {
        let mut devices = PairedDevices::default();
        let key = devices.add(MAC, "Desk", 1);
        assert_eq!(key.len(), 64);
        assert!(key.bytes().all(|b| b.is_ascii_hexdigit()));
        assert!(devices.key_matches(MAC, &key));
    }

    #[test]
    fn a_wrong_or_unknown_key_does_not_match() {
        let mut devices = PairedDevices::default();
        let key = devices.add(MAC, "Desk", 1);
        assert!(!devices.key_matches(MAC, &"0".repeat(64)));
        assert!(!devices.key_matches("other", &key));
        assert!(!devices.key_matches(MAC, ""));
    }

    #[test]
    fn pairing_again_replaces_the_key() {
        let mut devices = PairedDevices::default();
        let old = devices.add(MAC, "Desk", 1);
        let new = devices.add(MAC, "Desk", 2);
        assert_ne!(old, new);
        assert_eq!(devices.devices.len(), 1);
        assert!(!devices.key_matches(MAC, &old));
        assert!(devices.key_matches(MAC, &new));
    }

    #[test]
    fn forgetting_removes_the_device() {
        let mut devices = PairedDevices::default();
        let key = devices.add(MAC, "Desk", 1);
        assert!(devices.forget(MAC));
        assert!(!devices.forget(MAC));
        assert!(!devices.key_matches(MAC, &key));
    }

    #[test]
    fn renaming_keeps_the_key() {
        let mut devices = PairedDevices::default();
        let key = devices.add(MAC, "Desk", 1);
        assert!(devices.rename(MAC, "Kitchen"));
        assert!(!devices.rename("other", "x"));
        assert_eq!(devices.find(MAC).map(|d| d.name.as_str()), Some("Kitchen"));
        assert!(devices.key_matches(MAC, &key));
    }

    #[test]
    fn it_round_trips_through_json() {
        let mut devices = PairedDevices::default();
        let key = devices.add(MAC, "Desk", 7);
        let json = serde_json::to_string(&devices).unwrap();
        let back: PairedDevices = serde_json::from_str(&json).unwrap();
        assert!(back.key_matches(MAC, &key));
    }
}
