// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 zickrian

//! The socket devices connect to. The daemon listens only while it has something to offer: a device is
//! paired, or a pairing code is open. It then announces itself over mDNS. A connection must come from the
//! local network, has seconds to open, and an unknown device is closed without an answer. See
//! `docs/device-protocol.md`.

use std::future::pending;
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;

use log::{debug, info, warn};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{Semaphore, mpsc};
use tokio::time::{sleep, timeout};
use zbus::object_server::InterfaceRef;

use super::avahi::Publication;
use super::enroll::{Offer, enroll};
use super::link::{Error, Incoming, Link, Opening, accept_hello, open};
use super::proto::{FromDevice, ToDevice};
use super::service::{DeviceService, text};
use super::voice::{self, Busy, Heard};

/// How long a connection has to open and prove itself.
const HANDSHAKE: Duration = Duration::from_secs(10);
/// How long the user has to answer a device that asks to pair.
const ANSWER: Duration = Duration::from_secs(60);
/// A device pings every 15 seconds; this long without a word ends the connection.
const IDLE: Duration = Duration::from_secs(45);
/// How many connections may be open or opening at once.
const MAX_CONNECTIONS: usize = 16;
/// How often the loop looks again even when nothing woke it.
const RECHECK: Duration = Duration::from_secs(60);

/// The listening socket and its announcement.
struct Listening {
    listener: TcpListener,
    publication: Option<Publication>,
    pair_flag: bool,
}

/// Listens while there is something to offer, and serves what connects.
pub async fn run(iface: InterfaceRef<DeviceService>) {
    let hub = iface.get().await.hub.clone();
    let slots = Arc::new(Semaphore::new(MAX_CONNECTIONS));
    let mut listening: Option<Listening> = None;
    loop {
        let (wanted, pairing) = {
            let service = iface.get().await;
            (service.listening_wanted(), service.pairing_open())
        };
        match (wanted, listening.is_some()) {
            (true, false) => listening = start(&iface, pairing).await,
            (false, true) => {
                if let Some(stopped) = listening.take() {
                    stop(&iface, stopped).await;
                }
            }
            _ => {}
        }
        if let Some(open_now) = listening.as_mut() {
            if open_now.pair_flag != pairing {
                open_now.pair_flag = pairing;
                if let Some(publication) = &open_now.publication {
                    if let Err(err) = publication.set_pair(pairing).await {
                        warn!("could not update the mDNS record: {err}");
                    }
                }
            }
        }
        tokio::select! {
            () = hub.notified() => {}
            () = sleep(RECHECK) => {}
            accepted = async {
                match &listening {
                    Some(open_now) => open_now.listener.accept().await,
                    None => pending().await,
                }
            } => match accepted {
                Ok((stream, peer)) => meet(&iface, &slots, stream, peer),
                Err(err) => {
                    warn!("could not accept a device: {err}");
                    sleep(Duration::from_secs(1)).await;
                }
            },
        }
    }
}

/// Opens the socket and announces it.
async fn start(iface: &InterfaceRef<DeviceService>, pairing: bool) -> Option<Listening> {
    let listener = match TcpListener::bind(("0.0.0.0", 0)).await {
        Ok(listener) => listener,
        Err(err) => {
            warn!("devices cannot connect: no socket ({err})");
            return None;
        }
    };
    let port = listener.local_addr().ok()?.port();
    let id = {
        let mut service = iface.get_mut().await;
        service.port = Some(port);
        service.daemon_id()
    };
    let publication = match Publication::publish(port, &id, pairing).await {
        Ok(publication) => Some(publication),
        Err(err) => {
            warn!("devices cannot find this computer by name: mDNS is not available ({err})");
            None
        }
    };
    info!("listening for devices on port {port}");
    Some(Listening {
        listener,
        publication,
        pair_flag: pairing,
    })
}

async fn stop(iface: &InterfaceRef<DeviceService>, listening: Listening) {
    iface.get_mut().await.port = None;
    if let Some(publication) = listening.publication {
        publication.withdraw().await;
    }
    info!("no longer listening for devices");
}

/// Takes a new connection if it is from the local network and there is room.
fn meet(
    iface: &InterfaceRef<DeviceService>,
    slots: &Arc<Semaphore>,
    stream: TcpStream,
    peer: SocketAddr,
) {
    let local = crate::share::lan().is_some_and(|lan| lan.contains(peer.ip()));
    if !local {
        debug!("a device from outside the local network was refused: {peer}");
        return;
    }
    let Ok(slot) = slots.clone().try_acquire_owned() else {
        debug!("too many connections; {peer} was refused");
        return;
    };
    let iface = iface.clone();
    tokio::spawn(async move {
        let _slot = slot;
        if let Err(err) = serve(&iface, stream).await {
            debug!("{peer} ended: {err:?}");
        }
    });
}

/// One connection, from its first frame to its end.
async fn serve(iface: &InterfaceRef<DeviceService>, mut stream: TcpStream) -> Result<(), Error> {
    let opening = timeout(HANDSHAKE, open(&mut stream))
        .await
        .map_err(|_| Error::Protocol("slow"))??;
    match opening {
        Opening::Hello { device_id, nonce } => {
            let (key, daemon_id) = {
                let mut service = iface.get_mut().await;
                (service.devices.key_bytes(&device_id), service.daemon_id())
            };
            let link = timeout(
                HANDSHAKE,
                accept_hello(stream, &daemon_id, device_id, nonce, move |_| key),
            )
            .await
            .map_err(|_| Error::Protocol("slow"))??;
            session(iface, link).await;
            Ok(())
        }
        Opening::Pair(hello) => {
            let (code, daemon_id) = {
                let mut service = iface.get_mut().await;
                (service.try_code(), service.daemon_id())
            };
            // A try is counted even when it fails, so the island learns the code ran out.
            iface.get().await.hub.notify_one();
            changed(iface).await;
            let Some(code) = code else {
                return Err(Error::Unknown);
            };
            let handle = iface.clone();
            let result = timeout(
                HANDSHAKE + ANSWER,
                enroll(stream, hello, &code, &daemon_id, move |offer| {
                    approve(handle, offer)
                }),
            )
            .await
            .map_err(|_| Error::Protocol("slow"))?;
            changed(iface).await;
            result
        }
    }
}

/// Tells the island that the code, the request or the devices changed.
async fn changed(iface: &InterfaceRef<DeviceService>) {
    let service = iface.get().await;
    let emitter = iface.signal_emitter();
    let _ = service.pairing_changed(emitter).await;
    let _ = service.devices_changed(emitter).await;
    let _ = service.request_changed(emitter).await;
}

/// Asks the user whether to allow `offer`, and pairs it when they do. The device key comes back.
async fn approve(iface: InterfaceRef<DeviceService>, offer: Offer) -> Option<[u8; 32]> {
    // What the island shows is what was checked: an id or name that is not acceptable never reaches it.
    let offer = Offer {
        device_id: text(&offer.device_id)?,
        name: text(&offer.name)?,
    };
    let answer = {
        let mut service = iface.get_mut().await;
        let answer = service.begin_request(offer.clone())?;
        let _ = service.request_changed(iface.signal_emitter()).await;
        answer
    };
    let allowed = matches!(timeout(ANSWER, answer).await, Ok(Ok(true)));
    let mut service = iface.get_mut().await;
    service.end_request();
    let key = if allowed {
        service
            .complete_pairing(&offer.device_id, &offer.name)
            .and_then(|_| service.devices.key_bytes(&offer.device_id))
    } else {
        None
    };
    let _ = service.request_changed(iface.signal_emitter()).await;
    let _ = service.devices_changed(iface.signal_emitter()).await;
    let _ = service.pairing_changed(iface.signal_emitter()).await;
    key
}

/// A paired device is connected: answer its pings, keep what it says of itself, and send it what
/// the daemon wants it to show, until it goes quiet or is forgotten.
async fn session(iface: &InterfaceRef<DeviceService>, link: Link<TcpStream>) {
    let (device_id, mut reader, mut writer) = link.split();
    let (outbox, mut outgoing) = mpsc::unbounded_channel::<ToDevice>();
    let reply_to = outbox.clone();
    let connection = iface.get_mut().await.connected(&device_id, outbox);
    if let Some(config) = iface.get().await.config_for(&device_id) {
        let _ = reply_to.send(config);
    }
    if iface.get().await.quiet() {
        let _ = reply_to.send(ToDevice::Face { name: super::proto::Face::Sleepy });
    }
    let mut heard: Option<Heard> = None;
    let busy = Busy::default();
    changed(iface).await;
    info!("{device_id} connected");

    let (incoming_tx, mut incoming) = mpsc::channel::<Incoming>(32);
    let reading = tokio::spawn(async move {
        while let Ok(message) = reader.receive().await {
            if incoming_tx.send(message).await.is_err() {
                break;
            }
        }
    });
    let idle = sleep(IDLE);
    tokio::pin!(idle);
    loop {
        tokio::select! {
            message = incoming.recv() => {
                let Some(message) = message else { break };
                idle.as_mut().reset(tokio::time::Instant::now() + IDLE);
                match message {
                    Incoming::Control(FromDevice::Ping) => {
                        if writer.send(&ToDevice::Pong).await.is_err() {
                            break;
                        }
                    }
                    Incoming::Control(status @ FromDevice::Status { .. }) => {
                        iface.get_mut().await.record_status(&device_id, &status);
                        let service = iface.get().await;
                        let _ = service.devices_changed(iface.signal_emitter()).await;
                    }
                    Incoming::Control(FromDevice::ListenStart { lang, codec, rate }) => {
                        let lang = if lang.is_empty() { iface.get().await.language_for(&device_id) } else { lang };
                        heard = Heard::begin(&lang, &codec, rate);
                    }
                    Incoming::Audio(frame) => {
                        if let Some(heard) = heard.as_mut() {
                            heard.push(&frame);
                        }
                    }
                    Incoming::Control(FromDevice::ListenStop) => {
                        if let Some(heard) = heard.take() {
                            voice::answer(heard, &busy, reply_to.clone(), voice::assistant());
                        }
                    }
                    Incoming::Control(FromDevice::Button { id, action }) => {
                        let action = serde_json::to_value(action).ok().and_then(|v| v.as_str().map(str::to_owned)).unwrap_or_default();
                        let _ = DeviceService::button(iface.signal_emitter(), &device_id, u32::from(id), &action).await;
                    }
                    // Acknowledgements are not used yet.
                    _ => {}
                }
            }
            message = outgoing.recv() => {
                let Some(message) = message else { break };
                let last = matches!(message, ToDevice::Bye { .. });
                let sent = match &message {
                    ToDevice::Audio(frame) => writer.send_audio(frame).await,
                    other => writer.send(other).await,
                };
                if sent.is_err() || last {
                    break;
                }
            }
            () = &mut idle => break,
        }
    }
    reading.abort();
    iface.get_mut().await.disconnected(connection);
    changed(iface).await;
    info!("{device_id} disconnected");
}

#[cfg(test)]
mod tests {
    //! The whole path on a real socket and a real session bus: pair, come back, talk, be sent a notification,
    //! be forgotten. Needs a session bus: `dbus-run-session -- cargo test -p island-daemon -- --ignored device_e2e`.

    use tokio::net::TcpStream;

    use super::super::enroll::pair_as_device;
    use super::super::link::connect;
    use super::*;
    use crate::store::Store;

    const PATH: &str = "/org/niro/island/DevicesTest";
    const MAC: &str = "10:b4:1d:e9:9d:34";

    #[tokio::test]
    #[ignore = "needs a session bus"]
    async fn device_e2e() {
        let dir = std::env::temp_dir().join(format!("niro-devices-e2e-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let service = DeviceService::with_store(Store::at(dir.join("devices.json")));
        let bus = zbus::connection::Builder::session()
            .unwrap()
            .serve_at(PATH, service)
            .unwrap()
            .build()
            .await
            .unwrap();
        let iface = bus
            .object_server()
            .interface::<_, DeviceService>(PATH)
            .await
            .unwrap();
        tokio::spawn(super::super::service::run(iface.clone()));
        tokio::spawn(run(iface.clone()));

        // A code is opened (the island's StartPairing) and the socket comes up.
        let code = iface.get_mut().await.open_pairing();
        let port = loop {
            if let Some(port) = iface.get().await.port {
                break port;
            }
            sleep(Duration::from_millis(50)).await;
        };
        // The daemon takes only the local network, and loopback is not on it; this computer's own address is.
        let own = crate::share::lan().expect("a network").ip;
        let address = (own.to_string(), port);

        // A wrong code is refused, and the user is never asked.
        let stream = TcpStream::connect(address.clone()).await.unwrap();
        assert!(matches!(
            pair_as_device(stream, "000000", MAC, "Desk").await,
            Err(Error::Auth) | Err(Error::Io(_))
        ));
        // It was served, not dropped at the door: the try was counted.
        assert_eq!(iface.get().await.pairing_tries(), 1);
        assert!(iface.get().await.request.is_none());

        // The right code: the user is asked and allows.
        let stream = TcpStream::connect(address.clone()).await.unwrap();
        let pairing = tokio::spawn(async move { pair_as_device(stream, &code, MAC, "Desk").await });
        let waiting = {
            let iface = iface.clone();
            loop {
                let pending = iface.get().await.request.as_ref().map(|p| p.offer.clone());
                if let Some(offer) = pending {
                    break offer;
                }
                sleep(Duration::from_millis(50)).await;
            }
        };
        assert_eq!((waiting.device_id.as_str(), waiting.name.as_str()), (MAC, "Desk"));
        assert!(iface.get_mut().await.answer_request(true));
        let (_daemon_id, key) = pairing.await.unwrap().expect("paired");
        assert!(iface.get().await.devices.key_matches_bytes(MAC, &key));

        // The code is spent: the same one pairs nothing else.
        assert!(!iface.get().await.pairing_open());

        // Back with the key: a paired device is let in, and talks.
        let stream = TcpStream::connect(address.clone()).await.unwrap();
        let mut device = connect(stream, MAC, &key).await.expect("connected");
        device
            .send(&FromDevice::Status {
                battery: 78,
                charging: false,
                temp_c: 41.5,
                rssi: -60,
                fw: "0.1.0".into(),
            })
            .await
            .unwrap();
        device.send(&FromDevice::Ping).await.unwrap();
        // The settings the user chose come first, as it connects; then the answer to the ping.
        assert_eq!(device.receive().await.unwrap(), ToDevice::Config { volume: 70, brightness: 100, language: String::new() });
        assert_eq!(device.receive().await.unwrap(), ToDevice::Pong);
        let listed = iface.get().await.devices_json();
        assert!(listed.contains("\"online\":true"), "{listed}");

        assert!(listed.contains("\"battery\":78"), "{listed}");

        // A notification from the daemon shows up on the device.
        let sent = iface.get().await.broadcast(&ToDevice::Notify {
            id: 1,
            kind: super::super::proto::Kind::Agent,
            title: "Claude Code".into(),
            body: "Needs you".into(),
            urgent: true,
            expire_ms: 30_000,
        });
        assert_eq!(sent, 1);
        assert!(matches!(
            device.receive().await.unwrap(),
            ToDevice::Notify { urgent: true, .. }
        ));

        // A device with a key the daemon does not know is closed without an answer.
        let stranger = TcpStream::connect(address.clone()).await.unwrap();
        assert!(connect(stranger, "aa:bb:cc:dd:ee:ff", &key).await.is_err());

        // Forgetting a device tells it, and it is offline after.
        {
            let mut service = iface.get_mut().await;
            service.forget_for_test(MAC);
        }
        assert!(matches!(
            device.receive().await.unwrap(),
            ToDevice::Bye { .. }
        ));
        let _ = std::fs::remove_dir_all(dir);
    }

    /// The firmware's own `link.c` and `pair.c`, built for the PC (`firmware/niro-device/test/host/build.sh`), as the device and
    /// this server as the daemon, over a real socket: the two implementations of the protocol must agree on every label and
    /// every byte. `NIRO_DEVICE_SIM=<dir>/device_sim dbus-run-session -- cargo test -p island-daemon -- --ignored firmware_e2e`
    #[tokio::test]
    #[ignore = "needs a session bus and the device_sim build: set NIRO_DEVICE_SIM"]
    async fn firmware_e2e() {
        use std::process::Stdio;
        use tokio::io::{AsyncBufReadExt, BufReader};
        use tokio::process::Command;

        let sim = std::env::var("NIRO_DEVICE_SIM").expect("NIRO_DEVICE_SIM");
        let dir = std::env::temp_dir().join(format!("niro-devices-fw-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let service = DeviceService::with_store(Store::at(dir.join("devices.json")));
        let bus = zbus::connection::Builder::session()
            .unwrap()
            .serve_at("/org/niro/island/DevicesFw", service)
            .unwrap()
            .build()
            .await
            .unwrap();
        let iface = bus
            .object_server()
            .interface::<_, DeviceService>("/org/niro/island/DevicesFw")
            .await
            .unwrap();
        tokio::spawn(super::super::service::run(iface.clone()));
        tokio::spawn(run(iface.clone()));

        let code = iface.get_mut().await.open_pairing();
        let port = loop {
            if let Some(port) = iface.get().await.port {
                break port;
            }
            sleep(Duration::from_millis(50)).await;
        };
        let host = crate::share::lan().expect("a network").ip.to_string();
        let port = port.to_string();
        let device = |args: Vec<String>| {
            Command::new(&sim)
                .args(args)
                .stdout(Stdio::piped())
                .kill_on_drop(true)
                .spawn()
                .expect("device_sim starts")
        };
        // The device's answer: its first line.
        async fn first_line(child: &mut tokio::process::Child) -> String {
            let out = child.stdout.take().unwrap();
            let mut lines = BufReader::new(out).lines();
            tokio::time::timeout(Duration::from_secs(60), lines.next_line())
                .await
                .expect("an answer in time")
                .unwrap()
                .unwrap_or_default()
        }
        let pair_args = |code: &str| ["pair", &host, &port, code, "10:b4:1d:e9:9d:34", "Niro Device 9D34"].map(String::from).to_vec();

        // A wrong code is dropped at once (PAIR_CODE is 2), and the user is never asked.
        let mut wrong = device(pair_args("000000"));
        assert_eq!(first_line(&mut wrong).await, "FAIL 2");
        assert!(iface.get().await.request.is_none());

        // The right code: the user is asked and denies (PAIR_DENIED is 3), and no key is given.
        let mut denied = device(pair_args(&code));
        let asking = async {
            loop {
                if iface.get().await.request.is_some() {
                    return;
                }
                sleep(Duration::from_millis(50)).await;
            }
        };
        let (line, ()) = tokio::join!(first_line(&mut denied), async {
            asking.await;
            assert!(iface.get_mut().await.answer_request(false));
        });
        assert_eq!(line, "FAIL 3");
        assert!(iface.get().await.devices.devices.is_empty());

        // And allowed.
        let mut paired = device(pair_args(&code));
        let asking = async {
            loop {
                let pending = iface.get().await.request.as_ref().map(|p| p.offer.clone());
                if let Some(offer) = pending {
                    return offer;
                }
                sleep(Duration::from_millis(50)).await;
            }
        };
        let (line, offer) = tokio::join!(first_line(&mut paired), async {
            let offer = asking.await;
            assert!(iface.get_mut().await.answer_request(true));
            offer
        });
        assert_eq!((offer.device_id.as_str(), offer.name.as_str()), ("10:b4:1d:e9:9d:34", "Niro Device 9D34"));
        let mut parts = line.split_whitespace();
        assert_eq!(parts.next(), Some("OK"), "{line}");
        let (daemon_id, key) = (parts.next().unwrap().to_owned(), parts.next().unwrap().to_owned());
        assert_eq!(daemon_id, iface.get_mut().await.daemon_id());
        assert!(iface.get().await.devices.key_matches("10:b4:1d:e9:9d:34", &key));

        // Back with the key: let in, answered, its status kept, sent a notification, told to go when forgotten.
        let mut connected = device(["hello", &host, &port, &key, "10:b4:1d:e9:9d:34"].map(String::from).to_vec());
        let mut lines = BufReader::new(connected.stdout.take().unwrap()).lines();
        async fn next_line(lines: &mut tokio::io::Lines<BufReader<tokio::process::ChildStdout>>) -> String {
            tokio::time::timeout(Duration::from_secs(20), lines.next_line()).await.expect("a line in time").unwrap().unwrap_or_default()
        }
        assert_eq!(next_line(&mut lines).await, "CONNECTED");
        assert_eq!(next_line(&mut lines).await, "MSG {\"t\":\"config\",\"volume\":70,\"brightness\":100,\"language\":\"\"}");
        assert_eq!(next_line(&mut lines).await, "MSG {\"t\":\"pong\"}");
        let listed = loop {
            let listed = iface.get().await.devices_json();
            if listed.contains("\"battery\":255") {
                break listed;
            }
            sleep(Duration::from_millis(50)).await;
        };
        assert!(listed.contains("\"online\":true"), "{listed}");
        // A tap on the talk button, in the firmware's own framing: heard as too short, and told so, with the slime curious.
        let mut talker = Command::new(&sim)
            .args(["hello", &host, &port, &key, "10:b4:1d:e9:9d:34"].map(String::from))
            .env("NIRO_SIM_TALK", "1")
            .stdout(Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .expect("device_sim starts");
        let mut talk_lines = BufReader::new(talker.stdout.take().unwrap()).lines();
        assert_eq!(next_line(&mut talk_lines).await, "CONNECTED");
        let mut heard = Vec::new();
        for _ in 0..4 {
            heard.push(next_line(&mut talk_lines).await);
        }
        assert!(heard.iter().any(|line| line.contains("\"t\":\"answer\"") && line.contains("did not catch")), "{heard:?}");
        assert!(heard.iter().any(|line| line.contains("\"name\":\"curious\"")), "{heard:?}");
        drop(talker);
        // Its connection ends with it, before the notification below is counted.
        while iface.get().await.open_connections() > 1 {
            sleep(Duration::from_millis(50)).await;
        }
        let sent = iface.get().await.broadcast(&ToDevice::Notify {
            id: 1,
            kind: super::super::proto::Kind::Agent,
            title: "Claude Code".into(),
            body: "Needs you".into(),
            urgent: true,
            expire_ms: 30_000,
        });
        assert_eq!(sent, 1);
        let notification = next_line(&mut lines).await;
        assert!(notification.contains("\"title\":\"Claude Code\"") && notification.contains("\"urgent\":true"), "{notification}");
        // Speech for the speaker: one frame of ADPCM, which the firmware's C decodes to its 320 samples.
        let frame = super::super::adpcm::Encoder::default().frame(&[300; 320]);
        assert_eq!(iface.get().await.broadcast(&ToDevice::Audio(frame)), 1);
        assert_eq!(next_line(&mut lines).await, "AUDIO 320");
        // A face is shown by name.
        assert_eq!(iface.get().await.broadcast(&ToDevice::Face { name: super::super::proto::Face::Sleepy }), 1);
        assert_eq!(next_line(&mut lines).await, "MSG {\"t\":\"face\",\"name\":\"sleepy\"}");
        iface.get_mut().await.forget_for_test("10:b4:1d:e9:9d:34");
        assert!(next_line(&mut lines).await.contains("\"t\":\"bye\""));
        assert_eq!(next_line(&mut lines).await, "END");

        // With nothing paired and no code open the daemon stops listening; a new code brings it back, on a new port.
        for _ in 0..100 {
            if iface.get().await.port.is_none() {
                break;
            }
            sleep(Duration::from_millis(50)).await;
        }
        assert!(iface.get().await.port.is_none(), "it should stop listening");
        iface.get_mut().await.open_pairing();
        let port = loop {
            if let Some(port) = iface.get().await.port {
                break port.to_string();
            }
            sleep(Duration::from_millis(50)).await;
        };
        // A device the daemon does not know is closed without an answer.
        let mut stranger = device(["hello", &host, &port, &key, "aa:bb:cc:dd:ee:ff"].map(String::from).to_vec());
        assert_eq!(first_line(&mut stranger).await, "REFUSED");
        let _ = std::fs::remove_dir_all(dir);
    }

    /// A real board on the network: opens a pairing code (written to `NIRO_BOARD_DEMO`), allows the device that types it, then
    /// sends it two notifications and reports what the daemon saw. For trying the firmware by hand; not a test of anything.
    /// `NIRO_BOARD_DEMO=/tmp/demo.log dbus-run-session -- cargo test -p island-daemon -- --ignored board_demo --nocapture`
    #[tokio::test]
    #[ignore = "needs a session bus and a board: set NIRO_BOARD_DEMO"]
    async fn board_demo() {
        use std::io::Write;
        let path = std::env::var("NIRO_BOARD_DEMO").expect("NIRO_BOARD_DEMO");
        let mut log = std::fs::File::create(&path).unwrap();
        let mut say = |text: String| {
            writeln!(log, "{text}").unwrap();
            log.flush().unwrap();
        };
        let bus = zbus::connection::Builder::session()
            .unwrap()
            .serve_at("/org/niro/island/DevicesDemo", DeviceService::load())
            .unwrap()
            .build()
            .await
            .unwrap();
        let iface = bus.object_server().interface::<_, DeviceService>("/org/niro/island/DevicesDemo").await.unwrap();
        tokio::spawn(super::super::service::run(iface.clone()));
        tokio::spawn(run(iface.clone()));

        let code = iface.get_mut().await.open_pairing();
        say(format!("CODE {code}"));
        // The user types the code on the board; whoever asks with it is allowed.
        for _ in 0..3600 {
            let pending = iface.get().await.request.as_ref().map(|p| p.offer.clone());
            if let Some(offer) = pending {
                say(format!("ASKED {} {}", offer.device_id, offer.name));
                iface.get_mut().await.answer_request(true);
                break;
            }
            sleep(Duration::from_millis(50)).await;
        }
        for _ in 0..1200 {
            if iface.get().await.devices_json().contains("\"online\":true") {
                break;
            }
            sleep(Duration::from_millis(50)).await;
        }
        say(format!("DEVICES {}", iface.get().await.devices_json()));
        for (i, (title, body, urgent)) in [("Niro", "Hello from your computer", false), ("Claude Code", "Needs you now", true)].into_iter().enumerate() {
            sleep(Duration::from_secs(if i == 0 { 2 } else { 12 })).await;
            let sent = iface.get().await.broadcast(&ToDevice::Notify {
                id: i as u64 + 1,
                kind: super::super::proto::Kind::Agent,
                title: title.into(),
                body: body.into(),
                urgent,
                expire_ms: 30_000,
            });
            say(format!("SENT {title} to {sent}"));
        }
        sleep(Duration::from_secs(40)).await;
        say(format!("DEVICES {}", iface.get().await.devices_json()));
        say("DONE".into());
    }
}
