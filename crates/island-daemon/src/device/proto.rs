// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 zickrian

//! The control messages between a device and the daemon: JSON text frames with the type in `t`. Audio
//! travels as binary frames and is not described here. See `docs/device-protocol.md`.

use serde::{Deserialize, Serialize};

/// A button on the device.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Action {
    Press,
    Long,
    Release,
}

/// What a notification is about.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    Agent,
    Reminder,
    Meeting,
    Battery,
    System,
}

/// The face on the screen.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Face {
    Idle,
    Listening,
    Thinking,
    Speaking,
    Happy,
    Alert,
}

/// Sent by the device.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "t")]
pub enum FromDevice {
    #[serde(rename = "listen.start")]
    ListenStart { lang: String, rate: u32 },
    #[serde(rename = "listen.stop")]
    ListenStop,
    #[serde(rename = "button")]
    Button { id: u8, action: Action },
    #[serde(rename = "status")]
    Status {
        battery: u8,
        charging: bool,
        temp_c: f32,
        rssi: i8,
        fw: String,
    },
    #[serde(rename = "ack")]
    Ack { id: u64 },
    #[serde(rename = "ping")]
    Ping,
}

/// Sent by the daemon.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "t")]
pub enum ToDevice {
    #[serde(rename = "stt")]
    Stt { text: String, r#final: bool },
    #[serde(rename = "answer")]
    Answer {
        id: u64,
        text: String,
        done: bool,
        audio: bool,
    },
    #[serde(rename = "notify")]
    Notify {
        id: u64,
        kind: Kind,
        title: String,
        body: String,
        urgent: bool,
        expire_ms: u64,
    },
    #[serde(rename = "face")]
    Face { name: Face },
    #[serde(rename = "config")]
    Config {
        volume: u8,
        brightness: u8,
        language: String,
    },
    #[serde(rename = "pong")]
    Pong,
    #[serde(rename = "bye")]
    Bye { reason: String },
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn the_type_sits_in_t() {
        let message = FromDevice::Button {
            id: 1,
            action: Action::Long,
        };
        assert_eq!(
            serde_json::to_value(&message).unwrap(),
            json!({"t": "button", "id": 1, "action": "long"})
        );
        assert_eq!(
            serde_json::to_value(FromDevice::ListenStop).unwrap(),
            json!({"t": "listen.stop"})
        );
    }

    #[test]
    fn a_device_message_parses() {
        let text = r#"{"t":"status","battery":78,"charging":false,"temp_c":59.3,"rssi":-61,"fw":"0.1.0"}"#;
        let FromDevice::Status { battery, rssi, .. } = serde_json::from_str(text).unwrap() else {
            panic!("not a status");
        };
        assert_eq!((battery, rssi), (78, -61));
    }

    #[test]
    fn a_notification_round_trips() {
        let message = ToDevice::Notify {
            id: 9,
            kind: Kind::Agent,
            title: "Claude Code".into(),
            body: "Needs you".into(),
            urgent: true,
            expire_ms: 30_000,
        };
        let back: ToDevice =
            serde_json::from_str(&serde_json::to_string(&message).unwrap()).unwrap();
        assert_eq!(back, message);
    }

    #[test]
    fn the_final_flag_keeps_its_name() {
        let message = ToDevice::Stt {
            text: "hello".into(),
            r#final: true,
        };
        assert_eq!(
            serde_json::to_value(&message).unwrap(),
            json!({"t": "stt", "text": "hello", "final": true})
        );
    }

    #[test]
    fn unknown_types_and_directions_are_refused() {
        assert!(serde_json::from_str::<FromDevice>(r#"{"t":"nope"}"#).is_err());
        // A device cannot send what only the daemon sends.
        assert!(serde_json::from_str::<FromDevice>(r#"{"t":"pong"}"#).is_err());
        assert!(serde_json::from_str::<FromDevice>(r#"{"t":"button","id":300,"action":"press"}"#).is_err());
    }
}
