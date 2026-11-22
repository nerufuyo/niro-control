# NIRO Control vNext: audit, gap matrix and plan

Baseline: v1.5.9 (`main` at `27cd0d1`, working tree clean). Written for the 30-initiative "Adaptive Desktop" specification.
Evidence level: file headers, settings, tests and greps over `shell/`, `control/src/`, `crates/`; each "Partial" below was
confirmed by reading what the named file says it does, not by running it on a real desktop. Where a claim needs a deeper
read, the row says so.

## 1. Baseline test report (before any vNext change)

| Check | Command | Result |
|---|---|---|
| Node + GJS | `npm test` | exit 0; 271 node tests pass; GJS `controlUi: ok (224 bindings, 224 rows)` |
| Lint | `cd shell/dock && npx biome check src/` | 1 warning (`useOptionalChain`, old) |
| Headless GNOME Shell | `bash tests/shell/run-staged.sh headless` | exit 0, "all passed" (43 actions, no `JS ERROR`) |
| Rust | `cargo test -p island-core -p island-daemon` | 85 + 435 passed, 13 ignored |
| Clippy | `cargo clippy -p island-core -p island-daemon` | 1 warning (a function with 8 arguments, old) |
| Desktop UAT | `docs/UAT.md` (65 rows) | not run by the author on a real session for the 1.5.x additions |

Shell versions declared by every extension: 46 to 51. Version-dependent APIs already go through `compat.ts` helpers
(`SHELL_MAJOR`, `VERTICAL`, `box()`); new code must do the same (for example `St.BoxLayout` takes `vertical` up to Shell 50
and `orientation` from 48).

## 2. What the shared services already are

| Spec service | Today | Gap |
|---|---|---|
| ActionRegistry | `shell/search/registry.ts` + `actions.ts`: 47 typed actions (4 added in vNext: text.transform, url.clean, clipboard.sensitive.check, extensions.check), argument validation, `none`/`confirm` permission, audit `History`, D-Bus `org.niro.Search` (`ListActions`, `Availability`, `RunAction`, `History`). The island assistant's gateway (`island-daemon --niro-action`) obeys the same rules. | Lives inside the Search extension; Flow, AI, Macro and Universal Actions must call it over D-Bus, not copy it. |
| PermissionService | Per-action `permission` + confirm dialog + audit trail. | No central grants (allow once/session/always), no revocation UI, no per-capability model. |
| ProfileService | `control/src/profileLogic.ts`, `profiles.ts`: file format, validation, `extends`, backups, rollback, import/export. 4 built-in profiles. | Applied through the panel/CLI only; no shell-side trigger. |
| SettingsService | GSettings schemas + `scripts/control-panel-items.py` pipeline (224 items). | Structured data (workflows, snapshots, history) has no store yet. |
| EventBus | `island-daemon` D-Bus signals + property changes (`org.niro.island.Daemon`). | No shared bus for shell-side events (focus, monitors). |
| ContextService | `shell/island/src/appUsage.ts` (focused app stretches, idle pause) -> daemon. | No rule evaluation or recommendations. |
| NotificationService | `shell/island/src/notifications.ts` (island replaces banners; DND is GNOME's own). | No grouping, filters, history. |
| ClipboardService | daemon `clipboard.rs` (20 unpinned + 10 pinned, thumbnails) + island `clipboard.ts`/`clipRules.ts` + Search `clip`. | No transforms, expiry or sensitive filtering found in `clipboard.rs`. |
| DeviceService | Niro Device code (out of scope by user decision). | n/a |
| PerformanceService | island `pages/system.ts` (stats). | No history, process view or export. |
| BackupService | profile backups; `docs/RECOVERY.md`; GTK adapter backups. | No whole-configuration backup. |
| WorkspaceService/WindowService | `shell/tile` (pure `layouts.js`, `config.js`), Search `layout save/restore`, `sessionRestore.ts`. | No window groups, no rules engine. |

## 3. Existing capability / feature gap matrix (30 initiatives)

Status vocabulary: Existing, Partial, Not Implemented, Requires Research, Blocked by Platform, Requires User Approval.

| # | Initiative | Pri | Status | What exists (evidence) | Gap |
|---|---|---|---|---|---|
| 1 | Appearance Studio | P0 | Partial | Panel Look/Dock/Windows with live previews (`control/src/previews.ts`, `pages.ts`); Universal Appearance presets and per-app rules; profiles with rollback | One editor with Apply/Cancel/Before-After transaction; island sizing and layout |
| 2 | Theme Engine | P1 | Partial | light/dark/system, tone/accent, Universal Appearance, schedule (`themeSchedule.ts`, 1.5.6) | Wallpaper accent, token palette, transitions |
| 3 | Motion Studio | P1 | Partial | dock animation/magnification keys, `island/src/spring.ts` | Central MotionRegistry, presets, reduced-motion across components |
| 4 | Panel Builder | P1 | Not Implemented | `barHider.ts` only hides GNOME's bar | Whole feature; Requires Research (actor lifecycle, struts) |
| 5 | Widget Studio | P1 | Partial | island pages (system, calendar, world clocks, timer, clips) | Free-standing desktop widgets, drag/resize/grid |
| 6 | Gesture Studio | P1 | Requires Research | none | Which Shell gestures can be observed on Wayland without taking over system ones |
| 7 | Workspace Engine | P0 | Partial | Tile: 10 layouts, per-workspace and per-monitor `layout-map`, rules, switcher; Search `layout save/restore` | Window groups, spiral, workspace memory UI, split-ratio persistence |
| 8 | Window Rules Studio | P0 | Partial | Tile per-app rules (float/tile/workspace); blur per-app rules (vendored) | One declarative engine with conditions (title, time, profile), dry-run, conflict detection |
| 9 | Session Time Machine | P2 | Partial | `sessionRestore.ts` reopens apps with workspace/monitor/place at login | Snapshots, history, compare, selective restore |
| 10 | Universal PiP | P2 | Requires Research | `window.above.toggle` (keep on top) | A shrunken interactive window; `Clutter.Clone` is not interactive |
| 11 | Adaptive Desktop | P0 | Partial | 4 built-in profiles, `focusMode.ts`, `appUsage.ts`, schedules; **S1 (this branch): suggestion by focused application** | Rules beyond the focused app (power, monitors, calendar), user-defined rules, execution history |
| 12 | Multi-Monitor Manager | P1 | Partial | per-monitor tile layouts; session restore keeps the monitor | Hotplug handling, monitor profiles; validate Mutter DisplayConfig access |
| 13 | Niro Flow | P0 | Not Implemented | ActionRegistry (43 actions), assistant runner (`tasks.rs`), Rust daemon | Everything: schema, engine, editor |
| 14 | AI Command Center | P1 | Partial | assistant in `crates/island-daemon/src/assistant/` (agent, brain, answer, providers) with the typed action gateway | A plan-preview step was not found by grep; read the assistant before scoping, and confirm a local-only mode |
| 15 | Smart Context Engine | P1 | Partial | `appUsage.ts` events | Signals, rules, recommendations, privacy controls |
| 16 | Macro Recorder | P1 | Requires Research | ActionRegistry could record semantic actions | Recording design; accessibility automation is out of reach without consent UX |
| 17 | Smart Clipboard | P1 | Partial | history (20 unpinned, 10 pinned, `clipboard.rs`), pin, thumbnails; Snip OCR | Transforms, expiry, sensitive-content filter: none found in `clipboard.rs` |
| 18 | Universal Actions | P1 | Partial | typed registry | Object descriptors and a contextual menu |
| 19 | Shelf 2.0 | P1 | Partial | `island-shelf`, `pages/shelf.ts` | Collections, expiry, batch actions |
| 20 | Notification Hub | P1 | Partial | `notifications.ts`, DND hours (1.5.7) | Grouping, filters, opt-in history |
| 21 | Smart Audio Router | P1 | Partial | `audio.ts` default output volume/mute/devices | Per-app streams, routing presets, rules |
| 22 | Universal HUD | P1 | Partial | island alerts for volume, battery, Bluetooth | Customisation (position, size, duration), brightness/mic/media HUDs |
| 23 | Quick Share | P2 | Requires User Approval | none | Network exposure and pairing design |
| 24 | Cross-device Bridge | P2 | Requires User Approval | none (Niro Device is excluded) | Evaluate KDE Connect/GSConnect first |
| 25 | Performance Center | P2 | Partial | island system page | History, processes, diagnostics export |
| 26 | Privacy Dashboard | P2 | Partial | `privacy.ts` (mic, camera, screen share, recording) | Overview, opt-in history |
| 27 | Permission Manager | P2 | Partial | per-action confirm + audit | Central grants, revocation, UI |
| 28 | Plugin SDK | P2 | Requires User Approval | none | Isolated host, manifest, permissions: design review first |
| 29 | Extension Compatibility Center | P2 | Partial | `compatPage.ts` covers application compatibility with Universal Appearance, not other extensions | Extension list (`Main.extensionManager`), conflict database |
| 30 | Backup & Restore Center | P2 | Partial | profile backups, recovery doc | Whole-configuration backup, manifest, restore preview |

Counts: Partial 21, Not Implemented 2, Requires Research 3, Requires User Approval 3, Existing 0, Blocked by Platform 0 (gesture and PiP may move there after research).

## 4. Technical feasibility notes

- Wayland: no `wmctrl`/`xdotool`; use `Meta.Window` APIs. Window-scoped work stays in the Shell process; long-lived logic goes to Rust.
- Gestures (6): do not assume 2-, 3- or 4-finger gestures can be intercepted. GNOME already owns 3-finger workspace swipes. Research first.
- PiP (10): a true interactive mini-window is a compositor feature; a clone is a preview only.
- Multi-monitor (12): changing display configuration needs the Mutter `DisplayConfig` D-Bus API (not files); validate on 46 and 51.
- Plugins (28): third-party code must not load into the Shell process; needs an isolated host (Rust) and a permission model first.
- Audio (21): per-app routing depends on PipeWire/WirePlumber; do not assume every stream can move.
- Secrets: use Secret Service, never GSettings, workflow exports or logs.

## 5. Dependency graph

```
ActionRegistry (exists, D-Bus) ─┬─> Niro Flow (13) ─┬─> Macro (16)
                                ├─> Universal Actions (18)
                                ├─> AI Command Center (14)
                                └─> Adaptive Desktop (11)
PermissionService (extend)  ───────> Flow, AI, Plugins (28), Device Bridge (24), Quick Share (23), Clipboard history
ProfileService (exists) ───────────> Adaptive Desktop (11), Backup (30), Appearance presets (1)
ContextService (from appUsage) ────> Adaptive Desktop (11), Smart Context (15)
Design tokens (1,2,3) ─────────────> Panel Builder (4), Widget Studio (5), HUD (22)
LayoutEngine (Tile) ───────────────> Workspace Engine (7), Rules (8), Session TM (9), Multi-Monitor (12)
```

## 6. Risk register

| Risk | Impact | Mitigation |
|---|---|---|
| 30 initiatives in one change | unreviewable regressions | vertical slices, each behind a setting that defaults off |
| Shell API differences 46 vs 51 | breakage on one distro | `compat.ts` helpers; headless run on the available shell; flag the untested version |
| Input/window observers | lag, privacy | opt-in, event-driven, no polling, removed on disable (lifecycle test) |
| Animation completion callbacks | infinite loops when animations are off (seen in the Downloads bar) | timers or one-shot transitions, never `onComplete` re-arming |
| Catalog coupling | every setting bumps counts in 5 tests + README | change the counts in one commit; keep the pipeline test green |
| Secrets in exports | leak | exclude by schema, test fixtures with fake non-key-shaped strings |
| Headless-only verification | false confidence | status labels below; Desktop UAT only after a real session |
| Unattended automation | accidental destructive actions | dry-run, timeouts, loop guards, `confirm` actions never auto-run |

## 7. Implementation plan

Slices ship one at a time, each: runnable, tested, disable-able, documented, with an honest verification label
(Implemented / Unit Verified / Integration Verified / Headless Verified / Desktop UAT Verified).

| Order | Slice | Why now |
|---|---|---|
| S1 | Adaptive Desktop, suggestion-first (11): pure evaluator + opt-in Search suggestion by focused app; applies a profile only on Enter | P0, reuses profiles and the registry, no background observers |
| S2 | Window Rules engine core (8): declarative rules, priority, stop-processing, dry-run, conflict detection over Tile rules | P0; foundation for 7, 9, 12 |
| S3 | Permission grants (27): central store, allow once/session/always, revoke, audit view | prerequisite for 13, 14, 28 |
| S4 | Flow engine core in Rust (13): schema, validator, scheduler, dry-run, loop guard; no UI yet | P0, largest; build on the registry over D-Bus |
| S5 | Motion presets (3) and theme tokens (2) | cheap, wide visual effect |
| S6 | Appearance Studio transaction (1): Apply/Cancel/Before-After on the Look page | P0 UI |
| S7+ | Workspace groups (7), Multi-monitor (12), Notification Hub (20), Audio per-app (21), Performance history (25), Backup (30) | by dependency |
| Research | Gesture (6), PiP (10), Macro (16): write a feasibility note before code | platform limits |
| Needs approval | Quick Share (23), Device Bridge (24), Plugin SDK (28): design review first | network exposure / third-party code |

Out of scope by the user's decision: everything about the Niro Device board and firmware.

## 8. Slice log

### S1: Adaptive Desktop, suggestion-first (11)

Status: Implemented. Unit Verified. Headless Verified (the path runs and the row is built; no JS error). Desktop UAT: not run (UAT row 66).

- New: `shell/search/adaptive.ts` (pure evaluator: signals, rules, priority, active-profile skip, 30-minute quiet time per rule), the opt-in setting `adaptive-suggestions` (default off, Search › Search Behaviour), a hook in `shell/search/extension.ts` (`_adaptiveSuggestion()` at palette open; one row, Enter applies through the existing `profile.apply` action).
- Design choices: no background listeners (the focused window is read once when Search opens), so nothing to clean up on disable; no change is made without Enter; a suggestion stays quiet for 30 minutes whether or not it was taken.
- Built-in rules: game launchers -> Gaming; code editors -> Deep Work; design and video tools -> Creative. There is no Meeting profile yet, so no meeting rule.
- Not done in this slice: power, monitor and calendar signals, user-defined rules, execution history, UI to edit rules, hysteresis (not needed while the signal is read only on demand).
- Settings count 224 -> 225 (catalog, 5 tests and README updated). `npm test` exit 0 (272 node tests, GJS 225 bindings), headless all passed.

### S2: Window Rules engine core (8)

Status: Implemented (core only). Unit Verified (9 tests in `tests/island/windowRules.test.js`). Not wired into the Tile extension, not Headless Verified, Desktop UAT not run.

- New: `shell/tile/windowRules.js`, pure and with no listeners or timers. Schema v1: `{id, enabled, priority, stop, conditions, actions}`. Conditions: appId, title (substring or a length-bounded `/regex/`), workspace, monitor, type, time range (may cross midnight), profile. Actions: workspace, monitor, tile (float/tile), above, opacity. Unknown keys are rejected, so no shell-command action can exist.
- `evaluate()` returns what would be done plus a per-rule trace (the dry-run view); it never touches a window. `pending()` drops what a window already satisfies, so a re-run is a no-op. `findConflicts()` reports overriding actions and rules shadowed by a `stop` rule, marked certain or possible. `createGuard()` limits a rule to N applications per window per time span. `fromLegacy()` turns v1.5 `window-rules` entries into vNext rules, so the existing setting keeps its meaning.
- Not done: the Tile extension still reads only the v1.5 `window-rules`; no setting, no Control Panel editor, no apply step for monitor, above or opacity, no title-change re-evaluation hook. 
- Update: wired into Tile behind the opt-in setting `rules-engine` (default off) with the rules in `advanced-rules`; applied once when a window is first seen (workspace, monitor, above, and `tile` float/tile in the eligibility check). Opacity is not applied. Headless Verified that the shell still runs cleanly; the rules path itself is **not** exercised headlessly (default off). Still missing: Control Panel editor, dry-run UI, profile capture of the new keys, title-change re-evaluation, `profile` condition value (Tile does not know the active profile yet).

### Cores added after S2 (pure, tested, **not yet wired into the shell or the panel**)

All are Implemented and Unit Verified only. None has Headless or Desktop UAT status, and none is reachable from the UI yet; that wiring is the next work for each.

| Slice | Initiative | Files | What it does |
|---|---|---|---|
| S3 | 27 Permission Manager | `shell/shared/permissions.js` | allow once/session/always/deny, revoke, minimal default (ask), bounded content-free history, only always/deny persisted |
| S4 | 13 Niro Flow | `crates/niro-flow` (new crate, in the workspace and default members) | versioned schema, validator (acyclic, step and delay caps, registered actions only, no shell step), condition evaluator, dry-run plan with secret redaction, executor callback, restart-safe ledger |
| S5 | 2, 3 Theme and Motion | `shell/shared/tokens.js` | motion presets, reduced-motion and per-component off (duration 0), WCAG contrast and a readable palette for any accent |
| S1b | 1 Appearance Studio | `shell/shared/transaction.js` | preview over a copy, cancel, before/after, commit with rollback, unsupported keys reported as unavailable |
| S9 | 9 Session Time Machine | `shell/shared/snapshot.js` | v1 to v2 migration, diff, honest restore plan (place / relaunch / unsupported), retention |
| S17 | 17 Smart Clipboard | `shell/shared/clipboardTools.js` | case, strip formatting, JSON, URL cleanup, sensitive-content detection, expiry, prune |
| S20 | 20 Notification Hub | `shell/shared/notificationRules.js` | rules, profile rules, quiet hours, snooze, critical never hidden, metadata-only history |
| S25 | 25 Performance Center | `shell/shared/perfHistory.js` | bounded history, adaptive interval (no polling when hidden), numbers-only diagnostics, processes without command lines |
| S29 | 29 Extension Compatibility | `shell/shared/extensionConflicts.js` | conflict rules with reason and confidence, false-positive ignore, shortcut clashes; reports only, never disables |
| S30 | 30 Backup & Restore | `shell/shared/backup.js` | versioned manifest, secrets skipped and stripped, checksum verify, v1 migration, restore preview |

Verification at this point: `npm test` exit 0 (299 node tests); headless shell all passed; `cargo test -p island-core -p island-daemon -p niro-flow` exit 0 (85 + 435 + 8); biome and clippy unchanged from baseline (clippy clean for niro-flow). Not run: Desktop UAT, GNOME 46 or Ubuntu (only the local Shell was available).

### Cores by the context/groups/monitor agent

Implemented and Unit Verified only (32 tests, `node --test tests/island/contextEngine.test.js tests/island/windowGroups.test.js tests/island/monitorManager.test.js`, exit 0). **Not wired into the shell, the panel or any setting; no Headless or Desktop UAT.** All three are pure and have no timers, listeners or GNOME imports.

| Initiative | File | What it does |
|---|---|---|
| 11, 15 Context engine | `shell/shared/contextEngine.js` | signals to snapshot to rules to a suggestion with an explanation, always `autoApply: false`; N-evaluation and dwell hysteresis, battery release threshold, cooldown, minimum confidence, mode lock, manual override, per-source enable flags, bounded metadata-only history that can be cleared |
| 7.4, 7.5 Window groups | `shell/shared/windowGroups.js` | groups (create, rename, add, remove, delete), move and restore as plans, workspace layout capture and restore plan; matching by app id and title with refusal on ambiguity; vanished windows and monitors are reported, rects clamped on screen |
| 12 Monitor manager | `shell/shared/monitorManager.js` | identity (connector, vendor, product, serial hash; no raw serial), profiles keyed by the monitor set, hotplug diff, fallback plan to the primary, restore plan when a monitor returns, logical size = physical / scale; plans only, no display configuration is written |

Limits: no signal collection (the shell must supply app, battery, monitors, calendar), no UI, no persistence, and no Mutter DisplayConfig access. The serial hash is a 32-bit FNV hash for stable keys, not a security boundary.

### niro-flow additions

Implemented and Unit Verified only (`cargo test -p niro-flow --offline`, 35 tests; clippy clean). Still `serde` + `serde_json` only; no threads, clock or I/O inside the crate.

- `triggers.rs`: `EventKind` / `Event` (app focused or launched, workspace, monitor, battery with previous reading, AC, tick, network, profile, manual) and `matching(workflows, event)`. Disabled workflows never match; app names compare case-insensitively (a `.desktop` suffix is ignored); battery fires only on the downward crossing (no previous reading means no fire); a schedule fires when its minute falls after the previous tick up to the current one, so a skipped tick does not lose it.
- `scheduler.rs`: `Scheduler::on_event(workflows, event, now_ms) -> Vec<Job>` with a per-workflow cooldown, a global concurrency cap, one run at a time per workflow, event-id dedup through `Ledger` (key = workflow id + event id; a schedule uses workflow id + day, so it runs once a day), a loop window (at most N starts per window), and refusal to re-trigger a workflow from an event tagged with its own id. Jobs carry a deadline and a shared cancel flag; `check`, `reap_expired`, `cancel`, `stop_all` / `resume`. Skips are reported with a reason through `take_skips`. An event is decided once: a skipped event stays claimed in the ledger.
- `history.rs`: bounded `ExecutionHistory` (start, steps, finish, fail, cancelled), arguments redacted with `redact()` before storing, JSON round trip (a run left "running" by a crash is closed as an error on load), `clear()`.
- `permissions.rs`: `Capability`, `capability_for(action)` by prefix (`app.` launch, `window.` / `layout.` window, `clipboard.`, `notify`, `net.` / `url.` network, plus `profile.` / `dnd.` settings; anything else is denied), the `PermissionEvaluator` trait, `StaticPolicy`, and `run_checked`, which asks before each action and makes a refusal the step error without calling `act`.
- `templates.rs`: four JSON templates (coding focus, low battery saver, meeting mode, evening wind down), all shipped disabled and validated against `TEMPLATE_ACTIONS`.

Not wired: there is no D-Bus service and no daemon integration. Nothing produces `Event`s, persists the ledger or history, runs jobs, enforces deadlines on a running step (the run loop must call `check` itself), or shows a permission prompt. No Control Panel or shell UI exists for any of it, and no Headless or Desktop UAT has been run. The registry action names in `TEMPLATE_ACTIONS` are assumed, not read from the real registry.

### Cores by the audio/HUD/privacy/shelf agent

Pure, tested, **not wired into the shell, daemon or panel** (Unit Verified only; no Headless or Desktop UAT status). They plan and model; they run nothing.

| Initiative | File | What it does |
|---|---|---|
| 21 Smart Audio Router | `shell/shared/audioRouter.js` | parses `pactl -f json list sinks/sources/sink-inputs` and `wpctl status`; per-app volume/mute plan (argv arrays, no boost unless allowed); presets; app -> sink rules with target-missing/unavailable/conflict reporting; loop guard; disconnect fallback. Never emits `set-default-*` unless `allowDefaultChange` and the default itself vanished. |
| 22 Universal HUD | `shell/shared/hud.js` | OverlayManager core: 9 kinds, normalized config, same-kind dedupe (update, not stack), queue with max visible, urgent replace, `suppressNative` for the GNOME OSD kinds, reduced motion => 0 durations via `createMotion`, expiry from a passed clock, `clickThrough` always true. |
| 26 Privacy Dashboard | `shell/shared/privacy.js` | indicators with supported/unsupported + explanation (unsupported => state `unknown`, never "inactive"), opt-in bounded history (off by default, cleared when turned off), permission overview from a plain input. |
| 19 Shelf 2.0 | `shell/shared/shelfCollections.js` | collections of references (file, url, text, image), rename, pin, temporary collections with expiry, search, batch move/copy/remove plan (any other op rejected; originals never touched), snippet byte quota, cleanup policy, import of the current flat shelf. |

Tests: `tests/island/{audioRouter,hud,privacy,shelfCollections}.test.js`. Research note for 6, 10 and 16: `docs/research/gesture-pip-macro.md`.
Limits: `pactl` argv is data only (a caller must execute it, with the existing ordering/permission rules); `wpctl status` does not show a stream's sink, so routing needs pactl; port availability strings are localised, so only an English "no" marks a device unavailable.

### Cores by the planner/macro/plugin/widget agent

Pure ES modules in `shell/shared/`, Implemented and Unit Verified only (`node --test` on the four test files). **None is wired into the shell, the panel, the assistant daemon or any setting.** No plugin code is loaded anywhere, no network call is made, and nothing here schedules a timer.

| Initiative | Files | What it does |
|---|---|---|
| 14 AI Command Center | `shell/shared/commandPlanner.js` | typed plan `{steps:[{action,args}]}` checked against a catalog `[{id, params, permission}]` (same arg rules as `validateArgs`, step cap 8); preview text; `needsConfirmation` (any non-`none` action, or a capability without an always/session grant); local rule-based parser for Indonesian and English that maps only onto catalog actions, else `{unknown:true}`; undo descriptors; partial-failure report; `redactForProvider` and `buildProviderPrompt` (catalog ids/params and the redacted text only, context only when passed explicitly); provider replies are re-validated |
| 16 Macro Recorder | `shell/shared/macro.js` | records action ids and arguments only; refuses flagged, password-like and credential-looking steps; insert/remove/move/set delay; playback plan with loops capped at 20 and a total duration cap; stop flag; validated JSON import/export; shortcut validation against reserved accelerators |
| 28 Plugin SDK | `shell/shared/pluginManifest.js` | manifest validation (reverse-DNS id, semver, apiVersion, capabilities from `permissions.js`, reasons for risky ones, entryPoint without `..`, absolute paths or schemes, dependencies), API compatibility, `authorize`, uninstall plan; the isolated host is still a design-review item |
| 5 Desktop Widgets | `shell/shared/widgetRegistry.js` | widget manifests, a hub that shares one schedule per provider (`due(now)`, nothing due when all are hidden), grid snap and size clamp, window overlap report, versioned layout persistence, error isolation |

Limits: the local parser is a small phrase table, not language understanding; `app.launch` receives the spoken name, so the caller must resolve it to a desktop id; `window.move-to-workspace` does not exist in the registry yet, so that phrase is `unknown` against today's catalog. The credential detector is heuristic (it also redacts e-mail addresses and long opaque strings) and is a guard, not a guarantee. Not run: any Shell, daemon or Desktop UAT.

### Verification after the parallel batch

`npm test` exit 0 (401 node tests, GJS suites ok); headless shell all passed (47 actions, no JS error); `cargo test -p island-core -p island-daemon -p niro-flow` exit 0 (85 + 435 + 35); clippy clean for niro-flow; biome 1 old warning. Wired and reachable: Tile advanced rules (setting + Tiling page editor + `niro-tile rules`), four Search actions. Every other core in `shell/shared/` and `crates/niro-flow` is Unit Verified only and not yet wired. Desktop UAT: not run. GNOME 46 / Ubuntu: not tested.

## Integration Audit (Integrated Desktop Alpha, step 1)

Evidence: grep of real importers outside tests and `shell/shared` itself; HEAD `27cd0d1`, 51 changed paths, nothing committed. The machine runs a live GNOME Shell 51.1 Wayland session (the user's own desktop, with `tile@niro.local` and `tiling-assistant@ubuntu.com` both enabled). Desktop UAT on it changes the user's working session, so it is Not Executed until that is agreed; headless (nested shell) is the only place changes are exercised.

Status vocabulary: Core Only, UI Only, Partially Wired, Runtime Integrated, End-to-End Verified, Desktop UAT Verified, Blocked by Platform, Not Implemented.

| # | Feature | Core | UI | Runtime | E2E | Desktop UAT | Blocker / note |
|---|---|---|---|---|---|---|---|
| 1 | Appearance Studio | transaction.js | existing Look/Dock pages only | none | no | no | Core Only; no consumer of the transaction |
| 2 | Theme Engine | tokens.js (`deriveAccent`) | no | island and dock derived accent colours (niroSync.ts) | no | no | Partially Wired; see the shell wave below |
| 3 | Motion Studio | tokens.js (`scaleDuration`) | Appearance Studio (Dock) | island fades and slides via `motion-preset`; Dock via `animation-duration` | motion mode | no | Partially Wired; see the shell wave below |
| 4 | Panel Builder | none | none | none | no | no | Not Implemented |
| 5 | Widget Studio | widgetRegistry.js | none (Search results) | Search `widgets.list` / `widgets.show`, opt-in `widgets-in-search` | no | no | Partially Wired; Search text only. Free-standing desktop widgets: Not Implemented, needs a desktop-widget surface design |
| 6 | Gesture Studio | note only | none | none | no | no | Research note; Not Implemented |
| 7 | Workspace Engine | windowGroups.js; Tile existing | Tile pages (existing) | Tile existing; groups none | no | no | Groups Core Only |
| 8 | Window Rules | windowRules.js | Tiling page editor, `niro-tile rules` | Tile `rules-engine` (default off) | headless: shell still clean; rules path not exercised | no | Partially Wired; `profile` condition cannot match, opacity not applied |
| 9 | Session Time Machine | snapshot.js | none | none | no | no | Core Only (existing sessionRestore.ts is separate) |
| 10 | Universal PiP | none | none | none | no | no | Research note; Not Implemented |
| 11 | Adaptive Desktop | adaptive.ts, contextEngine.js | Search setting `adaptive-suggestions` | Search, read once on open | headless yes | no | Partially Wired (S1 only; contextEngine.js unused) |
| 12 | Multi-Monitor | monitorManager.js | none | none | no | no | Core Only; DisplayConfig access unvalidated |
| 13 | Niro Flow | niro-flow crate | none | none (not a dependency of any crate; no D-Bus) | no | no | Core Only |
| 14 | AI Command Center | commandPlanner.js | none | none | no | no | Core Only; existing assistant is separate |
| 15 | Smart Context | contextEngine.js | none | none | no | no | Core Only |
| 16 | Macro Recorder | macro.js | none | none | no | no | Core Only |
| 17 | Smart Clipboard | clipboardTools.js | none | Search actions text.transform, url.clean, clipboard.sensitive.check | headless: load only | no | Partially Wired; no expiry/filter in daemon history |
| 18 | Universal Actions | none | none | none | no | no | Not Implemented |
| 19 | Shelf 2.0 | shelfCollections.js | none | none | no | no | Core Only |
| 20 | Notification Hub | notificationRules.js | none | none | no | no | Core Only |
| 21 | Audio Router | audioRouter.js | none | none | no | no | Core Only |
| 22 | Universal HUD | hud.js | none | none | no | no | Core Only |
| 23 | Quick Share | none | none | none | no | no | Not Implemented; needs design approval |
| 24 | Device Bridge | none | none | none | no | no | Not Implemented; needs design approval |
| 25 | Performance Center | perfHistory.js | none | none | no | no | Core Only |
| 26 | Privacy Dashboard | privacy.js (existing privacy.ts is a different, older module) | none | none | no | no | Core Only |
| 27 | Permission Manager | permissions.js | none | none (Search keeps its own confirm model) | no | no | Core Only |
| 28 | Plugin SDK | pluginManifest.js | none | none | no | no | Core Only; no host |
| 29 | Extension Compatibility | extensionConflicts.js | none | Search action extensions.check | headless: load only | no | Partially Wired; database lacks `tiling-assistant@ubuntu.com`, which is enabled next to Tile on this machine |
| 30 | Backup & Restore | backup.js | none | none | no | no | Core Only |

Summary: Runtime Integrated 0, Partially Wired 5 (8, 11, 17, 29, and 7 through Tile), Core Only 19, Not Implemented 4 (4, 18, 23, 24), research only 2 (6, 10). End-to-End Verified 0. Desktop UAT Verified 0.
Packaging: `shell/shared/*.js` is copied by `npm run build` (to `shell/search/build/shared` and `control/build/shared`), by `packaging/build.sh` and by `tests/shell/stage.sh`; a deb or rpm build was not run here.

### Appearance Studio integration (agent)

Scope: rows 1 (Appearance Studio), 2 (Theme Engine, accent and palette only) and 3 (Motion Studio, Dock only). Files: `control/src/appearanceLogic.ts` (pure), `control/src/appearanceStudio.ts` (page), registered in `control/src/window.ts` as the module "Appearance Studio" (after Look; the sidebar is flat, so no group heading was added and no page was removed) and linked from Home. Tests: `tests/island/appearanceLogic.test.js` (13 node tests) and `tests/gjs/appearanceStudio.test.js` (not yet listed in `tests/gjs/run.sh`, which was out of scope; one line is needed there).

What the page does today (statuses use the vocabulary above):

| Item | Status | Evidence |
|---|---|---|
| Draft over existing keys (Dock, Island, Windows, Panel look), previews of the draft, Before/After | Runtime Integrated in the Control Panel | gjs test: a draft writes nothing, Cancel leaves GSettings untouched, controls follow Cancel/Reset |
| Apply = `beginTransaction().commit(write)` + read-back of every written key | Runtime Integrated | gjs test: Apply persists (dock icon size, border radius), a throwing write rolls the earlier write back, a write that silently does not stick is caught by the read-back and rolled back |
| Restore previous, Reset (both only fill the draft) | Runtime Integrated | gjs test |
| Unavailable key (no binding, e.g. the extension is not installed) | Runtime Integrated | shown as an insensitive row "Unavailable: ...", refused by `set`, never written; all keys missing gives the disabled page |
| Accent contrast: accent is checked against the surface tint (3:1), moved and explained if unreadable, `#RRGGBB` enforced; a tint that swallows the accent moves the accent | Runtime Integrated (as a draft rule; the Look page and Dock page still write the accent directly, without this check) | node + gjs tests |
| Palette view from `buildPalette` on a dark and a light surface with a ratio per token | UI Only for the palette itself: the tokens are displayed, no other part of the desktop consumes `buildPalette` | gjs builds it; not looked at on a screen |
| Motion presets Minimal/Smooth/Dynamic/Cinematic (+ a one-off "Reduced motion" switch, default from GNOME's animations switch) written to `dock.animation-duration` and `dock.bounce-on-launch` | Partially Wired: only the Dock has such keys | gjs test: Cinematic gives 400 ms, reduced gives 0 ms and no bounce, nothing is written before Apply |
| Island, Windows, Control panel motion | Not Implemented: no animation key exists for the island (it only follows the system switch); Tile has `tile.animate` (on/off, no duration, not touched); the panel crossfade follows the system switch | stated on the page ("Who uses motion today") |

States: loading, ready, disabled, error, applying, success, rollback exist in the logic and are rendered. Honest limits: `loading` is only the pre-load state, since the settings are read synchronously when the page is built (it is not visible in practice); `applying` is also synchronous, so it is recorded in the state history and shown only if a write blocks. Keyboard: Ctrl+Enter applies, Esc drops the draft, the picker is linked toggle buttons, every control has an accessible label. Listener hygiene: the page subscribes once per key it edits, keeps the unsubscribe functions and runs them in `dispose()` (called on the window's close-request and on the page's `destroy` signal); the gjs test counts subscriptions before and after and they match. The `destroy` signal path itself was not exercised, only `dispose()`.

Not verified: the page was NOT looked at on a real display (no nested or headless display was available here; the gjs tests build the widgets against the session's display connection with a memory settings backend and never present a window). Layout, spacing, the preview drawings under the draft, and the colour swatches are therefore unreviewed visually. Not run: full `npm test`, `npm run build` (only `npx tsc -p control`), a deb or rpm build. Desktop UAT: Not Executed. No new GSettings key was needed and none was added; the Dock opacity, background and blur stay managed by Look and are only referenced as a note.

### Flow runtime (integration agent)

Status: **Partially Wired**, with one live end-to-end check on a private bus (see below). Not Desktop UAT Verified. No UI exists yet, and nothing in `shell/` or `control/` calls it, so a user cannot reach Flow from the desktop today.

What exists (crate `niro-flow`, module `crates/island-daemon/src/flow/`):
- `niro-flow` is now a dependency of `island-daemon`. New in the crate: `Stepper` (one step at a time, so the daemon can await), `Workflow.allow`, `AllowListPolicy`, and `capability_for` mapping for the real registry ids (`system.dnd.toggle`, `layout.restore`, ...). Templates were rewritten to real ids and arguments (`profile.apply {id}`, `layout.restore {name}`); a test checks them against `shell/search/actions.ts`. The old `notify` and `dnd.set` ids do not exist in Search, and there is no idempotent "set DND" action (only `system.dnd.toggle`), so templates no longer use either.
- D-Bus `org.niro.Flow1` at `/org/niro/island/Daemon` on `org.niro.island.Daemon` (same object as the other interfaces). Properties `ApiVersion` (1) and `Enabled`. Methods: `List`, `Get`, `Save`, `Delete`, `SetEnabled`, `DryRun`, `RunNow`, `Cancel`, `History`, `ClearHistory`, `Templates`, `KnownActions`, plus `SetGlobalEnabled(b)` and `Reload()`. Signals `WorkflowStarted/Completed/Failed(id, run_id, message)`. `Save` returns one struct `(bs)`: saved flag and a JSON array of problems.
- Storage: `~/.config/niro/flow/workflows/<id>.json` (0600, atomic write, validated on load; a bad file is listed under `problems` and skipped). Ledger and history: `~/.local/state/niro/flow/{ledger,history}.json`. The ledger is written before a run starts, so a replayed event does not run twice; a run cut off by a restart is recorded as an error "interrupted by a restart".
- Switch, off by default: env `NIRO_FLOW_ENABLED` (1/0/true/false/on/off) wins, else the file `~/.config/niro/flow/flow.enabled`, else off. `SetGlobalEnabled` writes that file. Off means: no timer exists, events are dropped, `RunNow` refuses, runs in flight are cancelled. The GSettings key requested for the control panel to mirror is `flow-enabled` (boolean, default false) in `org.niro.control`; nothing reads it yet, and the daemon does not link GSettings.
- Execution only through Search `ListActions`/`RunAction` over D-Bus. Per action step: the workflow's own `allow` list (capability label or exact action id; default deny; never asks) -> action must be in the registry list -> a registry action with `permission != none` is not run (the run stops with "needs confirmation") -> `available` -> arguments checked as Search checks them. Actions without a capability (power, session, `process.kill`, `file.open`, `ha.call`, trash) are never run. `Save` refuses a workflow with any of these, and refuses to save at all while Search is not reachable (it cannot check names).
- Event sources: schedule (a minute timer armed only while Flow is on and an enabled workflow has a `schedule` trigger), battery level and AC (UPower via the system state), network (NetworkManager via the system state), focused app, manual. Focus comes from the shell's app-usage `Report`, which is batched about once a minute, so "app focused" fires up to about a minute late, and only for stretches that ended in the last two minutes. Not wired: workspace, monitor, profile changes, "app launched" (no source in the daemon).
- CLI: `island-daemon --flow status|list|templates|actions|dry-run ID [VARS]|history [ID]|enable|disable`. It reads the same files and never runs an action.

Verification:
- Unit and integration tests (fake registry, no bus): store, validation against the registry, default deny, confirm-stop, focus/battery/network/schedule event -> job -> run, restart replay (ledger), interrupted-run record, cancel, timeout, delay, switch off cancels and disarms the timer, dry run, templates.
- Live, private bus: `dbus-run-session -- scratchpad/live.sh` started `island-daemon` (with `NIRO_FLOW_ENABLED=1` and private XDG dirs) beside a fake `org.niro.Search` (python, `ListActions` and `RunAction`), then used `busctl --user call ... org.niro.Flow1`. Observed: `Save` accepted a valid workflow and refused one using a confirm action; `DryRun` printed the plan; `RunNow` made the fake Search receive `profile.apply {"id":"deep-work"}` and `History` showed status ok; a workflow with no `allow` list failed with "permission denied" and the fake received nothing more; `WorkflowStarted/Completed/Failed` signals were seen on the bus monitor; `SetGlobalEnabled(false)` made `RunNow` refuse. This used a fake Search, not the real Shell extension, and the focus, battery and schedule sources were not driven live (unit-tested only). So this section does not claim End-to-End Verified for the real desktop.

Limitations: no UI; runs wait for Search (not available before the shell is up); one Flow `RunNow` per workflow per 5 s (scheduler cooldown); `Enabled` and workflow files are read at start and on `Reload`, not watched; any process of the same user on the session bus may call `org.niro.Flow1` (same trust level as `org.niro.Search`), but a workflow can only do what its own `allow` list names and what Search runs without a confirmation.

### Workspace integration (agent)

Scope: window groups (#7), session snapshots (#9) and multi-monitor recovery (#12) wired into the real Tile extension (`shell/tile`) and its panel. Nothing was run against the user's live session; every shell check below used a nested headless GNOME Shell with real GTK windows.

What was built
- `shell/tile/workspace.js`: the glue, plain JS with no GNOME imports (cores and shell reached through injected `core` and `host`), so it runs under node and in the shell. `shell/tile/extension.js` supplies the real host (windows, monitors via the monitor manager's connector/vendor/product/serial, workspaces, `Gio.AppInfo` launch, JSON files under `~/.config/niro/`).
- Tile imports the cores at run time from `./shared/windowGroups.js`, `snapshot.js`, `monitorManager.js` (top-level `await import` in a try). If they are not installed next to Tile, Tile still tiles and the new methods answer `{ok:false, error:"... not installed"}`. The package must copy them (see the lines below).
- D-Bus on `org.niro.Tile` (all JSON in and out, every answer carries `api: 1` and `ok`): `GetWorkspaceApi`, `GroupsCall(op, argsJson)` with ops list, create, add, remove, rename, delete, remember, activate, restore; `SnapshotsCall(op, argsJson)` with ops take, list, delete, pin, diff, plan, restore, launch, retain; `MonitorStatus`. The panel backend refuses a shell that speaks another `api` and tells an older Tile (no such method) apart from one that is not running.
- Persistence: `~/.config/niro/tile-groups.json` and `tile-snapshots.json` (not GSettings). Groups are re-read on every call (no cache to go stale).
- Setting `monitor-recovery` (bool, default false) in the Tile schema, switch in the Tiling page's Monitors section and `niro-tile monitors recovery on|off`. It is not part of a profile.
- Panel: Tiling page sections `Groups` and `Snapshots`; CLI `niro-tile groups ...`, `niro-tile snapshots ...`, `niro-tile monitors [status|recovery on|off]`; `doctor` gains a "groups and snapshots available" check when the shell runs.

Behaviour that matters
- Groups match windows by app id plus title (core `matchWindow`); ambiguous matches are skipped, never guessed. A closed window is listed as closed, not an error. Activate moves open members to the group's stored place (workspace and monitor identity key), switches to its workspace and focuses the first member; a stored monitor that is not connected is dropped with a note. A group's place is set by its first window and by `remember`.
- Snapshots store workspace (1-based, 0 = on all) and monitor index per window. `restore` without `confirm` is only a preview. With it, only `place` items for windows that are running are moved (workspace and monitor; the rectangle is not restored, tiling or the window decides). Nothing is closed. `relaunch` items are listed and started only by `launch` for an app id that the snapshot itself would relaunch, resolved to a desktop entry whose id matches case-insensitively; no entry is a reported failure. Partial failures are returned per window. The result always carries the note that app-internal state is neither saved nor restored. `take` applies `retain` (20 newest, 30 days, pinned kept).
- Monitor recovery: off, `monitors-changed` only keeps the monitor list current. On, windows are remembered while the monitors are steady (`noteWindows` after each retile, skipped while a change is pending, because mutter itself relocates windows when a monitor goes), those of a vanished monitor are moved to the primary and clamped, and moved back to their remembered place when the same monitor (matched by key, or by hardware on another port) returns. The listener is in Tile's `_signals`, removed on disable; the service is dropped on disable. No DisplayConfig call of any kind is made (reads of identity use the backend monitor manager only).

Status (honest)
| Feature | Status |
|---|---|
| Groups (7) | Runtime Integrated; End-to-End Verified in a nested shell with real windows (create, add, activate moves a real window across workspaces, closed window, rename, preview moves nothing). Desktop UAT: Not Executed. |
| Snapshots (9) | Runtime Integrated; End-to-End Verified nested (take, diff, plan, preview, confirmed restore moves a real window, closed app listed for relaunch and not started by restore, launch of an app without a desktop entry reported). A successful launch of a real desktop app was only unit-tested with a fake host: Partially verified. Desktop UAT: Not Executed. |
| Monitor recovery (12) | Runtime Integrated; behaviour verified in a nested shell with two virtual monitors and a real window, but the hotplug is simulated (layout manager's monitor list cut and `monitors-changed` emitted). A real DisplayConfig hotplug, a different primary, scale changes and a monitor returning on a different port were not exercised in the shell (the port case is unit-tested in the core). Profiles (`saveProfile`/`findProfile`/`profileDrift`) are not wired: Core Only. |
| Packaging | Not verified: depends on the copy lines below. |

Tests added or extended
- node: `tests/island/tileWorkspace.test.js` (14 tests, fake host, failure paths).
- gjs: `tests/gjs/tileFakeShell.js` (real workspace service behind the backend's transport), `tests/gjs/tileBackend.test.js` and `tests/gjs/tilingPage.test.js` extended (offline reading, API version and old-Tile messages, panel driving of Groups, Snapshots, the recovery switch, confirm dialogs, Start button).
- shell: `tests/shell/tileWorkspace.sh` (38 checks over `org.niro.Tile` in a nested shell; run with `tests/shell/run-staged.sh tileWorkspace`; it copies the three cores into the staged Tile when they are missing). It is not in the default list of `run-staged.sh`, and `tests/gjs/run.sh` already runs the two extended gjs tests.

Limitations
- Window ids are shell ids that change between sessions; group members survive a restart by app id and title only. Windows with no app id are matched by title alone and may be skipped as ambiguous.
- A window's rectangle is not restored by snapshots; groups move windows between workspaces and monitors, not to coordinates (monitor recovery does place coordinates for the windows it moves). Maximized and fullscreen windows are moved to a monitor but not resized.
- The remembered displaced windows of monitor recovery live in memory only; they are lost when the shell restarts.
- From a terminal `niro-tile groups create|add` without `--window` uses the shell's focused window, which is usually the terminal's own, so pass `--window ID` (ids are in `niro-tile state`). The panel always sends explicit ids.
- Any process of the same user on the session bus can call these methods (same trust as the existing Tile methods); none of them closes a window or runs a command, and `launch` only starts desktop entries named by a stored snapshot.
- Shell 51.1 was used; the monitor-manager calls (`get_logical_monitors`, `get_monitors`, connector/vendor/product/serial) were seen working on it only. They are wrapped so a missing one falls back to an index-based identity.

### Search runtime integration (agent)

Scope: the Search extension (`search@niro.local`) is now the runtime for the permission service, the adaptive context engine, the command planner and the macro player. Everything below is staged-nested-shell evidence (`tests/shell/run-staged.sh headless`, GNOME Shell 51.1 headless, `GSETTINGS_BACKEND=memory`); nothing was exercised in the user's live session (Desktop UAT: Not Executed).

What was wired
- Permissions (27): `shell/search/capabilities.ts` maps every Search action id to a capability of `shell/shared/permissions.js` (unknown ids fall back to `automation`, never to "free"; a node test fails when an action is registered without a table entry). `_run`/`_dispatch` in `shell/search/extension.ts` asks the gate for external (D-Bus) callers only, as a layer before the registry's own per-action confirm, only when `permissions-enforced` is on. The caller is its process name (`/proc/PID/comm`). Unanswered questions are denied. Grants live in `~/.config/niro-control/permissions.json` (only `always` and `deny` are written; a hand-edited file cannot grant `once` or an unknown capability). New D-Bus methods on `org.niro.Search`: `ListGrants`, `Grant`, `Revoke`, `PermissionHistory`, `ClearPermissionHistory`. A revoke is enforced by the next call (no cache). `Grant` with scope `deny` is taken as it comes; any scope that gives more access needs a yes on screen (otherwise any program could grant itself everything). History holds subject, capability, verdict, time; never arguments.
- Adaptive (11, 15): `shell/search/adaptive.ts` now evaluates through `shell/shared/contextEngine.js`; the old `suggest()`/`matches()` API and its tests are unchanged. Rules: built-ins plus `~/.config/niro-control/adaptive-rules.json` (validated; a bad rule is reported by `adaptive.history`, never half-used; a rule with a built-in's id replaces it, `enabled:false` switches it off). Signals are read when the palette opens: focused app, time, monitors, workspace and battery/mains from `/sys/class/power_supply`. The suggestion row is "Switch to X?" (Enter accepts) plus a "Not now" row (`adaptive.dismiss`); accept and dismiss are recorded; `adaptive.history` shows them; `adaptive.lock` locks or unlocks; choosing a profile by hand (`profile.apply` from Search or D-Bus) starts a one-hour override. `adaptive-live` (opt-in, needs `adaptive-suggestions`) adds two listeners (focus-window, monitors-changed) with a 1.5 s debounce; they are removed when the setting turns off and in `disable()`.
- Planner and macros (14, 16): `shell/search/runtime.ts` registers `plan.preview` (parse + validate + readable preview, runs nothing), `plan.run` (confirm showing the steps; each step through `_dispatch`, i.e. the same registry, confirm and permission gate; stops at the first failure and reports done/failed/not-run and what could be undone), `macro.list`, `macro.save` (added; without it a macro could only be written by hand), `macro.play` (confirm; loop cap 20 and 600 s from macro.js; delays are waited in 250 ms slices), `macro.stop`. Macros are stored in `~/.config/niro-control/macros.json`; sensitive steps are refused on save and again on play (the file is untrusted); a plan or macro cannot start another plan or macro. `plan.run` only understands what `commandPlanner.localParse` understands (fixed phrases); no provider/AI path is wired.
- Extension Compatibility (29): `tiling-assistant@ubuntu.com` added. Proven bug found on the way: every rule matched Niro's own extensions by the prefix `niro-dock`, `niro-tile`..., but the installed uuids are `dock@niro.local`, `tile@niro.local`..., so no conflict could ever be reported on a real install. `ours` is now a prefix or a list of prefixes (old form still works). Test: `tile@niro.local` + enabled `tiling-assistant@ubuntu.com` reports `tiling-overlap`.

Settings added (catalog 225 -> 227 by this work, now 230 because the Tile agent added `rules-engine`, `advanced-rules` and `monitor-recovery` meanwhile; Search menu 24 -> 26, Windows 42 -> 45; the total moves whenever another agent adds a setting, the pipeline assertion and the five count tests must then be bumped together)
- `permissions-enforced` (boolean, default false; Search > Search Behaviour; consumer `_permit`; node + headless tests).
- `adaptive-live` (boolean, default false; shown disabled unless `adaptive-suggestions` is on; consumer `_syncLive`; headless test of listeners on/off).
- Updated consistently: schema, `scripts/control-panel-items.py` (pipeline run, assertion 230), `control/src/catalog.ts`, `shell/search/settings-index.ts`, `docs/control-panel-items.{md,csv}`, README (230), `tests/gjs/controlUi.test.js`, `tests/gjs/profiles.test.js`, `tests/island/controlLogic.test.js` (total and `[25, 88, 46, 44, 26]`), headless action count 47 -> 56 (nine new actions: plan.preview, plan.run, macro.list, macro.save, macro.play, macro.stop, adaptive.dismiss, adaptive.history, adaptive.lock).

Status (honest)
| # | Feature | Status |
|---|---|---|
| 27 | Permission Manager | Runtime Integrated for Search's D-Bus callers (opt-in); End-to-End Verified in the nested shell (deny, always, persisted file, revoke on next call, history, grant needs a dialog). No UI to manage grants exists (D-Bus only); Desktop UAT Not Executed. Other D-Bus services (island, tile) do not use it. |
| 11, 15 | Adaptive Desktop / Smart Context | Runtime Integrated in Search (palette open, optional live listeners); End-to-End Verified for listeners on/off, dismiss, history, lock in the nested shell; the suggestion for a real focused app was not driven end to end in the shell (the focused-window case is node-tested through the engine, and the shell test reads an unknown window). No panel page for rules or history; Desktop UAT Not Executed. |
| 14 | AI Command Center | Runtime Integrated as `plan.preview`/`plan.run` with the local parser only; a declined `plan.run` verified nested; a successful `plan.run` is node-tested with a fake registry only (running real actions would change the host). No provider call. |
| 16 | Macro Recorder | Runtime Integrated for save/list/play/stop (no recorder: nothing records user actions); `macro.play` verified nested with a read-only step. Stop mid-play is node-tested, not driven in the shell. |
| 29 | Extension Compatibility | Runtime Integrated (`extensions.check`); database fixed and node-tested. The nested shell does not have `tiling-assistant` installed, so the real report on this machine was not produced. |

Limitations
- Behaviour change in Adaptive, from the engine's own hysteresis: a rule speaks once per episode. While the same app stays in front it is not suggested again, even after 30 minutes; it can speak again after Search has seen another app in front and the quiet time has passed. The old code repeated it every 30 minutes.
- The adaptive history is in memory (metadata only) and is lost when the shell restarts; the permission history too. Only grants persist.
- Any process of the user on the session bus can call `Revoke` and `ClearPermissionHistory` and can restrict itself with `Grant ... deny`; this only reduces access. Process names are not identities: a program named like another one shares its grants.
- `permissions-enforced` only covers D-Bus callers of `org.niro.Search` (the voice assistant gateway included, whose caller name is `island-daemon`, so one grant covers everything the assistant asks for). Keyboard shortcuts and the palette itself are not gated.
- Macro delays and loops run inside one D-Bus call (up to 600 s); the audit file records each step with `via: plan`.
- The headless test sets the real settings through the shell's memory backend and redirects config files to a scratch directory; nothing was written to the user's dconf or `~/.config/niro-control`. The audit file in `~/.local/share/niro-control` is still appended to by existing checks.
- `docs/UAT.md` was not extended for these features.

## Integration status after wave 1 (verified by the lead, not copied from agent reports)

| # | Feature | Status now | Evidence / what is still missing |
|---|---|---|---|
| 1 | Appearance Studio | Partially Wired (UI + GSettings runtime, Dock only for motion) | node 13 + gjs tests; never seen on a display; Look page still writes accents unchecked |
| 2, 3 | Theme / Motion | Partially Wired (inside Studio only) | island has no animation key; Tile has on/off only |
| 7 | Workspace: groups | Runtime Integrated (Tile, D-Bus, panel, CLI) | nested-shell test with real windows, 38 checks; Desktop UAT not run |
| 8 | Window Rules | Partially Wired | UI + CLI + Tile; rules path exercised in unit tests only, `profile` cannot match |
| 9 | Session snapshots | Runtime Integrated (workspace + monitor only) | nested-shell test; no window rectangles, no app state |
| 11 | Adaptive Desktop | Runtime Integrated (suggestion-first, Search) | node + headless action checks; a suggestion for a real focused app not driven |
| 12 | Multi-Monitor | Partially Wired (recovery of windows; opt-in `monitor-recovery`) | hotplug simulated, not physical; monitor profiles Core Only |
| 13 | Niro Flow | Runtime Integrated in the daemon (D-Bus `org.niro.Flow1`, store, ledger, history) | one workflow executed on a private bus against a FAKE Search; no UI; app-focus trigger up to ~1 min late; not End-to-End |
| 14 | Planner | Partially Wired (`plan.preview`, `plan.run`; local parser only) | no AI provider wired |
| 16 | Macro | Partially Wired (`macro.*` actions) | play/stop tested in node only |
| 27 | Permissions | Runtime Integrated for D-Bus callers (opt-in `permissions-enforced`) | caller identity = process name; no panel UI for grants |
| 29 | Extension Compatibility | Partially Wired (`extensions.check`) | fixed: Niro uuids were never matched (`*@niro.local`) and `tiling-assistant@ubuntu.com` missing; not run on a real install |
| others (4, 5, 6, 10, 15, 17 daemon side, 18-26, 28, 30) | unchanged from the matrix above | Core Only, research only or Not Implemented |

Verification run by the lead after wave 1: `npm test` exit 0 (440 node tests, controlUi 230 bindings and rows); `bash tests/shell/run-staged.sh headless` three times, all rc 0, 0 `JS ERROR` lines; `cargo test -p island-core -p island-daemon -p niro-flow` exit 0 (85 + 461 + 39); biome 1 old warning; clippy: the only warnings are in `island-daemon/src/device/` (untouched). One agent saw a single unexplained JS error in one headless run; three clean reruns did not reproduce it.
Not done: Desktop UAT on the live session (needs the user's agreement), GNOME 46 / Ubuntu, deb/rpm package build, performance measurements.
Open decision: the setting `flow-enabled` was not added because the daemon reads an env var / file, not GSettings, so the setting would have no runtime consumer; the Flow UI will call `SetGlobalEnabled`.

## Integration status after wave 2 (verified by the lead)

Verified by the lead: `npm test` rc 0 (483 node tests); `run-staged.sh headless` 3x rc 0, 0 `JS ERROR`; `npm run test:flow-e2e` (strict audit) rc 0.
HEAD unchanged (`27cd0d1`), nothing committed. Desktop UAT: **Not Executed** (the live session was not touched).

| Initiative | Status | Evidence / limit |
|---|---|---|
| Niro Flow | End-to-End Verified — Desktop UAT Pending | Real Search extension + real daemon on a private bus: a saved workflow ran `clipboard.copy`, the shell clipboard held the text, the audit shows `caller: island-daemon`. Refusals checked: Flow off, wrong capability, empty allow list, `system.restart`, shell/path-shaped ids. |
| Flow UI | Partially Wired | Widgets tested against a fake backend and a stand-in D-Bus service; never seen on a display, never run against the real daemon UI. |
| Control Panel navigation | UI Only | Grouped sidebar; Ctrl+1..N order changed. Connectivity has no page yet. |
| Performance Center | Runtime Integrated (CPU/mem/swap/load/battery) | disk/net/temp reported unavailable. |
| Smart Clipboard, Notification Hub, Audio Router, HUD, Privacy, Shelf collections | Partially Wired | Opt-in, default off; Search actions only (no panel pages for notification rules). HUD position/size: Blocked by Platform. |
| Packaging | rpm built locally and inspected (596 files, shared files present); deb NOT built (`dpkg-deb` missing) | docs/PERFORMANCE-VNEXT.md has the numbers. |

Bugs found and fixed in wave 2: GJS has no global `URL` (url.clean and shelf URI validation were silently broken); `Meta.is_wayland_compositor` is not a function on 51; the Search audit log stored copied clipboard text (now argument values for text/secret-like keys are recorded by length only).
Still open: `headless.sh` writes the real `~/.local/share/niro-control/audit.jsonl`; a secret can sit in the daemon's clipboard history up to ~1 min before the sweep; Flow app-focus trigger latency; no event source for workspace/monitor/profile triggers.

## Integration status after the fix wave (verified by the lead)

Verified by the lead: `npm test` rc 0 (515 node tests + gjs); `cargo test` 88+468+39 pass; staged modes headless, tile (61 ok), tileWorkspace (50 checks), controls, appearance, motion, niroSync, e2e-flow (strict audit) all rc 0, no JS ERROR; the real `~/.local/share/niro-control/audit.jsonl` hash identical before and after. HEAD `27cd0d1`, nothing committed. Desktop UAT of this wave: **Not Executed** (the live user copies are the pre-fix build).

- Flow event sources: `org.niro.Flow1.Notify` in the daemon + opt-in `flow-events` emitter in Search (workspace, monitor, profile, app-launched, app-focus). A real workspace switch reached the real daemon in the nested e2e-flow run. End-to-End Verified (nested), Desktop UAT Pending.
- Smart Clipboard secrets: Rust detector, opt-in `NIRO_CLIPBOARD_SKIP_SECRETS` / `~/.config/niro/clipboard.skip-secrets`; new copies only, existing history is not rewritten. Not run in a live session.
- Tile: `profile` condition and `opacity` action work on real windows in the nested shell (tileWorkspace 50 checks).
- plan.preview understands `copy X to clipboard` and lock/screenshot forms.
- Look page contrast check and a Notifications page exist (UI Only; never rendered on a display). Notification rules list is read from `notification-rules.json` read-only; a `notifications.rules` Search action would be cleaner.
- Staged test runs no longer touch the real XDG data dir; `tests/shell/tile.sh` no longer uses pkill. `scripts/benchmark-performance.sh` still uses read-only `pgrep` on the live gnome-shell.
- Corners extension: null guard in `refreshShadow` (the one-off `appears_focused` error).

## Shell wave: motion, theme tokens, widgets in Search

- **Motion Studio (3), island.** New key `motion-preset` (island schema; default `default` = the island's own timings, unchanged). `off` removes the island's fades and slides; `minimal`, `smooth`, `dynamic`, `cinematic` scale them by the preset's `normal` over smooth's (smooth is identity). With a preset chosen, GNOME's "reduce animations" gives 0. Core: `scaleDuration` in `shell/shared/tokens.js`; consumer `shell/island/src/motion.ts` (`dur()`, configured and released by the controller), applied to the page fades and slides, view swaps, tint fade, header and compact-view eases. Not covered: the springs that size the island, the endless glow/pulse/breath loops, the voice and chat views, the auto-hide slide, the Dock (it keeps its own `animation-duration`), windows and workspaces. Staged `motion` passes; the new key was not driven in a nested shell. Status: Partially Wired.
- **Theme Engine (2).** `deriveAccent(accent, tint)` in tokens.js is the one place the island's accent stylesheet and the dock's indicator colour come from: the accent as it is while it reads, text on the accent white unless that is under 3:1 (then near-black), accent text on the island's dark surface and the dock indicator on its tint lifted to 3:1. The default accent and tint produce the exact old strings (tested). No new setting. Not covered: Search and Tile colours, the panel (it has its own appearanceTokens.ts). Status: Partially Wired.
- **Widget Studio (5).** One surface: Search. Opt-in `widgets-in-search` (niro schema, default off) enables `widgets.list` and `widgets.show` (id optional). Four built-in widgets (system.cpu, system.memory, system.load, system.battery) are validated manifests subscribed to widgetRegistry's hub (refresh policy manual, so nothing is ever due and nothing polls); `widgets.show` takes one reading through the existing perf sampler in `systemHub.ts` (reusing the recording sample when it is under 5 s old). Memory is bounded by four subscriptions; switching the setting off or stopping the hub drops them. Not implemented: placement, resize, grid, layout persistence and any on-desktop drawing.
- Counts: 243 settings (island 89, search 38); 78 Search actions. Search capability map: both widget actions are `device`.

## Integration status after the Core-Only wave (verified by the lead, partly)

Verified by the lead: `npm test` rc 0 (539 node tests + gjs); staged modes headless, tile, tileWorkspace, controls, appearance, motion, niroSync all rc 0, no JS ERROR. The strict `e2e-flow` rerun passed and the real audit-file hash was identical before and after.
- Backup & Restore: page + CLI (`--backup-export|preview|import`), secrets excluded, transaction with rollback. UI Only (never rendered). `niro-plugin check`: manifest validation only; no plugin host (blocked pending design approval). `packaging/build.sh` now installs `niro-plugin`.
- Motion Studio: `motion-preset` for the island, Partially Wired (springs, loops, voice/chat views and the Dock are not covered).
- Theme Engine: `deriveAccent` feeds the island/dock accent colours, Partially Wired.
- Widget Studio: Search-only (`widgets.list`, `widgets.show`, setting `widgets-in-search`), Partially Wired; no on-desktop widget surface exists (needs design).
- Catalog 243 settings, 78 Search actions. Desktop UAT of this wave and of the fix wave: Not Executed (needs a re-login to load the installed rpm; the installed rpm predates this wave).

## Integration status after the parallel wave 3 (verified by the lead)

Verified by the lead: `npm test` rc 0; `cargo test -p island-core -p island-daemon -p niro-flow` rc 0 (88 + 469 + 39); clippy only the old warnings in `island-daemon/src/device/`. HEAD still `27cd0d1`, nothing committed. Desktop UAT: **Not Executed**.

- **Corrections to earlier notes.** The Flow app-focus trigger is event-driven (`Notify("app-focus")`); the late app-usage report is only a fallback and never fires twice, so the "~1 min late" notes above are stale (it still needs `shell/search/flowEvents.ts` to send the event in a live session). `headless.sh` already runs on a temporary XDG data dir; the real `audit.jsonl` hash was identical before and after. `tiling-assistant@ubuntu.com` was already in the conflict list; only its reason text was made specific.
- **Smart Clipboard secrets.** With the opt-in on, a secret-shaped text is refused when it arrives (`add_text`, `refuse_secret`), not at the next sweep. Old history is not rewritten; images and files are not checked.
- **Motion Studio.** `off` or GNOME's reduce-animations now also stops the lyrics dots, the mascot and the equalizer bounce, and routes auto-hide, the top bar slide and the voice and chat fades through `dur()`. Still not covered: the springs that size the island, the voice meter timeline and dropLight (they carry live levels), small per-page fades (`tasks`, `clips`, `notifications`, `files`), the Dock, windows and workspaces. Not driven in a nested shell. Partially Wired.
- **Permissions page** (System group) and **Connectivity page** (Connectivity group): UI Only. Permissions lists grants, sets and revokes them over `org.niro.Search`, and any grant that gives more access asks first in the panel and again in Search; history shows four fields, never arguments. Connectivity cannot show on/off, because Search has toggles but no status reader; it shows whether each action is available and Search's reply after a confirmed toggle. Tested against a stand-in Search on a private bus, never seen on a display, never run against the real daemon.
