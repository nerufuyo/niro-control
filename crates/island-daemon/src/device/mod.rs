// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 zickrian

//! Niro Devices: assistants with a screen, a microphone and a speaker that pair with this user's Niro.
//! See `docs/device-protocol.md`. This is the first piece: the messages, the pairing code's life and the
//! list of paired devices. The pairing key exchange (PAKE), the socket and the D-Bus interface come next,
//! so nothing here is wired into the daemon yet.

// Not wired into the daemon yet (see above); each part is tested on its own.
#![allow(dead_code, unused_imports)]

mod pair;
mod paired;
mod proto;
mod srp;

pub use self::pair::{Pairing, Refused};
pub use self::paired::{Paired, PairedDevices};
pub use self::proto::{FromDevice, ToDevice};
