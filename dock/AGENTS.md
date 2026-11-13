# AGENTS.md — MacOS Dock

## 1. Purpose and Scope

This document defines the mandatory engineering standards, architectural constraints, GNOME Shell compatibility requirements, and review procedures for all AI agents and human contributors working on MacOS Dock.

MacOS Dock is a GNOME Shell extension written in TypeScript that provides a macOS-inspired dock experience. It targets GNOME Shell 45 and later.

**Every change must prioritize stability, maintainability, compatibility, resource safety, and consistency with GNOME development standards.**

Agents must not treat a task as complete merely because the requested feature appears to work. Every modification must be reviewed for correctness, architectural consistency, regressions, cleanup behavior, and compliance with the official GNOME Extension Review Guidelines.

### Mandatory principles

1. Read and understand the existing implementation before changing it.
2. Follow the official GNOME Extension Review Guidelines and GNOME Extension Best Practices.
3. Preserve the existing architecture unless a justified architectural change is necessary.
4. Prefer public, documented APIs over private GNOME Shell internals.
5. Give every resource a clearly defined owner and cleanup path.
6. Review the complete change set after every modification.
7. Validate changes with the available build, static analysis, and runtime tests.
8. Never claim that a test or validation passed unless it was actually executed successfully.
9. Never introduce speculative APIs, unnecessary abstractions, silent error handling, or unrelated refactoring.
10. When requirements conflict with GNOME standards, stop and explain the conflict before introducing an unsafe implementation.

---

## 2. Official Documentation and Source of Truth

The following documentation must guide implementation and review.

### Required references

- GNOME Shell Extensions Review Guidelines:
  [https://gjs.guide/extensions/review-guidelines/review-guidelines.html](https://gjs.guide/extensions/review-guidelines/review-guidelines.html)
- GNOME Extension Best Practices:
  [https://gjs.guide/extensions/review-guidelines/best-practices.html](https://gjs.guide/extensions/review-guidelines/best-practices.html)
- GNOME Shell Extension Development Guide:
  [https://gjs.guide/extensions/](https://gjs.guide/extensions/)
- GNOME Shell 45 Porting Guide:
  [https://gjs.guide/extensions/upgrading/gnome-shell-45.html](https://gjs.guide/extensions/upgrading/gnome-shell-45.html)
- GNOME Shell Extension Preferences:
  [https://gjs.guide/extensions/development/preferences.html](https://gjs.guide/extensions/development/preferences.html)
- GNOME Shell Debugging Guide:
  [https://gjs.guide/extensions/development/debugging.html](https://gjs.guide/extensions/development/debugging.html)
- GNOME Human Interface Guidelines:
  [https://developer.gnome.org/hig/](https://developer.gnome.org/hig/)

### Documentation hierarchy

When making implementation decisions, use this order of authority:

1. Official GNOME Extension Review Guidelines for submission requirements.
2. Official GNOME/GJS documentation for supported APIs, lifecycle rules, and compatibility.
3. Existing project architecture and established conventions.
4. Tests, schemas, type definitions, and build configuration.
5. External examples, community implementations, and AI-generated suggestions.

External examples are references, not proof that an API is supported or appropriate.

If an example conflicts with official guidance or the project's architecture, follow the authoritative documentation and explain any necessary deviation.

### Version compatibility

- The project targets GNOME Shell 45 and later, subject to the versions explicitly declared in `metadata.json`.
- Verify the actual supported versions before introducing version-dependent behavior.
- Do not claim support for a GNOME Shell release without validating compatibility.
- Do not add speculative compatibility branches for hypothetical versions.
- When an API changes between supported releases, consult the official porting guides and implement only the compatibility logic the project actually requires.
- Never use deprecated modules when a documented replacement is available.

---

## 3. Project Architecture

The existing source structure establishes the primary responsibilities of each module.

```text
src/
  extension.ts          # Extension entry point and lifecycle
  prefs.ts              # Extension preferences UI
  lib/
    dockManager.ts      # Dock lifecycle, layout and subsystem coordination
    dockVisibility.ts   # Visibility, auto-hide and related animations
    iconManager.ts      # Application icons and icon lifecycle
    magnification.ts    # Pointer-driven icon magnification
    intellihide.ts      # Window overlap and dock visibility decisions
    signalManager.ts   # GObject signal connection lifecycle
    windowPreview.ts    # Window thumbnail preview popup
```

The repository may contain additional files, tests, stylesheets, schemas, scripts, and build artifacts. Inspect the actual repository rather than assuming this list is exhaustive.

### 3.1 Module responsibilities

**`extension.ts`**

- Acts as the GNOME Shell extension entry point.
- Owns the top-level extension lifecycle.
- Creates and starts the dock manager during `enable()`.
- Stops and releases the dock manager during `disable()`.
- Keeps `enable()` and `disable()` adjacent.
- Must not accumulate unrelated dock behavior or duplicate subsystem responsibilities.

**`dockManager.ts`**

- Coordinates the dock container and its subsystems.
- Owns the lifecycle of `WindowPreviewPopup`.
- Applies settings changes and coordinates feature behavior.
- Ensures child resources are stopped before their dependencies are destroyed.
- Must not become a dumping ground for unrelated functionality.

**`dockVisibility.ts`**

- Owns dock visibility and auto-hide behavior.
- Must clean up its timers, signals, animations, and related resources.
- Must not leave callbacks running against a destroyed dock.

**`iconManager.ts`**

- Owns application icon creation, updates, and destruction.
- Maintains the `_icons` map consistently with the actual icon actors.
- Coordinates icon hover interactions and window previews.
- Must not leave stale actors, event handlers, or references after shutdown.

**`magnification.ts`**

- Owns magnification calculations, polling, and animation-related state.
- Uses the configured polling rate when calculating updates.
- Must remove polling sources and release references when stopped.
- Must avoid unnecessary allocations and excessive work on the GNOME Shell main thread.

**`intellihide.ts`**

- Owns window overlap detection and the logic used to determine whether the dock should be hidden.
- Must disconnect window-related signals and remove pending sources when stopped.
- Must not override visibility decisions without respecting the existing dock visibility architecture.

**`signalManager.ts`**

- Centralizes signal connection tracking and disconnection.
- Must reliably release every connection it owns.
- Must make ownership and cleanup behavior easy to audit.
- Must not conceal connections or disconnect resources owned by unrelated components.

**`windowPreview.ts`**

- Implements the window preview popup.
- Must release its own internal resources according to its lifecycle contract.
- Must not independently determine whether the feature is enabled.
- Must not destroy or stop resources owned by `DockManager`.

### 3.2 Architecture preservation

Before adding a feature, determine which existing module owns the behavior.

Agents MUST:

- Extend an existing subsystem when the responsibility already belongs there.
- Extract a helper only when it provides a clear, reusable responsibility.
- Keep process-specific code separated.
- Avoid circular dependencies.
- Avoid duplicated implementations of the same behavior.
- Avoid introducing new manager classes that merely forward method calls.
- Avoid changing public or cross-module interfaces unnecessarily.
- Update every affected caller when changing a shared interface.
- Keep feature flags and settings checks in the appropriate coordinating modules.

If an architectural change is necessary, explain the reason, affected modules, lifecycle implications, and alternatives before implementation.

---

## 4. Mandatory Change Workflow

Every task MUST follow this workflow, regardless of its apparent size.

### Phase 1 — Inspect

Before editing:

1. Read this `AGENTS.md`.
2. Inspect the relevant source files and their imports.
3. Read related classes and interfaces.
4. Inspect `package.json`, TypeScript configuration, build scripts, and available test tooling.
5. Inspect `metadata.json` and the GSettings schema when compatibility or settings are involved.
6. Search for every caller, signal connection, timeout, callback, and reference affected by the proposed change.
7. Inspect the current Git working tree and existing user changes.
8. Identify the intended behavior and define how it will be validated.

Do not overwrite or discard unrelated user modifications.

Use focused searches and repository history when they help establish why an implementation exists.

### Phase 2 — Plan

Before implementing a nontrivial change, identify:

- The requested behavior.
- The files and modules that must change.
- The resources that will be created or modified.
- The lifecycle owner of each resource.
- The settings or signals involved.
- Potential compatibility issues.
- Potential regressions.
- The build and test commands available for validation.

For small changes, this plan may remain concise. The analysis itself is mandatory.

### Phase 3 — Implement

Implement the smallest complete change that satisfies the requirements.

During implementation:

- Follow the established TypeScript conventions.
- Preserve module boundaries.
- Use documented GNOME APIs.
- Preserve existing behavior unless the task explicitly changes it.
- Add no unrelated features or refactoring.
- Update tests when behavior changes.
- Update documentation when architecture, settings, or workflows change.

### Phase 4 — Review immediately after every modification

**This phase is mandatory after every individual modification, not only at the end of the task.**

A modification includes changing an existing function, adding a file, editing a setting, changing a type, updating a schema, modifying a stylesheet, or adjusting build configuration.

After each modification:

1. Re-read the modified code in its surrounding context.
2. Inspect the relevant diff.
3. Check whether the modification introduces new resources, signals, timers, callbacks, or references.
4. Verify that resource ownership and cleanup remain correct.
5. Check all affected callers and dependent modules.
6. Look for regressions in existing behavior.
7. Correct any issues discovered before proceeding.

If the review identifies a defect, fix it and repeat the review.

Do not defer obvious cleanup, type errors, broken imports, or architectural inconsistencies until the end.

### Phase 5 — Full change-set review

After implementation is complete, review the entire change set, including every modified, added, renamed, and deleted file.

Use commands such as:

```bash
git status --short
git diff --check
git diff
```

Inspect untracked files separately because ordinary `git diff` does not display their contents.

For staged changes, inspect the staged diff as well:

```bash
git diff --cached --check
git diff --cached
```

Verify that:

- Every changed line is intentional.
- All changes are relevant to the task.
- No temporary debugging code remains.
- No accidental generated files or build artifacts were included.
- No unrelated user changes were overwritten.
- All affected interfaces and callers are consistent.
- No new warnings or errors were introduced knowingly.
- All lifecycle and cleanup requirements remain satisfied.

### Phase 6 — Validate

Execute the relevant checks described in Section 12.

If a check fails, determine whether the failure was introduced by the change or was already present.

Fix regressions introduced by the task. Document unrelated pre-existing failures without misrepresenting them as successful validation.

If runtime testing is unavailable, explicitly state that limitation.

### Phase 7 — Final review and report

Before reporting completion:

1. Reinspect the final diff.
2. Verify that all requested behavior is implemented.
3. Verify that all required validation steps were performed or explicitly marked as unavailable.
4. Confirm that no unresolved critical issue remains.
5. Summarize the changes and the evidence supporting their correctness.

A task is not complete until the full change-set review and applicable validation are finished.

---

## 5. GNOME Shell Lifecycle Rules

Lifecycle correctness is a critical stability requirement.

GNOME Shell extensions execute within a sensitive desktop process. Incorrect cleanup can cause memory leaks, stale callbacks, broken UI elements, and potentially an unusable desktop session.

Official guidance:
[https://gjs.guide/extensions/review-guidelines/review-guidelines.html](https://gjs.guide/extensions/review-guidelines/review-guidelines.html)

### 5.1 Initialization

Initialization must be limited to static resources and other initialization explicitly permitted by GNOME.

Do not create dynamic GNOME objects, connect signals, add main-loop sources, modify the shell UI, or start background behavior in module scope or the extension constructor.

Create runtime resources in the appropriate lifecycle method, normally `enable()` or a method called from it.

Do not assume that constructing a class is equivalent to enabling it.

### 5.2 `enable()`

When enabling the extension:

- Create the dock and required actors.
- Initialize the dock manager and its subsystems.
- Establish signal connections through `SignalManager`.
- Register timers and polling sources with their owning classes.
- Apply current settings.
- Start feature-specific behavior only when required.
- Maintain a clear order of dependency initialization.

Do not create resources before they are needed.

### 5.3 `disable()`

`disable()` must undo everything established during `enable()`.

Cleanup must follow reverse dependency order:

1. Stop active behavior and prevent new work from being scheduled.
2. Remove GLib sources and pending timeouts.
3. Disconnect signal handlers.
4. Stop child subsystems and release popup resources.
5. Destroy actors and widgets owned by the relevant components.
6. Clear maps, collections, and references as appropriate.
7. Release the top-level manager reference.

The exact sequence may vary with resource dependencies, but dependent objects must never outlive resources they require.

Keep `enable()` and `disable()` adjacent in `extension.ts` so reviewers can easily compare initialization with cleanup.

### 5.4 No lifecycle guard flags

Do not introduce boolean flags such as:

```typescript
this._enabled
this._destroyed
this._isStopped
```

solely to compensate for incorrect lifecycle management or repeated lifecycle calls.

GNOME-managed lifecycle methods should be designed around explicit resource ownership and correct teardown.

After `stop()` or `disable()`, clear owned references and do not reuse the stopped instance.

A boolean is acceptable when it represents genuine domain state or a documented algorithmic condition rather than hiding a lifecycle defect.

### 5.5 Class ownership

Each class MUST own and clean up the resources it creates.

Examples:

- The class creating a GLib source removes that source.
- The class connecting a signal disconnects that signal.
- The class creating an actor destroys that actor.
- The class creating a popup releases its internal resources.
- The parent manager coordinates child shutdown but does not silently assume ownership of every child resource.

Do not initialize resources in one class and scatter their cleanup across unrelated classes.

### 5.6 Destruction order

For custom `destroy()` methods:

- Remove active sources first.
- Disconnect owned signal handlers.
- Release child objects and references.
- Destroy owned actors where appropriate.
- Call `super.destroy()` as the final step when overriding a GObject actor's destruction method.

Respect the actual superclass contract and avoid destroying resources twice.

Do not call `GObject.Object.run_dispose()` unless absolutely necessary and justified by a specific documented requirement.

---

## 6. GLib Sources, Timers, and Asynchronous Work

### 6.1 Source ownership

Every `GLib.timeout_add()`, `GLib.timeout_add_seconds()`, `GLib.idle_add()`, or other registered main-loop source MUST have its source ID tracked by its owning class.

Before creating another source of the same kind, remove the existing source when the design requires only one active instance.

Keep removal immediately adjacent to creation:

```typescript
if (this._timeoutId) {
    GLib.Source.remove(this._timeoutId);
    this._timeoutId = 0;
}

this._timeoutId = GLib.timeout_add(
    GLib.PRIORITY_DEFAULT,
    interval,
    () => {
        // Perform the scheduled work.

        return GLib.SOURCE_CONTINUE;
    }
);
```

This example illustrates the required ownership pattern. Adapt the field type and source-removal convention to the actual project and GLib API contract.

Never copy an example's sentinel value without checking the actual type and existing conventions.

### 6.2 Callback termination

When a callback finishes, ensure the stored source ID no longer represents an active source.

When returning `GLib.SOURCE_REMOVE`, update the owning class's source tracking appropriately. Do not leave a stale ID that could later be removed as if the source were still active.

All remaining active sources must be removed during `stop()` or `disable()`, even if a callback is expected to terminate naturally.

### 6.3 Callback safety

Before allowing asynchronous work or callbacks to update the dock, verify that:

- The referenced actor or object is still valid.
- The relevant resource has not been destroyed.
- The callback cannot reschedule work after shutdown.
- Signal disconnection and source removal prevent further access to released resources.

Do not introduce `_destroyed` or `_enabled` flags as a substitute for correct cancellation and cleanup.

### 6.4 Performance

- Avoid unnecessarily frequent polling.
- Respect configurable magnification frame rates.
- Avoid creating new arrays, objects, or closures on every high-frequency update when unnecessary.
- Avoid expensive window enumeration or layout work on every pointer movement.
- Cache stable values where appropriate.
- Prefer event-driven updates when they can replace unnecessary polling.
- Do not introduce worker processes or external subprocesses for lightweight dock behavior.
- Keep the GNOME Shell main thread responsive.

Any change to polling, animation, or window detection must be reviewed for CPU usage, responsiveness, and cleanup.

---

## 7. Signal Management

All GObject signal connections MUST go through `SignalManager`.

Direct calls to `connect()` without registration in the signal manager are prohibited.

### Required rules

- Every connection must have a clear owner.
- Every connection must be tracked until disconnected.
- Signal callbacks must not outlive the objects they reference.
- All owned connections must be disconnected during `stop()` or `disable()`.
- Signal manager cleanup must not disconnect unrelated handlers.
- Connections must not be duplicated when settings change or components restart.
- Signal manager APIs must have clear and consistent semantics.

When adding a signal:

1. Identify its owner.
2. Register it through `SignalManager`.
3. Confirm that the manager records the correct target and handler ID.
4. Confirm that cleanup disconnects the correct connection.
5. Confirm that restarting the component does not duplicate the handler.
6. Verify that the callback cannot operate on destroyed actors.

Do not add a second signal-tracking mechanism without a justified architectural reason.

---

## 8. GNOME APIs, GJS, and TypeScript

### 8.1 Public APIs

Prefer documented GNOME Shell, GJS, Gio, GLib, Clutter, and St APIs.

Do not depend on private shell implementation details when a public API provides the required behavior.

Private APIs may change without notice and can cause extensions to break after GNOME Shell upgrades.

If a private API appears unavoidable:

1. Investigate supported alternatives.
2. Verify the API's actual implementation and compatibility requirements.
3. Explain why the dependency is necessary.
4. Isolate the dependency in the smallest reasonable module.
5. Document its compatibility implications.
6. Add appropriate validation or tests where possible.

Never invent API names, methods, imports, signals, or properties.

### 8.2 Module imports

Because the extension targets GNOME Shell 45+, use ES modules and the appropriate import mechanisms.

Typical patterns include:

```typescript
import GLib from 'gi://GLib';
import St from 'gi://St';

import { Extension } from
    'resource:///org/gnome/shell/extensions/extension.js';
```

Use relative imports for project modules.

Verify every import against the installed GNOME Shell version, official documentation, and the project's TypeScript declarations.

Do not use legacy imports such as `imports.gi.*` or deprecated modules such as `Mainloop`, `Lang`, or `ByteArray` when documented replacements are available.

### 8.3 Process isolation

GNOME Shell UI and preferences run in different process contexts.

The GNOME Shell process may use appropriate shell libraries such as `St`, `Clutter`, `Meta`, and `Shell`.

The preferences process may use `Gtk`, `Gdk`, and `Adw`.

Never import `Gtk`, `Gdk`, or `Adw` into the GNOME Shell process. Never import `St`, `Clutter`, `Meta`, or `Shell` into the preferences process.

Shared utility modules used by both contexts must not import process-specific UI libraries.

Keep imports and module boundaries clear so reviewers can determine which process executes each file.

### 8.4 TypeScript quality

- Maintain strict, meaningful types.
- Avoid `any` unless there is a specific and documented reason.
- Prefer narrow types and explicit interfaces for cross-module contracts.
- Avoid unnecessary type assertions and non-null assertions.
- Do not silence compiler errors merely to make the build pass.
- Do not introduce broad `@ts-ignore` directives.
- If a type declaration is inaccurate or missing, investigate the actual API and use the narrowest safe correction.
- Ensure TypeScript changes produce readable, reviewable JavaScript through the project's build process.

Do not introduce an additional transpilation or obfuscation layer without a clear need.

### 8.5 Error handling

Avoid unnecessary `try/catch` wrappers around APIs that are not expected to throw under normal operation.

Never use empty catch blocks to hide failures.

If an operation can genuinely fail:

- Handle the failure at the appropriate boundary.
- Preserve useful diagnostic information.
- Avoid logging sensitive information.
- Restore consistent application state when possible.
- Release resources even when operations fail.
- Do not continue with invalid assumptions.

Use optional chaining only when a value is legitimately optional. Do not use it to conceal broken object ownership or to pretend guaranteed methods are optional.

---

## 9. Dock Architecture and Visual Behavior

### 9.1 Container ownership

`DockManager` creates and owns the dock container, typically an `St.BoxLayout`, and passes it to the appropriate subsystems.

Do not let child subsystems independently create competing dock containers or modify container ownership without an explicit architectural change.

Verify that every icon actor is inserted into and removed from the appropriate container and that the `_icons` map remains consistent.

### 9.2 Icon lifecycle

All icons are managed through `IconManager` and its `_icons` map.

When modifying icon behavior, inspect:

- Icon creation and destruction.
- Application changes and icon refreshes.
- Signal registration and disconnection.
- Hover enter and leave events.
- Magnification transitions.
- Window preview interactions.
- Container insertion and removal.
- Settings changes that affect rendering.
- References held by animations and callbacks.

Do not remove an actor from the container without updating the associated data structures.

Do not remove an entry from `_icons` while leaving its actor or event handlers active.

### 9.3 Magnification

Magnification uses polling and linear interpolation (lerp) for smooth scaling transitions.

Preserve the existing behavior unless the task explicitly requires a change.

When modifying magnification:

- Respect the configured update frequency.
- Preserve smooth transitions without unnecessary work.
- Avoid scale changes that cause layout instability.
- Ensure actors are restored to their expected scale when the effect ends.
- Stop polling when the subsystem is stopped.
- Ensure that pointer departure, icon removal, and dock shutdown cannot leave icons permanently scaled.

### 9.4 Auto-hide and intellihide

Keep visibility decisions within the existing responsibilities of `DockVisibility`, `Intellihide`, and `DockManager`.

Before changing these systems, inspect the interactions among:

- Pointer position and dock-edge activation.
- Dock visibility transitions.
- Window overlap detection.
- Animation completion callbacks.
- Settings changes.
- Monitor and work-area changes, when supported.
- Shutdown and reinitialization.

Avoid competing visibility animations or callbacks that reverse a newer visibility decision.

### 9.5 Window previews

`WindowPreviewPopup` is owned by `DockManager`.

`IconManager` may trigger preview display and dismissal when the `window-previews` setting is enabled.

Only `DockManager.disable()` calls `WindowPreviewPopup.stop()` under the existing architecture.

Preserve this ownership rule unless a deliberate architectural change is reviewed and implemented consistently.

Feature toggles must be checked at the call site in the appropriate coordinating module, not buried inside popup or widget classes.

When changing previews, verify:

- Repeated hover events do not create duplicate popups.
- Popup destruction removes its resources.
- Preview callbacks cannot access destroyed icons.
- Disabling the setting stops further preview interactions.
- Dock shutdown releases preview resources before their dependencies disappear.

### 9.6 Styling and icon quality

Visual styles are defined in `stylesheet.css`.

Icon size and quality settings affect rendering in `IconManager`.

When modifying visual behavior:

- Preserve consistency with the existing macOS-inspired design.
- Avoid hardcoded assumptions about monitor resolution or scale factor.
- Respect supported GNOME Shell rendering APIs.
- Avoid unnecessary icon reloads and actor reconstruction.
- Keep style changes scoped to the intended elements.
- Do not introduce Unicode emoji as replacements for proper UI icons.
- Verify that CSS selectors match the actual actor classes and style names.

Visual changes must not compromise keyboard navigation, accessibility, dock interaction, or desktop stability.

---

## 10. Settings and GSettings Schema

All settings are defined in:

`schemas/org.gnome.shell.extensions.macosdock.gschema.xml`

Settings are accessed through `Gio.Settings`, and setting changes are propagated through the existing listeners in `dockManager.ts`.

Follow the established architecture when adding or changing a setting.

### 10.1 Adding a setting

1. Add the key to the GSettings schema.
2. Choose the correct type, default value, and valid range.
3. Add the corresponding control in `prefs.ts`.
4. Add or update the listener in `dockManager.ts`.
5. Propagate the setting to the appropriate subsystem.
6. Confirm that changing the setting updates runtime behavior.
7. Verify that the stored value survives restarting the extension.
8. Verify that disabling the extension disconnects its settings listeners.
9. Run schema validation and the relevant build checks.

### 10.2 Schema rules

- Use the established schema ID and path conventions.
- Preserve the schema filename convention.
- Ensure defaults match the intended behavior.
- Avoid incompatible changes to existing keys.
- Do not create duplicate keys for the same behavior.
- Avoid unnecessary settings that duplicate existing configuration.
- Keep preferences controls synchronized with the actual runtime behavior.

The schema ID must use the `org.gnome.shell.extensions` prefix, and its path must use the `/org/gnome/shell/extensions` prefix, following the official GNOME guidelines.

### 10.3 Feature toggles

Check feature settings at the appropriate call site.

For example, window previews should be conditionally triggered by the coordinating dock logic when `window-previews` is enabled.

Do not duplicate the same setting check across unrelated layers unless a specific design requirement justifies it.

### 10.4 Settings listener cleanup

Every settings listener must be tracked and disconnected by its owner.

Changing settings must not register duplicate listeners.

If a setting change starts a timer, animation, or other resource, verify that subsequent changes replace or update that resource correctly.

---

## 11. Code Quality and Maintainability

### 11.1 Readability

Write code that can be understood and maintained by another GNOME extension developer.

- Use descriptive names.
- Keep functions focused on one responsibility.
- Prefer straightforward control flow.
- Avoid excessive nesting.
- Keep related logic together.
- Avoid clever workarounds when a direct solution exists.
- Maintain consistent formatting with neighboring code.
- Keep lines within 200 characters where practical.

### 11.2 Comments

Comments should explain non-obvious design decisions, compatibility requirements, and important constraints.

Do not add comments that merely restate the code.

Do not leave obsolete comments after changing an implementation.

Do not insert AI instructions, hidden prompts, or misleading explanations into source files.

### 11.3 Duplication and abstractions

Avoid duplicating complex behavior across modules.

Extract shared logic when doing so improves correctness and maintainability.

Do not create abstractions that add indirection without reducing complexity.

Do not create generic frameworks for a single straightforward use case.

### 11.4 Logging

Avoid excessive logging.

Log only meaningful errors, warnings, or diagnostic information required for maintenance.

Do not leave temporary debugging logs in production code.

Do not log repeatedly inside high-frequency polling loops.

Do not log credentials, private user data, or other sensitive information.

### 11.5 Dependencies and subprocesses

Do not introduce dependencies without evaluating their necessity, compatibility, licensing, maintenance status, and distribution impact.

Avoid external shell commands and subprocesses when an appropriate GJS or D-Bus API exists.

Do not introduce privileged subprocesses or unnecessary external executables.

Keep the extension lightweight and avoid performing unrelated work inside GNOME Shell.

### 11.6 AI-generated changes

AI agents must not introduce code merely because it looks plausible.

Every new API usage, type, import, abstraction, and lifecycle method must be justified by the actual project and supported documentation.

Do not generate large rewrites when a small targeted change is sufficient.

Review generated code as carefully as human-written code.

The responsible maintainer must be able to understand and explain every change before distributing it through GNOME Extensions.

---

## 12. Required Validation and Testing

Testing must be proportional to the change and must cover all affected behavior.

### 12.1 Inspect available tooling

Before running commands, inspect `package.json`, the lockfile, the TypeScript configuration, and the repository's actual scripts.

Do not invent package scripts or assume a tool is installed.

### 12.2 Build validation

The standard project build command is:

```bash
npm run build
```

Run it after relevant source changes.

The build must complete successfully without newly introduced TypeScript errors.

If the repository uses another package manager or build configuration, follow the repository's established workflow.

### 12.3 Diff validation

Run:

```bash
git diff --check
git status --short
```

Review the complete diff, including untracked files and staged changes.

### 12.4 Schema validation

When changing GSettings schemas, validate the XML and compile the schema using the available GLib tools.

For example:

```bash
glib-compile-schemas --strict schemas/
```

Run this command from the repository root if `schemas/` is the correct schema directory.

Do not modify tracked generated artifacts unless the repository requires them.

### 12.5 Static analysis

Use the repository's configured lint, formatting, and type-check commands when available.

Investigate warnings that indicate:

- Unused imports or variables.
- Invalid API usage.
- Unsafe type assertions.
- Unreachable code.
- Incorrect callback types.
- Unhandled asynchronous failures.
- Resource ownership problems.

Do not suppress warnings without understanding their cause.

### 12.6 Runtime testing

Where a suitable GNOME environment is available:

1. Install the extension using the project's documented workflow.
2. Enable it in the supported GNOME Shell version.
3. Confirm that the dock initializes without errors.
4. Test the preferences window.
5. Change relevant settings and verify runtime updates.
6. Test auto-hide at screen edges.
7. Verify window overlap detection.
8. Verify icon creation, removal, and application updates.
9. Test magnification at different configured frame rates.
10. Test window previews when enabled and disabled.
11. Disable and re-enable the extension.
12. Inspect GNOME Shell logs for new errors or warnings.
13. Confirm that the desktop remains responsive.

Use `make install` only if the repository's Makefile defines the expected installation behavior.

Do not assume that a build passing proves runtime correctness.

### 12.7 Safe runtime testing

GNOME Shell extensions run within a sensitive desktop environment.

Prefer a nested GNOME Shell session or a disposable test environment when possible.

Do not restart the user's active desktop session, terminate their shell, or make disruptive system changes without explicit authorization.

GNOME's debugging guide explains the available debugging approaches:

[https://gjs.guide/extensions/development/debugging.html](https://gjs.guide/extensions/development/debugging.html)

### 12.8 Regression testing

Test the existing functionality affected by the change.

Examples:

| Change area     | Required regression checks                           |
| --------------- | ---------------------------------------------------- |
| Lifecycle       | Enable, disable, and re-enable                       |
| Signals         | No duplicate handlers or callbacks after restart     |
| Timers          | No stale sources or callbacks after shutdown         |
| Icons           | Correct creation, removal, and map consistency       |
| Magnification   | Smooth scaling and restoration of normal scale       |
| Visibility      | Auto-hide, pointer activation, and overlap handling  |
| Window previews | Correct display, dismissal, and cleanup              |
| Settings        | Persistence and immediate runtime propagation        |
| Preferences     | Correct controls and valid stored values             |
| Stylesheet      | Correct rendering without unintended UI changes      |
| Metadata        | Valid manifest and accurate supported GNOME versions |

Adjust the test scope to the actual change, but never omit a relevant regression check merely because the modification is small.

### 12.9 Reporting validation

For each relevant check, record one of these outcomes:

- **Passed:** The check was executed and succeeded.
- **Failed:** The check was executed and did not succeed.
- **Not run:** The check was not executed.
- **Blocked:** The check could not be executed because a required tool, environment, or permission was unavailable.

Never report a blocked or unexecuted check as passed.

---

## 13. Metadata, Packaging, and Distribution

The extension's `metadata.json` must accurately describe its identity and supported GNOME Shell versions.

When modifying metadata:

- Preserve the correct extension UUID.
- Ensure the name and description are accurate.
- Verify that declared GNOME Shell versions are genuinely supported.
- Avoid declaring compatibility with untested future releases.
- Preserve required repository URLs and existing project metadata.
- Avoid unnecessary manifest fields.

GNOME Extensions treats the metadata version field as deprecated for its internal distribution workflow. Follow the repository's existing versioning convention and the current EGO requirements rather than assuming that changing this field alone publishes a release.

### Packaging

When modifying build or installation configuration:

- Ensure the extension contains the required runtime files.
- Include the compiled JavaScript and required schemas where appropriate.
- Avoid including unnecessary development dependencies or generated artifacts.
- Preserve the project's existing packaging conventions.
- Confirm that the installed extension uses the correct UUID directory.
- Do not package secrets, local machine paths, or temporary files.

### Licensing and attribution

Do not introduce code, assets, icons, or other content without checking its licensing and attribution requirements.

Preserve existing attribution notices and compatible licensing terms.

Official reference:

[https://gjs.guide/extensions/review-guidelines/review-guidelines.html](https://gjs.guide/extensions/review-guidelines/review-guidelines.html)

---

## 14. Versioning and Release Discipline

Follow semantic versioning where applicable:

- **PATCH:** Backward-compatible bug fixes.
- **MINOR:** Backward-compatible functionality additions.
- **MAJOR:** Incompatible changes to established behavior or interfaces.

Before changing version numbers:

1. Inspect the existing release workflow.
2. Determine which files are authoritative for versioning.
3. Update the appropriate files consistently.
4. Validate the build and package.
5. Ensure release metadata accurately reflects the supported GNOME Shell versions.

The repository's existing workflow may require synchronized updates to `metadata.json` and `package.json`. Verify that requirement before changing either file.

Do not bump versions, create tags, publish releases, or submit updates to GNOME Extensions unless the task or maintainer explicitly requests those actions.

---

## 15. Mandatory Final Review Checklist

Before considering any task complete, verify every applicable item below.

### Implementation

- [ ] The requested behavior is implemented.
- [ ] The solution follows existing module responsibilities.
- [ ] The implementation uses documented and compatible APIs.
- [ ] No unrelated changes were introduced.
- [ ] No speculative APIs or unnecessary dependencies were added.
- [ ] All affected callers and interfaces were reviewed.

### Lifecycle and resources

- [ ] Resources are initialized in the correct lifecycle phase.
- [ ] Every resource has a clear owner.
- [ ] All signal connections are tracked through `SignalManager`.
- [ ] All GLib sources and timeouts are tracked and removed.
- [ ] Timers cannot be duplicated accidentally.
- [ ] Callbacks cannot access destroyed resources.
- [ ] Child resources are stopped before their dependencies are destroyed.
- [ ] References and collections are cleared appropriately.
- [ ] No lifecycle guard flags were introduced as a workaround.
- [ ] `enable()` and `disable()` remain easy to compare.

### GNOME standards

- [ ] No deprecated modules were introduced.
- [ ] Process-specific imports remain isolated.
- [ ] Public APIs are preferred over private internals.
- [ ] No unnecessary logging or silent error suppression was introduced.
- [ ] UI changes follow established GNOME conventions where applicable.
- [ ] Metadata and schema changes follow GNOME requirements.

### Review and validation

- [ ] Every individual modification was reviewed.
- [ ] The complete final diff was inspected.
- [ ] New files and staged changes were reviewed.
- [ ] `git diff --check` was executed where available.
- [ ] The relevant build completed successfully, or its status was documented.
- [ ] Relevant schema, lint, type, and runtime checks were performed where available.
- [ ] Relevant regression scenarios were evaluated.
- [ ] Failed, blocked, and unexecuted tests were reported honestly.
- [ ] No known critical regression remains unresolved.

If an applicable item cannot be satisfied, do not silently mark the task complete. Explain the issue, its impact, and what remains necessary.

---

## 16. Required Completion Report

At the end of every coding task, provide a concise report containing:

### Summary

Describe what changed and why.

### Files modified

List the files changed and the responsibility of each modification.

### GNOME compliance review

Summarize the relevant lifecycle, signal, timer, API, and architectural checks performed.

### Validation results

List the commands and tests actually executed, including failures or blocked checks.

### Remaining concerns

Identify unresolved issues, compatibility uncertainties, or runtime checks that could not be performed.

Do not claim that the extension is fully validated if only TypeScript compilation was performed.

Do not claim that the extension is compatible with a GNOME Shell version that was not verified.

Do not hide known regressions behind a successful build.

---

## 17. Final Rule

**Every change must be implemented, reviewed, validated, and reported as a complete engineering task.**

The goal is not simply to make MacOS Dock work in the immediate case. The goal is to keep it stable, maintainable, efficient, compatible with supported GNOME Shell releases, and suitable for distribution through GNOME Extensions.

When uncertain, inspect the code, consult the official documentation, test the actual implementation, and explain the uncertainty instead of guessing.

Stability and correct resource ownership take priority over implementation speed.
