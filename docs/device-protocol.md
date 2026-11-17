# Niro Device protocol (draft)

How a Niro Device (an ESP32-S3 assistant with a screen, a microphone, a speaker and buttons) pairs with one
user's Niro and talks to it. **Draft: nothing here is built yet.** Open decisions are marked **[open]**.

## Goals

- One device belongs to one Niro (one desktop account). Another user cannot use it, and the device cannot
  reach another user's Niro, even on the same network.
- Pairing with a short code the user reads on the island and types on the device.
- Same Wi-Fi first (this document); the same messages later over USB serial.
- The AI, speech recognition and keys stay on the PC. The device holds no provider key.
- Ask and answer (voice in, text and audio out), notifications, and a status face on the screen.

## Roles

| | Role |
|---|---|
| `island-daemon` | Server. Listens on the LAN, advertises over mDNS, owns pairing, the device list and every answer. |
| Device | Client. Finds the daemon, pairs once, then reconnects by itself. |

The daemon is the server because it is the one holding secrets, and because a PC has a stable identity
(`daemon_id`) while a device only has a MAC.

## Discovery

The daemon advertises `_niro-device._tcp` with TXT records:

| Key | Value |
|---|---|
| `id` | `daemon_id`: 16 random bytes, hex, made once and kept in the daemon's store |
| `v` | protocol version, `1` |
| `pair` | `1` only while a pairing code is active, else `0` |

A paired device looks for its stored `id`. An unpaired one lists daemons with `pair=1`. mDNS never carries a
secret, only who to talk to.

## Pairing

1. In the control panel or the island the user presses **Add a device**. The daemon makes a code of 6 digits,
   shows it, sets `pair=1`, and keeps it for 2 minutes.
2. On the device the user types the code (buttons or the screen).
3. Device and daemon run **SRP-6a** with the code as the password. The code is never sent and cannot be
   guessed offline from a recording of the exchange. Why SRP: ESP-IDF ships it (`esp_srp`, the same code
   as protocomm security 2), so the firmware needs no hand-written cryptography.
   - The **device is the SRP server**, because `esp_srp` has no client side: it makes a salt and a
     verifier from the code the user typed. The **daemon is the SRP client**: it knows the code from the island.
     (After pairing the network roles are as before: the daemon listens and the device connects.)
   - Parameters, as `esp_srp` fixes them: the 3072-bit group with `g = 5`, SHA-512, `x = H(salt | H("niro-device:" code))`,
     `u = H(PAD(A) | PAD(B))` padded to 384 bytes, `K = H(S)` (64 bytes), `S` at its minimal length (tested against `esp_srp.c` itself over 1200 sessions).
   - The device makes the salt whole (16 bytes) and the verifier from it, and gives both to `esp_srp`
     (`firmware/niro-device/main/srp_device.c`): `esp_srp_srv_pubkey` makes its own salt at minimal length, so one
     salt in 256 is 15 bytes long where the code reads 16, and the pairing then fails by chance.
   - The `srp` crate disagrees with `esp_srp` on `u` (unpadded), on the key (raw `S`) and on the proofs, so the
     daemon uses only its arithmetic and follows `esp_srp.c` for the rest (`device/srp.rs`). The proofs M1 and M2 are
     not used: both sides hold `K`, and step 4 confirms it.
4. Both prove they hold `K` with `HMAC-SHA256(K, "device" | A | B)` and `HMAC-SHA256(K, "daemon" | A | B)`. Then
   they exchange the long-term material, sealed with `K`:
   - the daemon sends its `daemon_id` and a 32-byte `device_key` made for this device;
   - the device sends its `device_id` (the MAC, for display only) and a name.
5. The island asks the user to confirm ("Add *Niro Device 9D34*?"). Without it nothing is stored.
6. The daemon stores `{device_id, name, device_key, paired_at}` under the user's data directory
   (`~/.local/share/island/devices.json`, mode `0600`). The device stores `{daemon_id, device_key}` in NVS.

Limits: 5 wrong attempts end the code. One active code per daemon. A code works once.
The daemon refuses a device it already knows without a new pairing.

Unpair: either side forgets the key. The daemon's `Forget(device_id)` also closes its connection.

## Connection

Plain TCP on a port the daemon picks (advertised with the mDNS service). A frame is a 2-byte big-endian length
and that many bytes. (WebSocket was dropped: its handshake needs SHA-1 and a library, and every frame is
sealed anyway. The same frames can run over a USB serial cable later.) TLS is not used either: there is no
certificate a LAN device could check.

1. Device sends `hello` `{v, device_id, nonce}` (clear JSON, `nonce` is 16 random bytes in hex).
2. If the device is not paired the daemon closes the connection and answers nothing. Otherwise it answers
   `challenge` `{daemon_id, nonce}`.
3. Both derive `HKDF-SHA256(ikm = device_key, salt = nonce_device | nonce_daemon)` into three keys, one per
   direction (`niro-device v1 d2s` and `s2d`) and one for the MAC (`mac`).
4. Device sends `auth` `{mac = HMAC-SHA256(mac_key, "device" | nonce_daemon)}`; the daemon checks it in
   constant time and answers `ready` `{mac = HMAC-SHA256(mac_key, "daemon" | nonce_device)}`.
5. From here every frame is ChaCha20-Poly1305 over `[type][data]` (`0` JSON control message, `1` Opus audio),
   with a 64-bit counter as the nonce, one counter per direction. A frame that is changed, repeated,
   dropped or reordered fails to open and the connection ends.

Limits: a handshake frame is at most 512 bytes and a sealed one carries at most 16 KiB; a larger length is
refused before any of it is read. The daemon gives a handshake a few seconds, and refuses addresses that are
not on a local network.

## Messages

JSON text frames for control; binary frames for audio. `t` is the type.

### Device to daemon

| `t` | Fields | Meaning |
|---|---|---|
| `listen.start` | `lang`, `codec: "opus"`, `rate: 16000` | The user asked (button or wake). Audio frames follow. |
| `listen.stop` | | The user let go, or the device's own end-of-speech fired. |
| *(binary)* | Opus frame, 20 ms | Audio, only between `listen.start` and `listen.stop`. |
| `button` | `id`, `action: press\|long\|release` | A button the daemon may bind to something. |
| `status` | `battery`, `charging`, `temp_c`, `rssi`, `fw` | Every 30 s and when something changes. `battery` is 0 to 100, or 255 when the device does not read it. |
| `ack` | `id` | A notification was shown or dismissed. |
| `ping` | | Keep-alive, every 15 s. |

### Daemon to device

| `t` | Fields | Meaning |
|---|---|---|
| `stt` | `text`, `final` | What was heard, as it is recognised. |
| `answer` | `id`, `text`, `done` | The AI's reply in pieces; `done` ends it. |
| *(binary)* | Opus frame | Spoken reply, after `answer` with `audio: true`. |
| `notify` | `id`, `kind`, `title`, `body`, `urgency`, `expire_ms` | An alert. `kind`: `agent`, `reminder`, `meeting`, `battery`, `system`. |
| `face` | `name` | The mood of the mascot, a slime (see `firmware/niro-device/MASCOT.md`): `idle`, `listening`, `thinking`, `speaking`, `happy`, `alert`, `sleepy`, `sad`, `curious`, `love`. The device also has moods of its own for what it is doing (waking, searching for Wi-Fi). |
| `config` | `volume`, `brightness`, `language` | Set by the user in the panel, kept by the device. |
| `pong` | | |
| `bye` | `reason` | The daemon is closing (`forgotten`, `shutdown`). |

While pairing, before the connection is sealed, the daemon also sends `pair.a` and `pair.done`, and `pair.denied` when the user
does not allow the device: a device that typed the wrong code is not told anything, the connection is simply closed, so the two can
be told apart.

Notifications come from what the daemon already has: `Alert` and the agent hooks (`Agents1`), reminders,
meetings, battery. Which kinds reach the device is a per-device setting in the panel.

## Failure behaviour

- No daemon found: the device keeps its last face and retries with backoff (1 s up to 60 s). It never falls
  back to a cloud or a default server.
- Connection lost in a request: the device says so on screen. The daemon drops that request's answer.
- Daemon asleep or off: notifications are not queued past 5 minutes; a reminder is shown by the island as
  usual when the PC wakes.
- Wi-Fi unreachable: the device's own provisioning (BLE) is how the user fixes it, and does not involve Niro.

## Daemon work (not started)

- `crates/island-daemon/src/device/`: `mod.rs` (state, D-Bus `Devices1`), `pair.rs`, `server.rs`, `proto.rs`.
- `Devices1` on the bus: `Pairing` (code and time left), `List`, `StartPairing()`, `Confirm(id)`, `Forget(id)`;
  GNOME Shell only, like `Share1`.
- A way to feed audio into `assistant/` the way `mic.rs` does, and to send the answer back.
- Panel page: add, rename, forget, choose which notification kinds.

## Device firmware (not started)

ESP-IDF on ESP32-S3: Wi-Fi with BLE provisioning (as the board has now), mDNS, pairing, the TCP client,
Opus, I2S, the display and the buttons. The pin map comes from the current firmware, so it is read from
a **backup of the board first**.

## Open questions

- **[open]** The `srp` crate has had no independent audit; the daemon uses only its modular arithmetic.
- **[open]** Wake word on the device, or button only. A button is the first version.
- **[open]** Speaker output: Opus from the PC (needs TTS on the PC) or text only at first.
- **[open]** Several PCs for one device, or strictly one.
- **[open]** USB serial: the same frames, with a way to tell where one starts if a byte is lost.
