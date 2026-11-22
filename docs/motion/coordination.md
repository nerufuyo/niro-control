# Cross-extension coordination: proposal

Status: design only. Nothing here is implemented, and no service should be built until the first question below is
answered by a runtime test.

## What the three extensions are

island, dock and search are separate GNOME Shell extensions, but **they run in the same gnome-shell process**. They
cannot import each other, and each carries its own copy of `motionEngine.js`, but they share `global`, `Main`,
`Shell.AppSystem`, `St.Settings`, GSettings and the session bus. So "separate extensions" does not mean "needs IPC".
The question is only which events have a source of truth that every extension can already observe.

## Which events need cross-extension communication

| Event | Needs to cross extensions? | Shared source that already exists |
|---|---|---|
| Fullscreen window | No | `global.display` `in-fullscreen-changed` (island and dock already use it) |
| Screen lock / unlock | No | `Main.sessionMode` / `Main.screenShield` state; each extension reacts alone |
| Monitor changes | No | `Main.layoutManager` `monitors-changed` |
| Reduced motion | No | `St.Settings` `enable-animations`, plus the `motion-preset` GSetting |
| Dock running state after launch from Search | No | `Shell.App` `state-changed` / `Shell.AppSystem` `app-state-changed`: Search launches the app, GNOME reports the state, the dock reacts to that. Search never needs to tell the dock. |
| Music state change | No | The island reads it from its daemon, the dock from MPRIS. Each has its own source and they do not need to agree on timing. |
| Search opens while the Island is expanded | **Maybe** | Both call `Main.pushModal`. See below. |
| Dock hidden while Search is open | **Maybe** | Same modal signal. |

So of the eight events in the brief, six already have an observable GNOME source. Only the two "modal surface
opened" cases are unresolved.

## The one real question: two surfaces that grab the keyboard

Island takes a modal grab when expanded (`controller.ts` around line 2323) and Search takes one when it opens
(`extension.ts` around line 402). `Main.pushModal` stacks grabs, so the newer one wins focus. What is not known, and
must be measured in the headless session before any design:

1. When Search opens over an expanded Island, does the Island lose its grab cleanly, or does it stay expanded behind
   the overlay and fight for focus on close?
2. When Search closes, who gets the grab back?

If (1) shows the Island simply stays expanded and harmless, **no coordination is needed**. If it is a visible defect,
the cheapest fix is one-directional and needs no service: the Island collapses itself when the shell's keyboard focus
moves outside it (`global.stage` `notify::key-focus`, or `Main.modalCount` changes). The Island depends on a GNOME
signal; Search does not know the Island exists.

## Options evaluated

1. **Observe GNOME state (preferred).** Each extension reacts to signals GNOME already emits. No coupling, no cycle,
   works if only one of the extensions is enabled, nothing to version.
2. **Reach into another extension's instance** (`Main.extensionManager.lookup(uuid).stateObj`). Technically possible
   in-process, but it couples one extension to another's internals and to a shell-private structure. The dock already
   does a `manager.lookup(uuid)` at `dockManager.ts:450` for conflict detection, which is a read of metadata, not a
   call into the other extension. Rejected for motion.
3. **GSettings as a bulletin board** (one extension writes a key, another watches it). Cheap and decoupled, but it
   writes to disk for what is transient UI state and leaves stale values after a crash. Acceptable only for user
   preferences, not for "Search is open".
4. **D-Bus service.** `org.niro.Search` already exists on the session bus for shortcuts and the assistant, so a
   `SearchOpen` property or signal on it would add no new service. The downside is that the Island would then depend
   on Search being enabled, and a bus round trip is slower than an in-process signal. Justified only if option 1
   cannot detect the case, which no evidence says yet.
5. **New shared coordinator service.** Not justified. It would be a fourth moving part that every extension must
   survive being absent, for events that GNOME already broadcasts.

## Recommendation

- Do not add a coordinator or a service.
- Run the Search-over-Island scenario in the headless session (Island expanded, open Search, close it) and record
  what happens to the grab and the Island surface.
- If it is a defect, fix it in the Island alone with a keyboard-focus or modal-count observer, with Search untouched.
- Keep the rule: each state machine takes events from GNOME or from its own input, never from another extension, so
  each remains testable alone and nothing is circular.
- Revisit only if a real event appears that GNOME does not broadcast. None of the eight in the brief is one.

## Open items

- The Search-over-Island runtime result (not yet measured).
- Whether `Main.modalCount` is available and stable from GNOME 46 to 51; if not, use the key-focus signal.
