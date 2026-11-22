# Real-session acceptance checklist

Run in a normal GNOME Wayland session after logging in with the current package (`rpm -q niro-control` on Fedora or `dpkg -s niro-control` on Ubuntu shows the version; the Home page's "Log out needed" row must say No). Automated tests and the headless shell cover the logic; only this list covers a real keyboard, real windows and a real compositor. Tick each line and note anything odd.

| # | Check | How | Expect |
|---|---|---|---|
| 1 | Super+Space opens Search | Press it from any app | Palette appears, text field focused; Super+Space again closes it |
| 2 | No shortcut conflict | Press Super+Space; also try the input-source switch you use | Only Search opens; typing languages switch by their own key |
| 3 | Keyboard navigation | Type `set`, then Down, Up, Tab, Ctrl+N/P | The first result is selected at once; selection wraps; the text stays |
| 4 | Esc | Press Esc with text typed | Palette closes |
| 5 | Focus restoration | Focus a text editor, open Search, press Esc | Typing continues in the editor |
| 6 | Hover vs selection | Move the mouse over a row while typing | Hover is a light highlight; the keyboard selection does not jump |
| 7 | Application launch | Type an app name, Enter | The app opens once (not twice) |
| 8 | Window search | Open two windows, type part of a title, Enter | The right window is focused |
| 9 | Calculator | `2*pi+17`, Enter | Result copied; first result of the list |
| 10 | Unit conversion | `20 gb to mb` | Correct result first |
| 11 | Settings navigation | `dock position`, Enter | Control Panel opens on that setting |
| 12 | Profile from Search | `profile gaming`, Enter | Profile applied; a notification confirms |
| 13 | Profile from Home and Profiles | Apply from each | The summary dialog shows headline, areas, expandable old/new values, undo line |
| 14 | Undo | After 12/13 press Undo in the toast (or Profiles > Backups > Restore) | Previous values return, including settings that were never set |
| 15 | Clipboard search | Copy text, type `clip` | The copied text is listed; Enter copies it again |
| 16 | Protected action | `restart` | Enter shows a confirmation; Cancel does nothing; the hint says "Enter asks to confirm" |
| 17 | AI action | Ask the island's assistant to open a setting, then to restart | The setting opens; restart asks for confirmation; an invented action is refused |
| 18 | Duplicate execution | Hold Enter on an app result | One launch only |
| 19 | Settings Health | Open Home | Six rows; states match reality (stop the island service: "Background service" becomes Needs attention) |
| 20 | Recovery | Not easy to stage by hand: run `tests/gjs/profiles.test.js` for the logic; in a session, kill `niro-control --apply-profile gaming` mid-way and reopen Home | A Recovery row offers Restore backup |
| 21 | Log out notice | After installing a new package without logging out | "Log out needed" says which part, with a Log out button |
| 22 | Light and dark | Switch the system theme | Panel and Search stay legible; focus rings visible with Tab |
| 23 | Idle CPU | `top -p $(pgrep -xo gnome-shell)` for a minute with nothing moving | Note the CPU. Two read-only samples on the author's machine gave 17.9% and 2.7% (the first was probably transient load, not reproduced): if yours stays high, bisect with `gnome-extensions disable` one Niro extension at a time |
| 24 | Panel glass and readability | After the login that loads the new blur extension, open the Control Panel over a bright and a detailed wallpaper; move Look > Opacity from 0 to 100 | The sidebar and content stay readable at every value; only the window's background gets more or less see-through; text and controls never fade |
| 25 | Universal Appearance on a real GTK app | Compatibility > GTK theme integration > Install… (read the file list; a backup is made), restart Files and Settings | Backgrounds follow the glass and stay readable; Restore original brings the old look back and your gtk.css files are byte-identical to before |
| 26 | Per-application rules | Compatibility: exclude one app; turn on "Window-level effects", set Window fade for one app | After the new login: the excluded app has no blur; only the fade app is see-through (and its text too); everything else is unfaded |
| 27 | Presets, safe mode | Look > Universal Appearance: pick each preset; turn Safe mode on and off | Values change with the preset; safe mode makes everything solid at once; high-contrast (Settings > Accessibility) makes the panel solid |
| 28 | Niro Snip | Super+Shift+S, pick an area; draw a pen line, an arrow, a numbered step, pixelate some text, crop; Save | The picker is GNOME's own; the editor opens with the shot; Save writes over the file in Pictures/Screenshots and the picture is on the clipboard |
| 29 | Dock badges | Get a notification from an app pinned to the dock (e.g. `notify-send` from a terminal counts for the terminal) | A red count on its icon's top-left corner; it goes when the notification is dismissed |
| 30 | Dock preview close | Hover an app with two windows, click × on one preview | That window closes; the preview updates; the other window keeps focus |
| 31 | Stopwatch | Island → Timer → Stopwatch; Start, Lap twice, Stop, Reset | The time runs on the ring; laps list newest first; Reset clears it; Timer brings the Pomodoro back as it was |
| 32 | Currency | Search: `150 usd to idr` | A Conversion row with the rate appears within a second or two; offline, "Could not get the exchange rate" |
| 33 | Dock stacks | Click the Downloads folder at the dock's end; minimize a pinned app's window | The newest 12 files, newest first; one opens in its app; "Open Downloads" opens Files; the minimized thumbnail sits before the stacks, the app icons keep their order |
| 34 | Time zones | Search: `jam di tokyo`, then `10:00 jakarta to london` | A Conversion row with the time; Enter copies it |
| 35 | Dock quicklist | Right-click Firefox (or any app whose launcher has actions) in the dock | Its own actions, such as "New Private Window", sit under "New Window" |
| 36 | Text from a screenshot | Super+Shift+S, pick an area with text, press the text button (or `Ctrl+T`) | "Copied N words"; paste shows the text. Without `tesseract` it says how to install it |
| 37 | File search | Search: `f invoice` (any part of a file name in your home folder) | The matches with their folders; Enter opens one in its app; nothing is listed for an ordinary search |
| 38 | Calculator names | Search: `gaji = 8jt`, Enter; then `gaji * 12` and `ans / 2` | 8,000,000; then 96,000,000; then half of the last result |
| 39 | Dates | Search: `30 days from now`, `selisih 1 jan ke 17 agu`, `days until 25 dec` | The date or the number of days; Enter copies it |
| 40 | Passwords and encodings | Search: `pass 20`, `uuid`, `b64 halo`, `sha256 halo` | The result under Tools; Enter copies it; it is not kept in Search's recent list |
| 41 | Presentation mode | Search: `presentation`, Enter; leave the computer idle past the screen-off time; run it again | Banners are hidden and the screen stays on; running it again puts both back |
| 42 | Light by day, dark by night | Niro Control → Look → Schedule: switch it on, set "Dark from" two minutes ahead | At that minute GNOME's style turns dark; a manual switch in between stays until the next time; switched off, nothing changes |
| 43 | Download indicator | Start a download in the browser; look at the Downloads folder at the dock's end | A red bar pulses under the folder while the file is being written, and is gone when it ends; the tooltip says how many are downloading |
| 44 | Hide private details | Niro Snip on a screenshot with an e-mail address and a phone number, the eye button | Pixelated boxes over them (undo removes one at a time); "Nothing private found" when there is none |
| 45 | QR code | Search: `qr https://example.com`, Enter | Niro Snip opens the code; a phone's camera reads it |
| 46 | Translate and meaning | Search: `tr id good morning`; `define serendipity` | The translation / meanings appear within a second or two; offline, "Lookup failed" |
| 47 | Weather and clocks | Search: `cuaca bandung`; `world` | Now and three days; five clocks |
| 48 | Notes, to-dos, habits | Search: `note buy milk`, `todo call the bank`, `todos` (Enter ticks one), `habit water`, `habits` | Files in Documents/Niro (`notes.md`, `todo.md`, `habits.tsv`) change as typed; a streak counts days in a row |
| 49 | Next events | Add an event in the island's calendar; Search: `next` | The coming events with the time left |
| 50 | Kill a process | Search: `kill gedit` (with it open), Enter, confirm | It asks first, then the application quits |
| 51 | Terminal history and contents | Search: `h git`; `fc` plus a word that is inside a document | Matching commands (Enter copies); files whose text has the word |
| 52 | Layouts | Arrange two windows; Search: `layout save work`; move them; `layout work` | They go back where they were |
| 53 | Home Assistant | Set the address in Niro Control › Search › Home Assistant, put the token in `~/.config/niro-control/ha-token`; Search: `ha light` | Your lights listed; Enter asks, then toggles one |
| 54 | System actions | Search: `battery`, `network speed`, `vpn`, `spotlight`, `zoom`, `record`, `on top`, `autostart` | Each does what its name says; the trash and thumbnail cleaners ask first |
| 55 | Do Not Disturb hours | Niro Control → Look → Schedule: switch on, set "from" two minutes ahead | Banners are hidden from then until the end time, and come back |
| 56 | Niro Snip: ruler, picker, frame | Tools: ruler (drag), colour picker (click), the frame button, then Copy | The pixel distance is drawn; the colour code is copied; the copy has a gradient and rounded corners |
| 57 | Trash and folder stacks | Niro Control → Dock: switch on Trash stack and set a folder stack | Icons at the dock's end; Trash lists deleted files, "Empty Trash" needs two clicks |
| 58 | Recurring reminder | Add a reminder `stretch /daily` (a minute from now) | It shows as `stretch` and is back tomorrow |
| 59 | Snip history and upload | Niro Control → Search → Screenshots: switch history on, take a snip; Search: `snips` | The kept snips; Enter opens one. With an upload address set, an Upload button copies the answer |
| 60 | Window switcher | Niro Control → Search → Window Switcher: record a shortcut; open two windows; press it | Cards with a live picture of each window, the previous one selected; arrows or Tab move, Enter or a click brings it forward, Esc closes; Alt+Tab is unchanged |
| 61 | Search behaviour | Niro Control → Search → Search Behaviour: turn off "Tools above applications"; type `pass` | The password row now comes after matching applications; on again, it leads |
| 62 | World clock cities and language | Set the cities to `jakarta, paris`, language Indonesian; Search: `world`, `cuaca bandung`, `30 days from now` | Two clocks; weather and dates in Indonesian; "Enter menyalin" under the clocks |
| 63 | Dock tuning | Niro Control → Dock: set "Files listed in a stack" to 5 and "Download still going after" to 300; open Downloads | Five files; the bar stays up for a partial file changed within five minutes |
| 64 | Kill protection and snip history size | Add `firefox` to "Processes kill never offers"; Search: `kill firefox`. Set "Snips kept" to 5 with history on | No Firefox row; only the newest five snips stay |
| 65 | More recurring reminders | Add `standup /weekdays` and `rent /monthly` | After a Friday's, the next one comes on Monday; the monthly one on the same day next month |
| 66 | Adaptive profile suggestion | Niro Control → Search → Search Behaviour: switch on the profile suggestion; open a code editor, press Super+Space | The first row reads "Switch to Deep Work?" with the reason; Enter applies it; opening Search again within 30 minutes does not repeat it |

Nothing in this list has been run by the author yet; the report says so.

## vNext Desktop UAT — Fedora 45, GNOME Shell 51.1, Wayland (real session, 2026-11-22)

Run by Claude Code on the owner's live session after a re-login, driving the shell over D-Bus. Only `search@niro.local` and `tile@niro.local` were the vNext build (user copies in `~/.local/share/gnome-shell/extensions`, rollback: `~/niro-vnext-rollback.sh`); the other Niro extensions and `/usr/bin/island-daemon` stayed at 1.5.9. Nothing here was seen on screen by a person: panel pages and visual output are **Not Executed**.

| # | Check | Result | Evidence |
|---|---|---|---|
| V1 | vNext extension loaded in the real shell | PASS | `GetExtensionInfo` path = `~/.local/share/...`, state 1 (enabled), no error; `ListActions` = 76 actions |
| V2 | Search actions with no switch needed | PASS | `text.transform` upper → `HELLO WORLD`; `url.clean` dropped `utm_source`; `perf.report` returned live CPU/memory; `adaptive.history` → "No suggestions yet" |
| V3 | Opt-in features refuse while off | PASS | `privacy.status`, `notifications.summary`, `audio.devices`, `collection.list` all `unavailable` naming the switch to turn on |
| V4 | Extension conflict check | PASS | "10 of 15 extensions enabled … No known conflicts". `tiling-assistant@ubuntu.com` is listed in `enabled-extensions` but is not installed on this machine, so there is nothing to conflict with |
| V5 | Session snapshot: take, list, plan, delete | PASS | 2 windows (Orca, Chrome) recorded; restore plan reported both as no-op; deleted; list empty |
| V6 | Window group: create, list, delete | PASS | Created and removed `uat-group` |
| V7 | Window Rules engine on real windows | PASS (narrow) | Float rules for the two open apps with Tile on: both windows `tiled:false`, geometry unchanged; Tile switched off and all settings restored to their previous values |
| V8 | Flow CLI against the real, running Search | PASS (read-only) | `--flow actions` listed the live registry; isolated config dir, `~/.config/niro` untouched |
| V9 | `gnome-shell` stayed up through all of the above | PASS | PID 721822 unchanged |
| V10 | Flow run through the daemon on the real session | PASS | After installing the local vNext rpm (unsigned, `rpm -Uvh --replacepkgs --nosignature`) and restarting `island-daemon` with `systemctl --user`: `RunNow` refused while Flow was off; after `SetGlobalEnabled true` a saved `clipboard.copy` workflow ran, history `status:ok`, the real clipboard held the text, the live Search audit shows `caller:"island-daemon"` with the text hidden (`(hidden, 20 chars)`); a `system.restart` workflow was refused at Save. Workflow deleted, Flow switched off, history empty, clipboard cleared afterwards |
| V11 | Tile layout/tiling, workspace/monitor rule actions, hotplug | Not Executed | Tiling was not switched on for real windows (it would have moved them); no second monitor |
| V12 | Control Panel pages (Flow, Appearance Studio, grouped sidebar) | Not Executed | Needs a person to look at them; the packaged panel on this machine is 1.5.9 |
| V13 | Notification, audio, mic/camera, HUD behaviour with their switches on | Not Executed | Switches left off; no hardware exercised |

Install note (2026-11-22): the vNext rpm (`niro-control-1.5.9-939`) was installed with sudo over the same-version 1.5.9 package; it is unsigned (this machine cannot sign), so `--nosignature` was needed. The previous 1.5.9 rpm file in `out/` was overwritten by the rebuild (same name), so a rollback means rebuilding it from commit `27cd0d1`. The session was re-logged-in by the owner before the install, so the running shell still has the earlier vNext user copies (now removed) loaded; the fix wave (flow-events emitter, Tile `profile`/`opacity`, planner phrases, Look contrast, Notifications page) is **Not Executed** on the live desktop until the next login.

### Fix-wave UAT (2026-11-22, after the owner's second re-login; system rpm `niro-control-1.5.9-939` loaded)

| # | Check | Result | Evidence |
|---|---|---|---|
| W1 | Installed build loaded from the system path | PASS | `search@niro.local` and `tile@niro.local` from `/usr/share/gnome-shell/extensions`, state enabled, no error, 76 actions, `island-daemon` active |
| W2 | `flow-events` on: launching an app fires a workflow | PASS | Workflow with trigger `app_launched` (`org.gnome.Calculator`) ran when Calculator was started: history `status:ok`, event id `launched-org.gnome.Calculator.desktop-…`, the real clipboard held the workflow's text |
| W3 | `flow-events` off: nothing fires | PASS | Same workflow, setting off, Calculator started again: no new run (1 run in history), clipboard unchanged |
| W4 | Cleanup | PASS | Workflow deleted, Flow off, `flow-events` false, history cleared; the two test entries removed from the clipboard history |
| W5 | Tile `profile` condition, `opacity` action, workspace/monitor events, planner phrases, Look contrast, Notifications page | Not Executed live | Covered only in nested-shell tests (`tileWorkspace` 50 checks, e2e-flow event checks); not exercised on this desktop |
| W6 | Backup & Restore, Motion preset, Theme derivation, Widgets in Search | Not Executed | Built after the installed rpm; need a rebuilt package and another login |

Incident: while looking for the Clipboard1 methods, an `introspect` call printed the whole clipboard-history `Items` property into the session output, which included secret-looking entries of the owner. They were not copied or used; only the two UAT entries were removed. Consequence for the owner: rotate anything in that history that is a real password, and consider clearing the history (`Clipboard1.Clear`) and switching on `NIRO_CLIPBOARD_SKIP_SECRETS`.

### Package with the Core-Only wave installed (2026-11-22)
Rebuilt (`npm run build`, `packaging/build-rpm.sh`) and installed with `rpm -Uvh --replacepkgs --nosignature`; `island-daemon` restarted with `systemctl --user`; `gnome-shell` untouched (still the previous login's process, so the shell-side parts of this wave are **not loaded yet**).

| # | Check | Result | Evidence |
|---|---|---|---|
| X1 | `niro-plugin check` from the installed package | PASS | A bad manifest printed `INVALID` with 4 specific problems |
| X2 | `niro-control --backup-export` on the real settings | PASS | 283 settings from 7 schema groups, file mode 0600, 0 secret-shaped values, 0 secret-named keys; temp file deleted |
| X3 | `niro-control --backup-preview` of that export | PASS | "0 to change, 283 already the same"; import was not run |
| X4 | Backup page, motion preset, theme derivation, Widgets in Search, Notifications page on screen | Not Executed | Need another login and a person looking at the panel |

### Clipboard secret filter (2026-11-22, live, switch `~/.config/niro/clipboard.skip-secrets` = true)
- A fake AWS-style example key copied with `wl-copy`: `SecretsSkipped` 0 → 1, history stayed empty. PASS.
- Open question: ordinary text copied with `wl-copy` (two tries) did not appear in the history either (`Items` stayed 0). It is not known whether `wl-copy` copies from a CLI are simply not picked up by the history on this desktop or whether the filter blocks too much; check by copying text in a normal application after the next login. Not resolved.

### Live session, new package loaded (2026-11-22, after the third login; Search shows 78 actions)

| # | Check | Result | Evidence |
|---|---|---|---|
| Y1 | Planner phrase | PASS | `plan.preview "copy hello to clipboard"` → "1. Copy text … Nothing was run." |
| Y2 | Widgets in Search, opt-in | PASS | Off: refused naming the switch; on: `widgets.list` answered and `widgets.show` returned processor/memory/load/battery; switched off again and refused again |
| Y3 | Island `motion-preset` setting present | PASS (setting only) | Default `default`; the visible effect on the island was not looked at |
| Y4 | Tile Advanced Rules on windows that are already open | FAIL (known limitation) | Rules `monitor:0` for Orca with Tile switched on: nothing moved, because rules run only when a window is first seen (`shell/tile/extension.js` first-seen block). Settings restored afterwards |
| Y5 | Window placement via Session Snapshot | PASS | Snapshot `orca-vertikal-chrome-horizontal` (the snapshot file was edited to put Orca on the portrait monitor 0, 1080×1920) → `plan` showed Orca "place", Chrome no-op → `restore` → read-back: Orca on monitor 0 maximized 1080×1920, Chrome on monitor 1 maximized 2560×1080 |
| Y6 | Play the open Chrome video | Not Done | Chrome exposes no MPRIS player and the browser extension cannot see the owner's tabs; no key injection tool on this machine |
| Y7 | Fullscreen as a rule action | Not Implemented | Being added in the next change together with an "apply rules to open windows" action |
