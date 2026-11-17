// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 zickrian

//! `org.niro.island.Devices1`: the paired devices and the pairing code, for the island and the panel. The
//! methods answer GNOME Shell only. The code is returned by `StartPairing` and is not a property, which any
//! program on the bus could read; the properties hold what is safe to show, and never a key.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Instant;

use log::warn;
use serde_json::{Value, json};
use tokio::sync::{Notify, mpsc, oneshot};
use zbus::message::Header;
use zbus::object_server::{InterfaceRef, SignalEmitter};
use zbus::{Connection, fdo, interface};

use super::enroll::Offer;
use super::pair::{LIFETIME, Pairing};
use super::paired::PairedDevices;
use super::proto::{FromDevice, Kind, ToDevice};
use crate::clock::{now_ms, wait_until};
use crate::store::Store;

/// The longest a device name or id may be.
const MAX_TEXT: usize = 64;

/// The pairing code that is open, and when it ends by the wall clock.
pub(super) struct Active {
    pub(super) pairing: Pairing,
    pub(super) expires_ms: i64,
}

/// A device that asked to pair and waits for the user's answer.
pub(super) struct Pending {
    pub(super) offer: Offer,
    answer: oneshot::Sender<bool>,
}

/// A live connection's way to be sent a message.
struct Live {
    id: u64,
    device_id: String,
    outbox: mpsc::UnboundedSender<ToDevice>,
}

/// The paired devices and the pairing in progress.
pub struct DeviceService {
    pub(super) devices: PairedDevices,
    store: Store<PairedDevices>,
    pub(super) pairing: Option<Active>,
    pub(super) request: Option<Pending>,
    connections: Vec<Live>,
    status: HashMap<String, Value>,
    next_connection: u64,
    /// The port the socket listens on, while it does.
    pub(super) port: Option<u16>,
    /// Wakes the loop that closes an ended code.
    pub(super) wake: Arc<Notify>,
    /// Wakes the loop that listens for devices, when what it wants changes.
    pub(super) hub: Arc<Notify>,
}

impl DeviceService {
    /// Loads the paired devices saved last time.
    pub fn load() -> Self {
        Self::with_store(Store::new("devices"))
    }

    pub(super) fn with_store(mut store: Store<PairedDevices>) -> Self {
        let devices = store.load();
        Self {
            devices,
            store,
            pairing: None,
            request: None,
            connections: Vec::new(),
            status: HashMap::new(),
            next_connection: 0,
            port: None,
            wake: Arc::default(),
            hub: Arc::default(),
        }
    }

    /// Tells both loops that something they watch changed.
    fn poke(&self) {
        self.wake.notify_one();
        self.hub.notify_one();
    }

    /// Opens a new pairing code, replacing one that was open, and returns it.
    pub(super) fn open_pairing(&mut self) -> String {
        let pairing = Pairing::start(Instant::now());
        let code = pairing.code().to_owned();
        self.pairing = Some(Active {
            pairing,
            expires_ms: now_ms() + LIFETIME.as_millis() as i64,
        });
        self.poke();
        code
    }

    /// Closes the pairing code; true when one was open.
    fn close_pairing(&mut self) -> bool {
        let was = self.pairing.take().is_some();
        self.poke();
        was
    }

    /// Whether a code is open and still takes tries.
    pub(super) fn pairing_open(&self) -> bool {
        self.pairing
            .as_ref()
            .is_some_and(|active| active.pairing.open(Instant::now()) && now_ms() < active.expires_ms)
    }

    /// Drops a code that ended (time, tries or use); true when there was one to drop.
    pub(super) fn expire(&mut self) -> bool {
        let ended = self.pairing.as_ref().is_some_and(|active| {
            now_ms() >= active.expires_ms || !active.pairing.open(Instant::now())
        });
        if ended {
            self.pairing = None;
            self.poke();
        }
        ended
    }

    /// A device whose key exchange succeeded and that the user allowed: pairs it with a new key. The
    /// code is spent. None when no code is open or the device's id or name is not acceptable.
    pub(crate) fn complete_pairing(&mut self, device_id: &str, name: &str) -> Option<String> {
        if !self.pairing_open() {
            return None;
        }
        let device_id = text(device_id)?;
        let name = text(name)?;
        let key = self.devices.add(&device_id, &name, now_ms());
        self.store.save(&self.devices);
        if let Some(active) = self.pairing.as_mut() {
            active.pairing.spend();
        }
        self.poke();
        Some(key)
    }

    /// Whether the daemon should be listening: a device is paired, or a code is open.
    pub(super) fn listening_wanted(&self) -> bool {
        !self.devices.devices.is_empty() || self.pairing_open()
    }

    /// A device tries the code: counts the try and gives the code for the key exchange. None when no code
    /// is open or its tries are used.
    pub(super) fn try_code(&mut self) -> Option<String> {
        let active = self.pairing.as_mut()?;
        let code = active.pairing.attempt(Instant::now()).ok()?.to_owned();
        Some(code)
    }

    /// This daemon's id, made on first use.
    pub(super) fn daemon_id(&mut self) -> String {
        let (id, fresh) = self.devices.ensure_daemon_id();
        if fresh {
            self.store.save(&self.devices);
        }
        id
    }

    /// A device asks to pair: the user is asked. None when another device already waits.
    pub(super) fn begin_request(&mut self, offer: Offer) -> Option<oneshot::Receiver<bool>> {
        if self.request.is_some() {
            return None;
        }
        let (answer, receiver) = oneshot::channel();
        self.request = Some(Pending { offer, answer });
        Some(receiver)
    }

    /// The question is over, answered or not.
    pub(super) fn end_request(&mut self) {
        self.request = None;
    }

    /// The user's answer to the device that waits; false when none waits.
    pub(super) fn answer_request(&mut self, allow: bool) -> bool {
        match self.request.take() {
            Some(pending) => {
                let _ = pending.answer.send(allow);
                true
            }
            None => false,
        }
    }

    /// A device connected: it can now be sent messages. Returns the connection's number.
    pub(super) fn connected(
        &mut self,
        device_id: &str,
        outbox: mpsc::UnboundedSender<ToDevice>,
    ) -> u64 {
        self.next_connection += 1;
        let id = self.next_connection;
        self.connections.push(Live {
            id,
            device_id: device_id.to_owned(),
            outbox,
        });
        id
    }

    /// A connection ended; the device is offline when it was its last.
    pub(super) fn disconnected(&mut self, connection: u64) {
        self.connections.retain(|c| c.id != connection);
    }

    /// What a device last said about itself.
    pub(super) fn record_status(&mut self, device_id: &str, status: &FromDevice) {
        if let FromDevice::Status {
            battery,
            charging,
            temp_c,
            rssi,
            fw,
        } = status
        {
            self.status.insert(
                device_id.to_owned(),
                json!({"battery": battery, "charging": charging, "temp_c": temp_c, "rssi": rssi, "fw": fw}),
            );
        }
    }

    fn online(&self, device_id: &str) -> bool {
        self.connections.iter().any(|c| c.device_id == device_id)
    }

    /// Sends a message to every device that is connected; returns how many it was queued for.
    pub(super) fn broadcast(&self, message: &ToDevice) -> usize {
        self.connections
            .iter()
            .filter(|c| c.outbox.send(message.clone()).is_ok())
            .count()
    }

    /// The device's key stops working and its connections are told to end.
    fn drop_connections(&mut self, device_id: &str) {
        for connection in self.connections.iter().filter(|c| c.device_id == device_id) {
            let _ = connection.outbox.send(ToDevice::Bye {
                reason: "forgotten".into(),
            });
        }
        self.status.remove(device_id);
    }

    /// Who waits for the user's answer, for the island.
    pub(super) fn request_json(&self) -> String {
        match &self.request {
            Some(pending) => json!({
                "pending": true,
                "device_id": pending.offer.device_id,
                "name": pending.offer.name,
            }),
            None => json!({"pending": false}),
        }
        .to_string()
    }

    /// How many tries the open code has had.
    #[cfg(test)]
    pub(super) fn pairing_tries(&self) -> u8 {
        self.pairing.as_ref().map_or(0, |active| active.pairing.tries())
    }

    /// What `Forget` does, without the bus.
    #[cfg(test)]
    pub(super) fn forget_for_test(&mut self, device_id: &str) {
        assert!(self.devices.forget(device_id));
        self.drop_connections(device_id);
        self.poke();
    }

    /// The devices, without their keys.
    pub(super) fn devices_json(&self) -> String {
        let list: Vec<_> = self
            .devices
            .devices
            .iter()
            .map(|device| {
                json!({
                    "device_id": device.device_id,
                    "name": device.name,
                    "paired_at_ms": device.paired_at_ms,
                    "online": self.online(&device.device_id),
                    "status": self.status.get(&device.device_id),
                })
            })
            .collect();
        serde_json::to_string(&list).unwrap_or_default()
    }

    /// Whether a code is open, and until when. Never the code.
    fn pairing_json(&self) -> String {
        match self.pairing.as_ref().filter(|_| self.pairing_open()) {
            Some(active) => json!({"active": true, "expires_at_ms": active.expires_ms}),
            None => json!({"active": false, "expires_at_ms": 0}),
        }
        .to_string()
    }
}

/// A trimmed id or name: not empty, not long, no control characters.
pub(super) fn text(value: &str) -> Option<String> {
    let value = value.trim();
    let fine = !value.is_empty()
        && value.chars().count() <= MAX_TEXT
        && !value.chars().any(char::is_control);
    fine.then(|| value.to_owned())
}

#[interface(name = "org.niro.island.Devices1")]
impl DeviceService {
    /// Opens a pairing code (6 digits, two minutes, five tries) and returns it for the island to show.
    /// GNOME Shell only.
    async fn start_pairing(
        &mut self,
        #[zbus(header)] header: Header<'_>,
        #[zbus(connection)] connection: &Connection,
        #[zbus(signal_emitter)] emitter: SignalEmitter<'_>,
    ) -> fdo::Result<String> {
        crate::caller::shell_only(connection, &header).await?;
        let code = self.open_pairing();
        self.pairing_changed(&emitter).await?;
        Ok(code)
    }

    /// Closes the pairing code. GNOME Shell only.
    async fn cancel_pairing(
        &mut self,
        #[zbus(header)] header: Header<'_>,
        #[zbus(connection)] connection: &Connection,
        #[zbus(signal_emitter)] emitter: SignalEmitter<'_>,
    ) -> fdo::Result<()> {
        crate::caller::shell_only(connection, &header).await?;
        if self.close_pairing() {
            self.pairing_changed(&emitter).await?;
        }
        Ok(())
    }

    /// Renames a paired device. GNOME Shell only.
    async fn rename(
        &mut self,
        device_id: &str,
        name: &str,
        #[zbus(header)] header: Header<'_>,
        #[zbus(connection)] connection: &Connection,
        #[zbus(signal_emitter)] emitter: SignalEmitter<'_>,
    ) -> fdo::Result<()> {
        crate::caller::shell_only(connection, &header).await?;
        let name = text(name)
            .ok_or_else(|| fdo::Error::InvalidArgs("a device name is 1 to 64 characters".into()))?;
        if !self.devices.rename(device_id, &name) {
            return Err(fdo::Error::InvalidArgs(format!(
                "no device `{device_id}` is paired"
            )));
        }
        self.store.save(&self.devices);
        Ok(self.devices_changed(&emitter).await?)
    }

    /// Forgets a paired device: its key stops working. GNOME Shell only.
    async fn forget(
        &mut self,
        device_id: &str,
        #[zbus(header)] header: Header<'_>,
        #[zbus(connection)] connection: &Connection,
        #[zbus(signal_emitter)] emitter: SignalEmitter<'_>,
    ) -> fdo::Result<()> {
        crate::caller::shell_only(connection, &header).await?;
        if !self.devices.forget(device_id) {
            return Err(fdo::Error::InvalidArgs(format!(
                "no device `{device_id}` is paired"
            )));
        }
        self.drop_connections(device_id);
        self.store.save(&self.devices);
        self.poke();
        Ok(self.devices_changed(&emitter).await?)
    }

    /// The user's answer to a device that asks to pair. GNOME Shell only.
    async fn answer(
        &mut self,
        allow: bool,
        #[zbus(header)] header: Header<'_>,
        #[zbus(connection)] connection: &Connection,
        #[zbus(signal_emitter)] emitter: SignalEmitter<'_>,
    ) -> fdo::Result<()> {
        crate::caller::shell_only(connection, &header).await?;
        if !self.answer_request(allow) {
            return Err(fdo::Error::InvalidArgs("no device waits to pair".into()));
        }
        Ok(self.request_changed(&emitter).await?)
    }

    /// Shows a notification on every connected device; returns how many it reached. `kind` is one of
    /// `agent`, `reminder`, `meeting`, `battery`, `system`. GNOME Shell only.
    async fn notify(
        &self,
        kind: &str,
        title: &str,
        body: &str,
        urgent: bool,
        #[zbus(header)] header: Header<'_>,
        #[zbus(connection)] connection: &Connection,
    ) -> fdo::Result<u32> {
        crate::caller::shell_only(connection, &header).await?;
        let kind = serde_json::from_value::<Kind>(Value::String(kind.to_owned()))
            .map_err(|_| fdo::Error::InvalidArgs(format!("unknown kind `{kind}`")))?;
        let message = ToDevice::Notify {
            id: now_ms() as u64,
            kind,
            title: title.chars().take(80).collect(),
            body: body.chars().take(240).collect(),
            urgent,
            expire_ms: 30_000,
        };
        Ok(self.broadcast(&message) as u32)
    }

    /// JSON `{pending, device_id?, name?}`: a device that asks to pair and waits for `Answer`.
    #[zbus(property)]
    fn request(&self) -> String {
        self.request_json()
    }

    /// JSON array of `{device_id, name, paired_at_ms, online, status}`; never a key.
    #[zbus(property)]
    fn devices(&self) -> String {
        self.devices_json()
    }

    /// JSON `{active, expires_at_ms}`: whether a pairing code is open. Never the code.
    #[zbus(property)]
    fn pairing(&self) -> String {
        self.pairing_json()
    }
}

/// Closes the pairing code when its time is up, and tells the island.
pub async fn run(iface: InterfaceRef<DeviceService>) {
    let wake = iface.get().await.wake.clone();
    loop {
        let deadline = iface
            .get()
            .await
            .pairing
            .as_ref()
            .map(|active| active.expires_ms);
        if !wait_until(deadline, &wake).await {
            continue;
        }
        let mut service = iface.get_mut().await;
        if service.expire() {
            if let Err(err) = service.pairing_changed(iface.signal_emitter()).await {
                warn!("could not tell that the pairing code ended: {err}");
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use super::*;

    const MAC: &str = "10:b4:1d:e9:9d:34";

    fn service(name: &str) -> (DeviceService, PathBuf) {
        let dir = std::env::temp_dir().join(format!("niro-devices-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("devices.json");
        (DeviceService::with_store(Store::at(path)), dir)
    }

    #[test]
    fn nothing_pairs_without_an_open_code() {
        let (mut service, dir) = service("closed");
        assert_eq!(service.complete_pairing(MAC, "Desk"), None);
        assert!(service.devices.devices.is_empty());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn a_code_pairs_one_device_and_is_spent() {
        let (mut service, dir) = service("spent");
        let code = service.open_pairing();
        assert_eq!(code.len(), 6);
        let key = service.complete_pairing(MAC, "Desk").expect("paired");
        assert!(service.devices.key_matches(MAC, &key));
        // The same code cannot pair a second device.
        assert_eq!(service.complete_pairing("aa:bb", "Other"), None);
        assert_eq!(service.devices.devices.len(), 1);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn a_new_code_replaces_the_old_one() {
        let (mut service, dir) = service("replace");
        let first = service.open_pairing();
        let second = service.open_pairing();
        assert_eq!(service.pairing.as_ref().unwrap().pairing.code(), second);
        assert!(service.pairing_open());
        let _ = first;
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn cancelling_closes_the_code() {
        let (mut service, dir) = service("cancel");
        service.open_pairing();
        assert!(service.close_pairing());
        assert!(!service.close_pairing());
        assert_eq!(service.complete_pairing(MAC, "Desk"), None);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn a_code_past_its_time_is_dropped() {
        let (mut service, dir) = service("late");
        service.open_pairing();
        service.pairing.as_mut().unwrap().expires_ms = now_ms() - 1;
        assert!(!service.pairing_open());
        assert_eq!(service.complete_pairing(MAC, "Desk"), None);
        assert!(service.expire());
        assert!(service.pairing.is_none());
        assert!(!service.expire());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn bad_ids_and_names_are_refused() {
        let (mut service, dir) = service("text");
        service.open_pairing();
        assert_eq!(service.complete_pairing("", "Desk"), None);
        assert_eq!(service.complete_pairing(MAC, "  "), None);
        assert_eq!(service.complete_pairing(MAC, "line\nbreak"), None);
        assert_eq!(service.complete_pairing(MAC, &"x".repeat(65)), None);
        // Refusing a device does not spend the code.
        assert!(service.complete_pairing(MAC, " Desk ").is_some());
        assert_eq!(service.devices.find(MAC).map(|d| d.name.as_str()), Some("Desk"));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn the_properties_never_show_the_code_or_a_key() {
        let (mut service, dir) = service("secret");
        let code = service.open_pairing();
        let key = service.complete_pairing(MAC, "Desk").unwrap();
        service.open_pairing();
        let code2 = service.pairing.as_ref().unwrap().pairing.code().to_owned();
        let shown = format!("{}{}", service.pairing_json(), service.devices_json());
        for secret in [&code, &code2, &key] {
            assert!(!shown.contains(secret.as_str()), "{shown}");
        }
        assert!(service.pairing_json().contains("\"active\":true"));
        assert!(service.devices_json().contains(MAC));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn devices_come_back_after_a_restart() {
        let (mut service, dir) = service("restart");
        service.open_pairing();
        let key = service.complete_pairing(MAC, "Desk").unwrap();
        service.store.save_now(&service.devices);
        let mut again = DeviceService::with_store(Store::at(dir.join("devices.json")));
        assert!(again.devices.key_matches(MAC, &key));
        assert!(again.pairing.is_none());
        let _ = again.close_pairing();
        let _ = std::fs::remove_dir_all(dir);
    }
}
