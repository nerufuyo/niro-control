// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 zickrian

//! What the daemon already knows (an AI that needs the user, a low battery) on its way to the Niro Devices.
//! Other modules call [`push`] and forget it; [`run`] hands each message to every connected device.
//! With no device paired nothing is kept and nothing is sent.

use std::sync::OnceLock;
use std::time::{SystemTime, UNIX_EPOCH};

use tokio::sync::mpsc::{UnboundedReceiver, UnboundedSender, unbounded_channel};
use zbus::object_server::InterfaceRef;

use super::proto::{Kind, ToDevice};
use super::service::DeviceService;
use crate::agents::Event;
use crate::system::SystemEvent;

static FEED: OnceLock<UnboundedSender<ToDevice>> = OnceLock::new();

/// How long a notification stays on the device's screen.
const SHOWN_MS: u64 = 30_000;

/// Sends `message` to every connected device; does nothing before [`run`] has started.
pub fn push(message: ToDevice) {
    if let Some(feed) = FEED.get() {
        let _ = feed.send(message);
    }
}

/// An AI's report, shown on the device; `None` for what the user need not see there.
pub fn from_agent(event: &Event) -> Option<ToDevice> {
    let who = match event.provider.as_str() {
        "claude" => "Claude Code",
        "codex" => "Codex",
        "opencode" => "OpenCode",
        "grok" => "Grok",
        other => other,
    };
    let title = if event.project.is_empty() {
        who.to_owned()
    } else {
        format!("{who} · {}", event.project)
    };
    let (body, urgent) = match event.kind.as_str() {
        "permission" => ("Needs your permission", true),
        "waiting" => ("Is waiting for you", true),
        "done" => ("Finished", false),
        _ => return None,
    };
    let body = if event.message.is_empty() || event.kind == "done" {
        body.to_owned()
    } else {
        event.message.clone()
    };
    Some(notice(Kind::Agent, title, body, urgent))
}

/// A change of the PC's battery, shown on the device; `None` for the rest.
pub fn from_system(event: &SystemEvent) -> Option<ToDevice> {
    match event {
        SystemEvent::BatteryLow { percent } => Some(notice(
            Kind::Battery,
            "PC battery low".into(),
            format!("{}% left", percent.round()),
            true,
        )),
        SystemEvent::BatteryFull => Some(notice(Kind::Battery, "PC battery full".into(), "Unplug the charger".into(), false)),
        _ => None,
    }
}

fn notice(kind: Kind, title: String, body: String, urgent: bool) -> ToDevice {
    ToDevice::Notify {
        id: SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_millis() as u64),
        kind,
        title: title.chars().take(80).collect(),
        body: body.chars().take(240).collect(),
        urgent,
        expire_ms: SHOWN_MS,
    }
}

/// Starts the feed and serves it until the daemon ends.
pub async fn run(devices: InterfaceRef<DeviceService>) {
    let (send, mut messages): (_, UnboundedReceiver<ToDevice>) = unbounded_channel();
    if FEED.set(send).is_err() {
        return;
    }
    while let Some(message) = messages.recv().await {
        devices.get().await.broadcast(&message);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn event(kind: &str, message: &str) -> Event {
        Event {
            provider: "claude".into(),
            kind: kind.into(),
            project: "niro".into(),
            message: message.into(),
            ..Event::default()
        }
    }

    #[test]
    fn an_ai_that_needs_the_user_is_urgent_and_one_that_finished_is_not() {
        let ToDevice::Notify { title, urgent, kind, .. } = from_agent(&event("permission", "Run rm?")).unwrap() else { panic!() };
        assert_eq!((title.as_str(), urgent, kind), ("Claude Code · niro", true, Kind::Agent));
        let ToDevice::Notify { urgent, body, .. } = from_agent(&event("done", "")).unwrap() else { panic!() };
        assert!(!urgent);
        assert_eq!(body, "Finished");
    }

    #[test]
    fn the_ai_own_words_are_shown_when_it_has_some() {
        let ToDevice::Notify { body, .. } = from_agent(&event("waiting", "Which branch?")).unwrap() else { panic!() };
        assert_eq!(body, "Which branch?");
        assert!(from_agent(&event("nonsense", "")).is_none());
    }

    #[test]
    fn only_the_battery_reaches_the_device_from_the_system() {
        let ToDevice::Notify { body, urgent, .. } = from_system(&SystemEvent::BatteryLow { percent: 14.6 }).unwrap() else { panic!() };
        assert_eq!((body.as_str(), urgent), ("15% left", true));
        assert!(from_system(&SystemEvent::BatteryFull).is_some());
        assert!(from_system(&SystemEvent::Power { plugged: true, percent: 50.0 }).is_none());
    }

    #[test]
    fn pushing_before_the_feed_runs_is_harmless() {
        push(ToDevice::Pong);
    }
}
