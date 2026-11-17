// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 zickrian

//! Announces the daemon on the local network as `_niro-device._tcp`, through Avahi on the system bus, so a
//! device finds it without being told an address. The record says who this daemon is (`id`) and whether a
//! pairing code is open (`pair`); it carries no secret. Without Avahi nothing is announced and the
//! daemon says so; devices then cannot find it by name.

use zbus::Connection;
use zbus::zvariant::OwnedObjectPath;

const DEST: &str = "org.freedesktop.Avahi";
const SERVER: &str = "org.freedesktop.Avahi.Server";
const GROUP: &str = "org.freedesktop.Avahi.EntryGroup";
const SERVICE: &str = "_niro-device._tcp";
/// AVAHI_IF_UNSPEC and AVAHI_PROTO_UNSPEC: every interface, both IP versions.
const UNSPEC: i32 = -1;

/// The announcement, while it lasts.
pub struct Publication {
    bus: Connection,
    group: OwnedObjectPath,
    name: String,
    id: String,
}

/// The TXT record: `id=<daemon id>`, `v=1`, `pair=0|1`.
fn txt(id: &str, pair: bool) -> Vec<Vec<u8>> {
    vec![
        format!("id={id}").into_bytes(),
        b"v=1".to_vec(),
        format!("pair={}", u8::from(pair)).into_bytes(),
    ]
}

/// The service name people may see in a network browser.
fn service_name(id: &str) -> String {
    format!("Niro {}", id.get(..8).unwrap_or(id))
}

impl Publication {
    /// Announces the daemon at `port`.
    pub async fn publish(port: u16, id: &str, pair: bool) -> zbus::Result<Self> {
        let bus = Connection::system().await?;
        let reply = bus
            .call_method(Some(DEST), "/", Some(SERVER), "EntryGroupNew", &())
            .await?;
        let group: OwnedObjectPath = reply.body().deserialize()?;
        let name = service_name(id);
        bus.call_method(
            Some(DEST),
            group.as_str(),
            Some(GROUP),
            "AddService",
            &(
                UNSPEC,
                UNSPEC,
                0u32,
                name.as_str(),
                SERVICE,
                "",
                "",
                port,
                txt(id, pair),
            ),
        )
        .await?;
        bus.call_method(Some(DEST), group.as_str(), Some(GROUP), "Commit", &())
            .await?;
        Ok(Self {
            bus,
            group,
            name,
            id: id.to_owned(),
        })
    }

    /// Says whether a pairing code is open.
    pub async fn set_pair(&self, pair: bool) -> zbus::Result<()> {
        self.bus
            .call_method(
                Some(DEST),
                self.group.as_str(),
                Some(GROUP),
                "UpdateServiceTxt",
                &(
                    UNSPEC,
                    UNSPEC,
                    0u32,
                    self.name.as_str(),
                    SERVICE,
                    "",
                    txt(&self.id, pair),
                ),
            )
            .await?;
        Ok(())
    }

    /// Takes the announcement down.
    pub async fn withdraw(self) {
        let _ = self
            .bus
            .call_method(Some(DEST), self.group.as_str(), Some(GROUP), "Free", &())
            .await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_record_says_who_and_whether_a_code_is_open() {
        let record = txt("00112233445566778899aabbccddeeff", true);
        assert_eq!(record[0], b"id=00112233445566778899aabbccddeeff");
        assert_eq!(record[1], b"v=1");
        assert_eq!(record[2], b"pair=1");
        assert_eq!(txt("x", false)[2], b"pair=0");
    }

    #[test]
    fn the_name_is_short() {
        assert_eq!(service_name("00112233445566778899aabbccddeeff"), "Niro 00112233");
        assert_eq!(service_name("ab"), "Niro ab");
    }

    /// Needs Avahi on the system bus: `cargo test -- --ignored avahi`.
    #[tokio::test]
    #[ignore = "needs avahi-daemon"]
    async fn avahi_takes_an_announcement_and_updates_it() {
        let publication = Publication::publish(45678, "00112233445566778899aabbccddeeff", false)
            .await
            .expect("announced");
        publication.set_pair(true).await.expect("updated");
        publication.withdraw().await;
    }
}
