// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 zickrian

//! Niro Devices: assistants with a screen, a microphone and a speaker that pair with this user's Niro.
//! See `docs/device-protocol.md`. Here are the messages, the pairing code's life, the list of paired
//! devices, the SRP side of pairing and the `Devices1` D-Bus service that holds them. The socket the
//! devices connect to comes next; until then no device can reach the daemon.

// The messages and the SRP client wait for the socket that will use them.
#![allow(dead_code, unused_imports)]

mod avahi;
mod enroll;
mod link;
mod pair;
mod paired;
mod proto;
mod server;
mod service;
mod srp;

pub use self::pair::{Pairing, Refused};
pub use self::paired::{Paired, PairedDevices};
pub use self::proto::{FromDevice, ToDevice};
pub use self::service::{DeviceService, run};
pub use self::server::run as listen;
