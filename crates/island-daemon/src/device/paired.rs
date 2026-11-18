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
    /// The kinds of notification (`agent`, `reminder`, `meeting`, `battery`, `system`) the user turned off for this device;
    /// empty, as in a file from before this, is all on.
    #[serde(default)]
    pub muted: Vec<String>,
    /// What the user set in the panel, sent to the device whenever it connects.
    #[serde(default = "default_volume")]
    pub volume: u8,
    #[serde(default = "default_brightness")]
    pub brightness: u8,
    /// The language it listens and speaks (codes like `id,en`; empty: this computer's).
    #[serde(default)]
    pub language: String,
}

fn default_volume() -> u8 {
    70
}

fn default_brightness() -> u8 {
    100
}

/// The list kept on disk.
#[derive(Debug, Default, Serialize, Deserialize)]
pub struct PairedDevices {
    pub devices: Vec<Paired>,
    /// This daemon's own id (16 random bytes in hex), made once; a device stores it to know whom it paired with.
    #[serde(default)]
    pub daemon_id: String,
}

impl PairedDevices {
    /// This daemon's id, made on first use. True in the second value when it was just made (save the list).
    pub fn ensure_daemon_id(&mut self) -> (String, bool) {
        let fresh = self.daemon_id.len() != 32;
        if fresh {
            self.daemon_id = hex(&random::<16>());
        }
        (self.daemon_id.clone(), fresh)
    }

    /// The 32-byte key of a paired device, if it is paired and its stored key is well formed.
    pub fn key_bytes(&self, device_id: &str) -> Option<[u8; 32]> {
        let key = self.find(device_id)?.key.as_bytes();
        let mut out = [0u8; 32];
        if key.len() != 64 {
            return None;
        }
        for (byte, pair) in out.iter_mut().zip(key.chunks(2)) {
            *byte = u8::from_str_radix(std::str::from_utf8(pair).ok()?, 16).ok()?;
        }
        Some(out)
    }

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
            muted: Vec::new(),
            volume: default_volume(),
            brightness: default_brightness(),
            language: String::new(),
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

    /// Whether `key` (as bytes) is this device's key.
    #[cfg(test)]
    pub fn key_matches_bytes(&self, device_id: &str, key: &[u8; 32]) -> bool {
        self.key_matches(device_id, &hex(key))
    }

    /// Whether this device is to be shown notifications of `kind` (a device not paired is not).
    pub fn wants(&self, device_id: &str, kind: &str) -> bool {
        self.find(device_id)
            .is_some_and(|device| !device.muted.iter().any(|muted| muted == kind))
    }

    /// Turns notifications of `kind` on or off for a device; true when it was paired.
    pub fn set_kind(&mut self, device_id: &str, kind: &str, on: bool) -> bool {
        let Some(device) = self.devices.iter_mut().find(|device| device.device_id == device_id) else {
            return false;
        };
        device.muted.retain(|muted| muted != kind);
        if !on {
            device.muted.push(kind.to_owned());
        }
        true
    }

    /// Sets what the user chose for a device; true when it was paired.
    pub fn set_config(&mut self, device_id: &str, volume: u8, brightness: u8, language: &str) -> bool {
        let Some(device) = self.devices.iter_mut().find(|device| device.device_id == device_id) else {
            return false;
        };
        device.volume = volume;
        device.brightness = brightness;
        device.language = language.to_owned();
        true
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
    fn a_kind_can_be_turned_off_for_one_device_and_back_on() {
        let mut devices = PairedDevices::default();
        devices.add(MAC, "Desk", 1);
        assert!(devices.wants(MAC, "agent"));
        assert!(devices.set_kind(MAC, "agent", false));
        assert!(!devices.wants(MAC, "agent") && devices.wants(MAC, "battery"));
        assert!(devices.set_kind(MAC, "agent", false));
        assert_eq!(devices.find(MAC).unwrap().muted, ["agent"]);
        assert!(devices.set_kind(MAC, "agent", true));
        assert!(devices.wants(MAC, "agent"));
        assert!(!devices.set_kind("00:00:00:00:00:00", "agent", false));
        assert!(!devices.wants("00:00:00:00:00:00", "agent"));
    }

    #[test]
    fn the_settings_start_sensible_and_old_lists_get_them() {
        let old = r#"{"devices":[{"device_id":"a","name":"n","key":"k","paired_at_ms":1}],"daemon_id":""}"#;
        let mut devices: PairedDevices = serde_json::from_str(old).unwrap();
        let device = devices.find("a").unwrap();
        assert_eq!((device.volume, device.brightness, device.language.as_str()), (70, 100, ""));
        assert!(devices.set_config("a", 30, 50, "id"));
        assert_eq!(devices.find("a").unwrap().volume, 30);
        assert!(!devices.set_config("b", 1, 1, ""));
    }

    #[test]
    fn a_list_from_before_the_setting_has_everything_on() {
        let old = r#"{"devices":[{"device_id":"a","name":"n","key":"k","paired_at_ms":1}],"daemon_id":""}"#;
        let devices: PairedDevices = serde_json::from_str(old).unwrap();
        assert!(devices.wants("a", "meeting"));
    }

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
    fn a_key_comes_back_as_bytes() {
        let mut devices = PairedDevices::default();
        let key = devices.add(MAC, "Desk", 1);
        let bytes = devices.key_bytes(MAC).expect("key");
        assert_eq!(hex(&bytes), key);
        assert_eq!(devices.key_bytes("other"), None);
    }

    #[test]
    fn the_daemon_id_is_made_once() {
        let mut devices = PairedDevices::default();
        let (first, fresh) = devices.ensure_daemon_id();
        assert!(fresh);
        assert_eq!(first.len(), 32);
        let (second, fresh) = devices.ensure_daemon_id();
        assert!(!fresh);
        assert_eq!(first, second);
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
