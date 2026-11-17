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
     `u = H(PAD(A) | PAD(B))` padded to 384 bytes, `K = H(S)` (64 bytes).
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

WebSocket on a port the daemon picks (advertised with the mDNS service), over plain TCP. TLS is not used:
there is no certificate a LAN device could check. Instead every frame is sealed.

1. Device connects and sends `hello` `{v, device_id, nonce_d}` (clear).
2. Daemon answers `challenge` `{daemon_id, nonce_s}`.
3. Both compute `session_key = HKDF-SHA256(device_key, nonce_d || nonce_s, "niro-device v1")`.
4. Device proves it with `auth` `{mac = HMAC-SHA256(session_key, "device" || nonce_s)}`; the daemon
   answers `ready` `{mac = HMAC-SHA256(session_key, "daemon" || nonce_d)}`. A wrong MAC closes the socket,
   with a rate limit per address like phone sharing has.
5. From here every WebSocket message is `ChaCha20-Poly1305`, nonce = a per-direction 64-bit counter. A repeat
   or a gap closes the connection.

A device whose key the daemon does not know is closed after `hello` and does not learn whether it was
paired before.

## Messages

JSON text frames for control; binary frames for audio. `t` is the type.

### Device to daemon

| `t` | Fields | Meaning |
|---|---|---|
| `listen.start` | `lang`, `codec: "opus"`, `rate: 16000` | The user asked (button or wake). Audio frames follow. |
| `listen.stop` | | The user let go, or the device's own end-of-speech fired. |
| *(binary)* | Opus frame, 20 ms | Audio, only between `listen.start` and `listen.stop`. |
| `button` | `id`, `action: press\|long\|release` | A button the daemon may bind to something. |
| `status` | `battery`, `charging`, `temp_c`, `rssi`, `fw` | Every 30 s and when something changes. |
| `ack` | `id` | A notification was shown or dismissed. |
| `ping` | | Keep-alive, every 15 s. |

### Daemon to device

| `t` | Fields | Meaning |
|---|---|---|
| `stt` | `text`, `final` | What was heard, as it is recognised. |
| `answer` | `id`, `text`, `done` | The AI's reply in pieces; `done` ends it. |
| *(binary)* | Opus frame | Spoken reply, after `answer` with `audio: true`. |
| `notify` | `id`, `kind`, `title`, `body`, `urgency`, `expire_ms` | An alert. `kind`: `agent`, `reminder`, `meeting`, `battery`, `system`. |
| `face` | `name` | The status face: `idle`, `listening`, `thinking`, `speaking`, `happy`, `alert`. |
| `config` | `volume`, `brightness`, `language` | Set by the user in the panel, kept by the device. |
| `pong` | | |
| `bye` | `reason` | The daemon is closing (`forgotten`, `shutdown`). |

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

ESP-IDF on ESP32-S3: Wi-Fi with BLE provisioning (as the board has now), mDNS, pairing, the WebSocket client,
Opus, I2S, the display and the buttons. The pin map comes from the current firmware, so it is read from
a **backup of the board first**.

## Open questions

- **[open]** Whether `esp_srp` writes `S` with its minimal length (assumed) or padded to 384 bytes before hashing:
  the source shows `esp_mpi_to_bin`, whose padding is not in the files read. One real pairing settles it; a
  wrong guess makes the two keys differ now and then, never silently succeed.
- **[open]** The `srp` crate has had no independent audit; the daemon uses only its modular arithmetic.
- **[open]** Wake word on the device, or button only. A button is the first version.
- **[open]** Speaker output: Opus from the PC (needs TTS on the PC) or text only at first.
- **[open]** Several PCs for one device, or strictly one.
- **[open]** USB serial framing: the same sealed messages with length prefixes.
