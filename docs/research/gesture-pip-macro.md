# Feasibility note: gestures (6), Universal PiP (10), Macro Recorder (16)

Scope: GNOME Shell 46 to 51 on Wayland. Statements are either well-established GNOME behaviour or marked **needs desktop validation**. Nothing here was run on a desktop.

## 1. Touchpad gestures (initiative 6)

What GNOME Shell does today
- Shell handles multi-finger touchpad swipes itself, in the compositor process: 3-finger horizontal swipe changes workspace, 3-finger vertical opens Overview / App grid (on Shell 40+). On Shell 40 to 45 the horizontal/vertical workspace swipe used 3 fingers; 4-finger swipes were also routed to the same actions (in Shell 46 and later, 4-finger swipes act as the 3-finger ones in some setups). Exact finger counts per version: **needs desktop validation**.
- Pinch and 2-finger scroll go to the focused client, not the Shell.

What an extension can observe
- An extension runs inside the Shell (gjs, Clutter) and can add a `Clutter.Gesture`/`Clutter.SwipeAction` (older: `Clutter.GestureAction`) to `global.stage` or an actor, and listen for `captured-event` on the stage. Touchpad gesture events (`Clutter.EventType.TOUCHPAD_SWIPE`, `TOUCHPAD_PINCH`, `TOUCHPAD_HOLD`) arrive there. The API shape changed across 46 to 51 (the Clutter gesture classes were reworked in the Shell 47/48 era); a `compat` helper is required and the exact class names per version **need desktop validation**.
- Observing is possible; consuming is a choice: returning `Clutter.EVENT_STOP` swallows the event so the built-in gesture will not run, `EVENT_PROPAGATE` lets it through.

Avoiding conflicts with the built-in 3/4-finger gestures
- Default: never consume 3- or 4-finger swipes. Offer extra gestures on counts the Shell does not use (for example pinch or hold with a modifier, or 4+ fingers where hardware reports them) and make the finger count of a custom gesture configurable with a visible warning when it equals a built-in count.
- If a user opts to take over a built-in count, consume only while a custom binding exists for that exact direction, and keep the others propagating.
- Gesture events carry no device-level distinction between touchpad models; libinput decides which gestures exist (hardware dependent). **needs desktop validation** on at least two touchpads.
- Cannot do: observe gestures when the Shell does not receive them (apps with a pointer grab, screen locked, X11 clients before the Shell sees them), or synthesize system gestures.
- Performance: use event-driven handlers only, no polling; remove the handler on disable (lifecycle test as for other extensions).

Verdict: observation of gestures on Wayland is feasible (**Requires Research -> likely Feasible, limited**), custom gestures must default to non-conflicting finger counts. Not Blocked by Platform.

## 2. Universal PiP (initiative 10)

- A `Clutter.Clone` of a window actor is a live, scaled picture. It is not interactive: input goes to the clone actor (which can be made to forward pointer events only by hand-translating coordinates to the source window, which has no supported API and breaks for popups and text input). **needs desktop validation** for any forwarding experiment; treat as unsupported.
- A truly interactive PiP is a normal window: the realistic design is to resize and reposition the real `Meta.Window` into a small, always-on-top (`make_above`), all-workspaces (`stick`) frame. This reuses the existing `window.above.toggle` action. Limits: a window has a minimum size set by the app; some apps refuse to shrink; Wayland clients cannot be forced to a size below their hint; layout inside is the app's responsibility. Per-app behaviour **needs desktop validation**.
- Browser video PiP: Chrome and Firefox provide their own PiP windows (document PiP / video PiP); the Shell should only keep those above and let the user pin them, not reimplement video routing.
- Recommendation: ship "shrink and pin this window" (interactive, real window, reversible by restoring the saved frame) first; offer a clone preview as a separate, clearly non-interactive "Peek" mode (mouse-through, closes on click). Do not call the clone "PiP" in the UI.
- Capture of a hidden/minimized window by clone shows its last frame or nothing: **needs desktop validation**.

## 3. Macro Recorder (initiative 16)

Constraints
- No synthetic keyboard/mouse injection into other apps on Wayland without the RemoteDesktop portal (needs a user consent dialog, per session) or accessibility (AT-SPI, limited and app-dependent). Recording raw keystrokes would capture passwords: out of scope.
- Therefore record **semantic actions**, not input events.

Safe design
1. Source of truth: the ActionRegistry (`shell/search/registry.ts`, D-Bus `org.niro.Search`: `ListActions`, `RunAction`, `History`). A macro is an ordered list of `{action, args, delayMs}` of registered actions only, i.e. exactly the shape of a Niro Flow workflow so the Flow validator and executor (`crates/niro-flow`) are reused, not duplicated.
2. Recording: while recording is on (explicit, visible indicator, off by default), append each successful `RunAction` the registry reports. Nothing else is observed: no keystrokes, no pointer, no window titles, no clipboard content.
3. Arguments: stored as given by the action schema; arguments matching secret patterns are redacted (reuse the Flow plan redaction); `confirm`-permission actions are recorded as steps that still ask at playback, never auto-confirmed.
4. Playback: dry-run first (the plan view), per-step timeout, global step cap, delay cap, a loop guard (a macro that triggers itself or another macro is refused), and a stop control. Grants come from the PermissionService core (`shell/shared/permissions.js`) per capability.
5. Storage: plain file under the user's config, versioned schema, no secrets, included in the backup manifest (`backup.js`).
6. Not offered: shell commands, arbitrary key/mouse replay, text typing into other apps. These need the RemoteDesktop portal and a separate approval (**Requires User Approval**).

Verdict: a semantic macro recorder is feasible and low-risk; input-level recording is not part of this plan.

## Summary

| Initiative | Result | Next step |
|---|---|---|
| 6 Gestures | Feasible with limits; avoid 3/4-finger built-ins by default | Prototype observation in a test extension on 46 and 51, per-version class names |
| 10 PiP | Interactive = shrink+pin the real window; clone = non-interactive peek | Prototype resize/stick/above on 3 apps |
| 16 Macro | Semantic recording over the ActionRegistry/Flow | Wait for Flow wiring, then add a recorder in the registry |
