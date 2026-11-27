// SPDX-License-Identifier: GPL-3.0-or-later
// Tile: arranges the windows of each monitor in the chosen layout (see layouts.js), and keeps them so as windows come and go.
// Off until switched on (`enabled`): nothing is moved before that. Dialogs, full-screen, maximized, minimized and floated windows
// are left as they are.
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {PACKAGE_VERSION} from 'resource:///org/gnome/shell/misc/config.js';

import {arrange, dwindleSplits, inner, LAYOUT_IDS, LAYOUTS} from './layouts.js';
import {LayoutSwitcher} from './switcher.js';
import {activeProfileId, createGuard, createOpacityControl, fromLegacy, evaluate as evaluateRules, parseRules as parseAdvanced, pending as pendingActions, setsOpacity, usesProfile} from './windowRules.js';
import {matchRule, neighbor, parseLayoutMap, parseRules, resolveLayout, withLayout, withoutLayout} from './config.js';
import {createWorkspaceService} from './workspace.js';

// The pure cores of the groups, snapshots and monitor recovery are copied beside this file (./shared) by the package. Imported at run time
// so a Tile installed without them still tiles: the new D-Bus methods then answer that they are not installed.
let WORKSPACE_CORE = null;
try {
    WORKSPACE_CORE = {
        groups: await import('./shared/windowGroups.js'),
        snapshot: await import('./shared/snapshot.js'),
        monitors: await import('./shared/monitorManager.js'),
    };
} catch (e) {
    console.warn(`Tile: workspace cores not available (${e.message}); groups, snapshots and monitor recovery are off`);
}

const RETILE_MS = 60;
const SHELL_MAJOR = parseInt(PACKAGE_VERSION.split('.')[0], 10);
const unmaximize = win => (SHELL_MAJOR >= 49 ? win.unmaximize() : win.unmaximize(Meta.MaximizeFlags.BOTH));
// the grab operations that pull a window's edge or corner
const RESIZING = new Set(Object.entries(Meta.GrabOp).filter(([name]) => /^RESIZING/.test(name)).map(([, v]) => v));
const isMaximized = win => Boolean(win.maximized_horizontally && win.maximized_vertically);
const KEYS = ['toggle', 'layout', 'promote', 'float', 'grow', 'shrink', 'switcher',
    'focus-left', 'focus-right', 'focus-up', 'focus-down', 'swap-left', 'swap-right', 'swap-up', 'swap-down'];

// What other programs may ask of the tiling, and read from it (the command line and the panel use this)
const DBUS_XML = `<node><interface name="org.niro.Tile">
  <method name="GetState"><arg type="s" direction="out" name="json"/></method>
  <method name="ListLayouts"><arg type="s" direction="out" name="json"/></method>
  <method name="ApplyLayout"><arg type="s" direction="in" name="layout"/><arg type="i" direction="in" name="workspace"/><arg type="i" direction="in" name="monitor"/><arg type="b" direction="out" name="ok"/></method>
  <method name="ClearLayout"><arg type="i" direction="in" name="workspace"/><arg type="i" direction="in" name="monitor"/></method>
  <method name="SetEnabled"><arg type="b" direction="in" name="enabled"/></method>
  <method name="Retile"/>
  <method name="GetWorkspaceApi"><arg type="s" direction="out" name="json"/></method>
  <method name="GroupsCall"><arg type="s" direction="in" name="op"/><arg type="s" direction="in" name="args"/><arg type="s" direction="out" name="json"/></method>
  <method name="SnapshotsCall"><arg type="s" direction="in" name="op"/><arg type="s" direction="in" name="args"/><arg type="s" direction="out" name="json"/></method>
  <method name="MonitorStatus"><arg type="s" direction="out" name="json"/></method>
  <method name="ApplyRules"><arg type="s" direction="out" name="json"/></method>
  <method name="ApplyRulesPreview"><arg type="s" direction="out" name="json"/></method>
  <signal name="StateChanged"/>
</interface></node>`;

export default class Tile extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._order = [];                 // windows in tile order: the first is the main one
        this._floating = new Set();       // windows the user took out of the tiling
        this._winSignals = new Map();
        this._signals = [];
        this._retileId = 0;
        this._state = new Map();          // window: "maximized|fullscreen" when last looked at
        this._dragging = null;            // the tiled window being moved with the pointer
        this._ghosts = [];                // the preview of the layout shown while a window is carried
        this._ghostTimer = 0;
        this._ghostCell = null;           // {monitor, index}: the tile the carried window would take
        this._resizing = null;            // the tiled window whose edge is being pulled
        this._ratios = new Map();         // monitor: Dwindle's split shares, made by resizing
        this._weights = new Map();        // monitor: the sizes of Horizontal and Vertical's tiles, made by resizing
        this._shape = new Map();          // monitor: which layout and count those belong to; another and they are forgotten
        this._placed = new WeakSet();     // windows the tiling has put in a tile: one of them maximized afterwards stays maximized
        this._map = parseLayoutMap(this._settings.get_string('layout-map'));
        this._rules = parseRules(this._settings.get_string('window-rules'));
        this._profile = null;             // the active profile id, read from Niro Control's state file (only while a rule asks for it)
        this._profileMonitor = null;
        this._opacity = createOpacityControl(w => w.get_compositor_private());
        this._engine = this._loadEngine();
        this._guard = createGuard();      // a rule may act on one window only a few times in a short while: nothing can loop
        this._workspace = WORKSPACE_CORE ? createWorkspaceService({core: WORKSPACE_CORE, host: this._workspaceHost()}) : null;

        // The lock screen disables and re-enables Tile: windows already open then are not new, so the automatic rules leave them alone.
        // At login (shell still starting, not a restart) every window is new.
        const login = Main.layoutManager._startingUp && !Meta.is_restart?.();
        this._preexisting = new WeakSet(login ? [] : global.get_window_actors().map(a => a.meta_window));
        const wm = global.window_manager;
        const display = global.display;
        const again = () => this._schedule();
        for (const s of ['destroy', 'minimize', 'unminimize', 'map', 'switch-workspace'])
            this._signals.push([wm, wm.connect(s, again)]);
        for (const s of ['window-created', 'in-fullscreen-changed', 'workareas-changed', 'window-entered-monitor', 'window-left-monitor'])
            this._signals.push([display, display.connect(s, again)]);
        this._signals.push([Main.layoutManager, Main.layoutManager.connect('monitors-changed', again)]);
        // Opt-in (monitor-recovery): windows of a monitor that left go to the primary, and back when it returns. Windows only; no display setting is written.
        this._signals.push([Main.layoutManager, Main.layoutManager.connect('monitors-changed', () => this._workspace?.monitorsChanged())]);
        // Drag and drop: moving a tiled window over another and letting go swaps their places
        this._signals.push([display, display.connect('grab-op-begin', (_d, win, op) => this._beginDrag(win, op))]);
        this._signals.push([display, display.connect('grab-op-end', (_d, win) => this._endDrag(win))]);
        this._signals.push([this._settings, this._settings.connect('changed::layout-map', () => {
            this._map = parseLayoutMap(this._settings.get_string('layout-map'));
            this._schedule();
        })]);
        this._signals.push([this._settings, this._settings.connect('changed::window-rules', () => {
            this._rules = parseRules(this._settings.get_string('window-rules'));
            this._engine = this._loadEngine();
            this._schedule();
        })]);
        for (const key of ['rules-engine', 'advanced-rules'])
            this._signals.push([this._settings, this._settings.connect(`changed::${key}`, () => {
                this._engine = this._loadEngine();
                this._schedule();
            })]);
        for (const key of ['enabled', 'layout', 'gap-inner', 'gap-outer', 'master-factor', 'column-width', 'floating-apps'])
            this._signals.push([this._settings, this._settings.connect(`changed::${key}`, again)]);
        this._signals.push([this._settings, this._settings.connect('changed::enabled', () => this._osd(this._settings.get_boolean('enabled') ? 'Tiling on' : 'Tiling off'))]);
        this._signals.push([this._settings, this._settings.connect('changed::layout', () => this._osd(this._layoutTitle()))]);

        const handlers = {
            toggle: () => this._settings.set_boolean('enabled', !this._settings.get_boolean('enabled')),
            layout: () => this._nextLayout(),
            promote: () => this._promote(),
            float: () => this._toggleFloat(),
            grow: () => this._grow(0.05),
            shrink: () => this._grow(-0.05),
            switcher: () => this._openSwitcher(),
        };
        for (const dir of ['left', 'right', 'up', 'down']) {
            handlers[`focus-${dir}`] = () => this._focusDir(dir);
            handlers[`swap-${dir}`] = () => this._swapDir(dir);
        }
        for (const key of KEYS)
            Main.wm.addKeybinding(`shortcut-${key}`, this._settings, Meta.KeyBindingFlags.NONE, Shell.ActionMode.NORMAL, handlers[key]);
        this._exportDBus();
        this._workspace?.noteWindows();
        this._schedule();
    }

    disable() {
        this._unexportDBus();
        this._closeSwitcher?.();
        for (const key of KEYS)
            Main.wm.removeKeybinding(`shortcut-${key}`);
        for (const [source, id] of this._signals)
            source.disconnect(id);
        this._signals = [];
        for (const [win, ids] of this._winSignals) {
            for (const id of ids) {
                try { win.disconnect(id); } catch (_e) { /* gone */ }
            }
        }
        this._winSignals.clear();
        if (this._retileId) {
            GLib.Source.remove(this._retileId);
            this._retileId = 0;
        }
        this._order = [];
        this._floating = null;
        this._state = null;
        this._stopGhost();
        this._ratios = this._weights = this._shape = null;
        this._placed = null;
        this._preexisting = null;
        this._map = null;
        this._rules = null;
        this._opacity?.restoreAll();
        this._opacity = null;
        this._stopProfileWatch();
        this._engine = null;
        this._guard?.clear();
        this._guard = null;
        this._workspace = null;
        this._settings = null;
    }

    // ---- Which windows, and in which order

    _eligible(win) {
        if (!win || win.window_type !== Meta.WindowType.NORMAL || win.skip_taskbar || win.is_override_redirect?.())
            return false;
        if (win.minimized || win.fullscreen)
            return false;
        // A window maximized before the tiling took it is brought into a tile; one the person maximized afterwards is left maximized
        if (isMaximized(win) && this._placed.has(win))
            return false;
        if (this._floating.has(win) || win.get_transient_for())
            return false;
        // With workspaces only on the primary monitor (GNOME's default) a window on another monitor belongs to every workspace: it is tiled there. A window
        // the person put on all workspaces on the primary monitor is not.
        if (win.is_on_all_workspaces() && !(this._otherMonitorsSticky() && win.get_monitor() !== global.display.get_primary_monitor()))
            return false;
        // allows_move()/allows_resize() are false while a window is maximized: a window that can be resized at all is meant
        if (!win.resizeable || (!isMaximized(win) && (!win.allows_move() || !win.allows_resize())))
            return false;
        const tile = this._engineActions(win).tile;
        if (tile === 'float')
            return false;
        if (tile === 'tile')
            return true;
        const rule = matchRule(this._rules, this._classes(win));
        if (rule?.action === 'float')
            return false;
        if (rule?.action === 'tile')
            return true;
        const floating = this._settings.get_strv('floating-apps');
        return !this._classes(win).some(c => c && floating.includes(c));
    }

    _otherMonitorsSticky() {
        try {
            return new Gio.Settings({schema_id: 'org.gnome.mutter'}).get_boolean('workspaces-only-on-primary');
        } catch (_e) {
            return true;
        }
    }

    /** The advanced rules (they come before the simple ones), or none while the engine is off. Windows are read, never changed, here. */
    _loadEngine() {
        const rules = this._settings.get_boolean('rules-engine') ? parseAdvanced(this._settings.get_string('advanced-rules')) : [];
        this._wantsOpacity = setsOpacity(rules);
        if (usesProfile(rules))
            this._watchProfile();
        else
            this._stopProfileWatch();
        return rules;
    }

    _profilePath() {
        return `${GLib.get_user_config_dir()}/niro-control/state.json`;
    }

    _readProfile() {
        try {
            const [ok, bytes] = Gio.File.new_for_path(this._profilePath()).load_contents(null);
            this._profile = ok ? activeProfileId(new TextDecoder().decode(bytes)) : null;
        } catch (_e) {
            this._profile = null;   // no state file yet: no profile is active
        }
    }

    /** A profile is applied by the panel or Search rewriting state.json: watched only while a rule has a `profile` condition. */
    _watchProfile() {
        if (this._profileMonitor)
            return;
        this._readProfile();
        try {
            this._profileMonitor = Gio.File.new_for_path(this._profilePath()).monitor_file(Gio.FileMonitorFlags.NONE, null);
            this._profileMonitorId = this._profileMonitor.connect('changed', () => {
                const before = this._profile;
                this._readProfile();
                if (before !== this._profile)
                    this._schedule();
            });
        } catch (_e) { this._profileMonitor = null; }
    }

    _stopProfileWatch() {
        if (this._profileMonitor) {
            try { this._profileMonitor.disconnect(this._profileMonitorId); this._profileMonitor.cancel(); } catch (_e) { /* gone */ }
        }
        this._profileMonitor = null;
        this._profile = null;
    }

    /** Opacity from the rules, for the windows in play; put back for a window no rule matches any more. Compositor-only: no window setting is changed. */
    _applyOpacity() {
        if (!this._opacity)
            return;
        if (!this._wantsOpacity && !this._opacity.size())
            return;
        for (const w of this._order)
            this._opacity.apply(w, this._engineActions(w).opacity);
    }

    _engineActions(win) {
        return this._engineEval(win).actions;
    }

    /** `{actions, from}` the advanced rules give a window (empty while the engine is off). Reads the window, never changes it. */
    _engineEval(win) {
        if (!this._engine?.length)
            return {actions: {}, from: {}};
        const type = {[Meta.WindowType.NORMAL]: 'normal', [Meta.WindowType.DIALOG]: 'dialog', [Meta.WindowType.UTILITY]: 'utility'}[win.window_type] ?? 'other';
        return evaluateRules(this._engine, {
            appIds: this._classes(win), title: win.get_title?.() ?? '', workspace: (win.get_workspace()?.index() ?? 0) + 1,
            monitor: win.get_monitor(), type,
        }, {profile: this._profile});
    }

    /** What the rules compare a window with, as it is now. `wantedOpacity`: the rule's value, so a rounding of the actor's 0..255 is not a difference. */
    _factsOf(w, wantedOpacity) {
        const actor = w.get_compositor_private();
        let opacity;
        if (actor)
            opacity = typeof wantedOpacity === 'number' && actor.opacity === Math.round(wantedOpacity * 255) ? wantedOpacity : actor.opacity / 255;
        return {
            workspace: w.is_on_all_workspaces() ? 0 : (w.get_workspace()?.index() ?? 0) + 1, monitor: w.get_monitor(), floating: this._floating.has(w),
            above: Boolean(w.is_above?.()), opacity, fullscreen: Boolean(w.fullscreen),
        };
    }

    /**
     * Evaluates the advanced rules for one window and applies what would change (only `keys`, when given); `dry` applies nothing.
     * Returns `{windowId, appId, title, actions, from, skipped?: [{key, reason}]}`, or null when no rule has anything to change.
     * What is already as the rules want is left out (pending), and a rule that already acted on the window several times in a short while
     * is refused (the loop guard), so calling this again changes nothing.
     */
    _applyEngineTo(w, {dry, keys = null}) {
        if (!this._engine?.length || !w.get_compositor_private())
            return null;
        const ev = this._engineEval(w);
        const wanted = keys ? Object.fromEntries(Object.entries(ev.actions).filter(([k]) => keys.includes(k))) : ev.actions;
        if (!Object.keys(wanted).length)
            return null;
        const todo = pendingActions(wanted, this._factsOf(w, wanted.opacity));
        const skipped = [];
        const drop = (k, reason) => { delete todo[k]; skipped.push({key: k, reason}); };
        if ('workspace' in todo && w.is_on_all_workspaces())
            drop('workspace', 'the window is on all workspaces');
        else if ('workspace' in todo && todo.workspace > global.workspace_manager.get_n_workspaces())
            drop('workspace', `there is no workspace ${todo.workspace}`);
        if ('monitor' in todo && todo.monitor >= global.display.get_n_monitors())
            drop('monitor', `there is no monitor ${todo.monitor}`);
        if (!dry) {
            const asked = new Map();
            for (const k of Object.keys(todo)) {
                const rule = ev.from[k];
                if (!asked.has(rule))
                    asked.set(rule, this._guard.allow(w.get_id(), rule, Date.now()));
                if (!asked.get(rule))
                    drop(k, `rule "${rule}" has just acted on this window several times (loop guard)`);
            }
        }
        const base = {windowId: w.get_id(), appId: w.get_gtk_application_id?.() || w.get_wm_class() || '', title: w.get_title() ?? ''};
        if (!Object.keys(todo).length)
            return skipped.length ? {...base, actions: {}, from: {}, skipped} : null;
        const from = Object.fromEntries(Object.keys(todo).map(k => [k, ev.from[k]]));
        if (!dry) {
            for (const [k, v] of Object.entries(todo)) {
                try {
                    if (k === 'workspace') w.change_workspace_by_index(v - 1, false);
                    else if (k === 'monitor') w.move_to_monitor(v);
                    else if (k === 'tile') { if (v === 'float') this._floating.add(w); else this._floating.delete(w); }
                    else if (k === 'above') { if (v) w.make_above(); else w.unmake_above(); }
                    else if (k === 'opacity') this._opacity?.apply(w, v);
                    else if (k === 'fullscreen') { if (v) w.make_fullscreen(); else w.unmake_fullscreen(); }
                } catch (e) {
                    skipped.push({key: k, reason: e.message});
                    delete todo[k];
                }
            }
        }
        return skipped.length ? {...base, actions: todo, from, skipped} : {...base, actions: todo, from};
    }

    /**
     * One explicit pass of the advanced rules over every open normal window (the first-seen pass never looks at windows already open).
     * Refused while the engine is off. `dry`: the same answer, nothing changed. No timer, no listener: a second call finds nothing pending.
     */
    _applyRules(dry) {
        const answer = {api: 1, ok: true, dryRun: dry, applied: [], skipped: [], notes: []};
        if (!this._settings?.get_boolean('rules-engine'))
            return {...answer, ok: false, error: 'the rules engine is off: switch on "Use the advanced rules" first (nothing was changed)'};
        if (!this._engine?.length)
            return {...answer, notes: ['there are no valid, enabled advanced rules']};
        const windows = global.get_window_actors().map(a => a.meta_window).filter(w => w && w.window_type === Meta.WindowType.NORMAL && !w.skip_taskbar);
        for (const w of windows) {
            let r = null;
            try {
                r = this._applyEngineTo(w, {dry});
            } catch (e) {
                answer.skipped.push({windowId: w.get_id(), appId: w.get_wm_class() ?? '', reason: e.message});
                continue;
            }
            if (!r)
                continue;
            const {skipped, ...entry} = r;
            if (Object.keys(entry.actions).length)
                answer.applied.push(entry);
            for (const s of skipped ?? [])
                answer.skipped.push({windowId: entry.windowId, appId: entry.appId, ...s});
        }
        if (!dry && answer.applied.length)
            this._schedule();
        answer.notes.push(`${windows.length} window(s) looked at, ${answer.applied.length} ${dry ? 'would change' : 'changed'}`);
        return answer;
    }

    /** The names a window is known by: the X11 instance, the class (the Wayland app id) and the desktop id. */
    _classes(win) {
        return [win.get_wm_class_instance(), win.get_wm_class(), win.get_gtk_application_id?.()];
    }

    /** Takes in the windows that are new and lets go of the ones that are gone. */
    _sync() {
        const alive = new Set(global.get_window_actors().map(a => a.meta_window).filter(w => w && w.window_type === Meta.WindowType.NORMAL));
        this._order = this._order.filter(w => alive.has(w));
        for (const w of [...this._winSignals.keys()]) {
            if (!alive.has(w)) {
                this._opacity?.forget(w);
                try { this._winSignals.get(w).forEach(id => w.disconnect(id)); } catch (_e) { /* gone */ }
                this._winSignals.delete(w);
                this._floating.delete(w);
                this._state.delete(w);
            }
        }
        for (const w of alive) {
            if (this._order.includes(w) || !w.get_compositor_private())
                continue;
            this._order.push(w);
            // Rules run once, when a new window is first seen (so nothing can re-apply in a loop); opacity is kept up to date in _applyOpacity.
            // Windows already open at enable() are only touched by the explicit ApplyRules call.
            if (!this._preexisting.has(w)) {
                const rule = matchRule(this._rules, this._classes(w));
                if (rule?.workspace && rule.workspace <= global.workspace_manager.get_n_workspaces())
                    w.change_workspace_by_index(rule.workspace - 1, false);
                try {
                    this._applyEngineTo(w, {dry: false, keys: ['workspace', 'monitor', 'above', 'fullscreen']});
                } catch (e) {
                    console.warn(`Tile: rules on a new window: ${e.message}`);
                }
            }
            const ids = [w.connect('workspace-changed', () => this._schedule())];
            ids.push(w.connect('notify::title', () => { if (this._wantsOpacity) this._schedule(); }));   // a rule may match on the title
            // maximizing or full screen takes a window out of the tiling and back: looked at when its size changes
            ids.push(w.connect('size-changed', () => {
                const now = `${isMaximized(w)}|${w.fullscreen}`;
                if (this._state.get(w) !== now) {
                    this._state.set(w, now);
                    this._schedule();
                }
            }));
            this._winSignals.set(w, ids);
            this._state.set(w, `${isMaximized(w)}|${w.fullscreen}`);
        }
    }

    // ---- Tiling

    _schedule() {
        // not while a window is carried: it would be put back under the pointer
        if (this._retileId || !this._settings || this._dragging || this._resizing)
            return;
        this._retileId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, RETILE_MS, () => {
            this._retileId = 0;
            try {
                this._retile();
                this._stateChanged();
                this._workspace?.noteWindows();
            } catch (e) {
                console.warn(`Tile: ${e.message}`);
            }
            return GLib.SOURCE_REMOVE;
        });
    }

    _retile() {
        if (!this._settings)
            return;
        this._sync();
        this._applyOpacity();
        if (!this._settings.get_boolean('enabled'))
            return;
        const workspace = global.workspace_manager.get_active_workspace();
        const focus = global.display.focus_window;
        for (let monitor = 0; monitor < global.display.get_n_monitors(); monitor++) {
            const layout = this._layoutAt(monitor);
            const windows = this._order.filter(w => this._eligible(w) && (w.is_on_all_workspaces() || w.get_workspace() === workspace) && w.get_monitor() === monitor);
            if (!windows.length)
                continue;
            const area = Main.layoutManager.getWorkAreaForMonitor(monitor);
            const rects = arrange(layout, windows.length, {x: area.x, y: area.y, width: area.width, height: area.height},
                this._options(Math.max(0, windows.indexOf(focus)), monitor, windows.length));
            windows.forEach((w, i) => this._place(w, rects[i]));
            if (layout === 'monocle' && focus && windows.includes(focus))
                focus.raise();
        }
    }

    _place(win, r) {
        if (isMaximized(win))
            unmaximize(win);
        this._placed.add(win);
        const now = win.get_frame_rect();
        if (now.x === r.x && now.y === r.y && now.width === r.width && now.height === r.height)
            return;
        win.move_resize_frame(true, r.x, r.y, r.width, r.height);
        this._glide(win, now, r);
        this._holdMinimum(win, r);
    }

    /**
     * A window cannot always get as small as its tile (it has a minimum size of its own). Mutter then answers the request with a place
     * of its own choosing, so once the window has settled it is put back at the tile's corner, as big as it insists on being.
     */
    _holdMinimum(win, r) {
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 120, () => {
            try {
                if (this._settings && this._placed?.has(win) && win.get_compositor_private()) {
                    const f = win.get_frame_rect();
                    if ((f.width > r.width || f.height > r.height) && (f.x !== r.x || f.y !== r.y))
                        win.move_frame(true, r.x, r.y);
                }
            } catch (_e) { /* the window is gone */ }
            return GLib.SOURCE_REMOVE;
        });
    }

    /** The window glides from where it was to where it went, rather than jumping: its picture is moved back and let go. */
    _glide(win, from, to) {
        const actor = win.get_compositor_private();
        if (!actor || !this._settings.get_boolean('animate') || !St.Settings.get().enable_animations)
            return;
        const dx = from.x - to.x, dy = from.y - to.y;
        if (!dx && !dy)
            return;
        actor.remove_all_transitions();
        actor.translation_x = dx;
        actor.translation_y = dy;
        actor.ease({translation_x: 0, translation_y: 0, duration: 200, mode: Clutter.AnimationMode.EASE_OUT_CUBIC});
    }

    // ---- Drag and drop, with a preview of the layout
    //
    // While a tiled window is carried, the layout it would make is drawn over the screen: one outlined cell for each tile (the carried
    // window included), the cell under the pointer lit. Letting go puts the window in that cell and the others move over for it.

    _beginDrag(win, op) {
        if (!this._settings?.get_boolean('enabled') || !this._order.includes(win) || !this._eligible(win))
            return;
        if (op === Meta.GrabOp.MOVING) {
            this._dragging = win;
            this._startGhost();
        } else if (RESIZING.has(op)) {
            this._resizing = win;   // the tiling waits; the new size is taken in when the edge is let go
        }
    }

    _endDrag(win) {
        if (this._resizing && this._resizing === win) {
            this._resizing = null;
            try {
                this._resized(win);
            } catch (e) {
                console.warn(`Tile: ${e.message}`);
            }
            this._schedule();
            return;
        }
        if (!this._dragging || this._dragging !== win)
            return;
        this._dragging = null;
        const cell = this._ghostCell;
        this._stopGhost();
        if (cell)
            this._insertAt(win, cell.monitor, cell.index);
        this._schedule();
    }

    /** The tiled windows of a monitor on the active workspace, but for `except`, in tile order. */
    _tiledOn(monitor, except) {
        const workspace = global.workspace_manager.get_active_workspace();
        return this._order.filter(w => w !== except && this._eligible(w) && (w.is_on_all_workspaces() || w.get_workspace() === workspace) && w.get_monitor() === monitor);
    }

    /** The layout of a monitor on the active workspace: the workspace's own, else the monitor's, else the general one. */
    _layoutAt(monitor) {
        const workspace = global.workspace_manager.get_active_workspace_index();
        return resolveLayout(this._map, workspace, monitor, this._settings.get_string('layout'));
    }

    _options(focus = 0, monitor = -1, count = 0) {
        // what resizing made belongs to one layout and one number of windows on a monitor: another, and it starts over
        const key = `${this._layoutAt(monitor)}:${count}`;
        const mine = this._shape.get(monitor) === key;
        return {
            gapInner: this._settings.get_int('gap-inner'),
            gapOuter: this._settings.get_int('gap-outer'),
            masterFactor: this._settings.get_double('master-factor'),
            columnWidth: this._settings.get_double('column-width'),
            focus,
            ratios: mine ? this._ratios.get(monitor) : undefined,
            weights: mine ? this._weights.get(monitor) : undefined,
        };
    }

    _monitorAt(x, y) {
        const monitors = Main.layoutManager.monitors;
        const i = monitors.findIndex(m => x >= m.x && x < m.x + m.width && y >= m.y && y < m.y + m.height);
        return i >= 0 ? i : global.display.get_primary_monitor();
    }

    /** The cell of `rects` the point is in, else the nearest by its centre. */
    _cellAt(rects, x, y) {
        const inside = rects.findIndex(r => x >= r.x && x < r.x + r.width && y >= r.y && y < r.y + r.height);
        if (inside >= 0)
            return inside;
        let best = 0, bestD = Infinity;
        rects.forEach((r, i) => {
            const d = (r.x + r.width / 2 - x) ** 2 + (r.y + r.height / 2 - y) ** 2;
            if (d < bestD) { best = i; bestD = d; }
        });
        return best;
    }

    _startGhost() {
        this._stopGhost();
        this._updateGhost();
        this._ghostTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 40, () => {
            this._updateGhost();
            return GLib.SOURCE_CONTINUE;
        });
    }

    _stopGhost() {
        if (this._ghostTimer) {
            GLib.Source.remove(this._ghostTimer);
            this._ghostTimer = 0;
        }
        for (const g of this._ghosts)
            g.destroy();
        this._ghosts = [];
        this._ghostCell = null;
    }

    _updateGhost() {
        const win = this._dragging;
        if (!win || !this._settings)
            return;
        const [x, y] = global.get_pointer();
        const monitor = this._monitorAt(x, y);
        const others = this._tiledOn(monitor, win);
        const area = Main.layoutManager.getWorkAreaForMonitor(monitor);
        const rects = arrange(this._layoutAt(monitor), others.length + 1, {x: area.x, y: area.y, width: area.width, height: area.height}, this._options(0, -1, others.length + 1));
        const shown = rects.filter(r => !r.hidden);
        const index = this._cellAt(shown, x, y);
        this._ghostCell = {monitor, index};
        while (this._ghosts.length < shown.length) {
            const g = new St.Widget({style_class: 'tile-ghost', reactive: false});
            Main.layoutManager.uiGroup.add_child(g);
            this._ghosts.push(g);
        }
        while (this._ghosts.length > shown.length)
            this._ghosts.pop().destroy();
        shown.forEach((r, i) => {
            const g = this._ghosts[i];
            g.set_position(r.x, r.y);
            g.set_size(r.width, r.height);
            if (i === index)
                g.add_style_pseudo_class('active');
            else
                g.remove_style_pseudo_class('active');
        });
    }

    /**
     * `win` was resized by hand: what the new size says about the layout is kept, so the others follow. The main window of the Master
     * layouts sets the master size, the columns of Scrolling set their width, and Dwindle, Horizontal and Vertical keep the shares.
     * Grid, Three columns and Monocle have no sizes to set: the window goes back.
     */
    _resized(win) {
        const monitor = win.get_monitor();
        const windows = this._tiledOn(monitor);
        const i = windows.indexOf(win);
        const n = windows.length;
        if (i < 0)
            return;
        const layout = this._layoutAt(monitor);
        const area = Main.layoutManager.getWorkAreaForMonitor(monitor);
        const opts = this._options(0, monitor, n);
        const a = inner({x: area.x, y: area.y, width: area.width, height: area.height}, opts.gapOuter);
        const rects = arrange(layout, n, {x: area.x, y: area.y, width: area.width, height: area.height}, opts);
        const f = win.get_frame_rect();
        const dw = Math.abs(f.width - rects[i].width) >= 4;
        const dh = Math.abs(f.height - rects[i].height) >= 4;
        if (!dw && !dh)
            return;
        const gap = opts.gapInner;
        const keep = (field, value, lo, hi) => this._settings.set_double(field, Math.round(Math.max(lo, Math.min(hi, value)) * 100) / 100);
        const remember = (ratios, weights) => {
            this._shape.set(monitor, `${layout}:${n}`);
            if (ratios) this._ratios.set(monitor, ratios);
            if (weights) this._weights.set(monitor, weights);
        };
        switch (layout) {
        case 'master-left':
        case 'master-right':
        case 'center-master': {
            if (n < 2 || !dw)
                break;
            const centre = layout === 'center-master' && n >= 3;
            const room = a.width - (centre ? 2 : 1) * gap;
            keep('master-factor', i === 0 ? f.width / room : 1 - (centre ? 2 : 1) * f.width / room, 0.1, 0.9);
            break;
        }
        case 'scrolling':
            if (dw)
                keep('column-width', f.width / a.width, 0.2, 1);
            break;
        case 'horizontal':
            if (dw)
                remember(null, rects.map((r, k) => (k === i ? f.width : r.width)));
            break;
        case 'vertical':
            if (dh)
                remember(null, rects.map((r, k) => (k === i ? f.height : r.height)));
            break;
        case 'dwindle': {
            if (n < 2)
                break;
            const splits = dwindleSplits(n, a, gap, opts.ratios);
            const ratios = splits.map(sp => sp.share);
            if (i < n - 1) {   // the window is the first half of its own split
                const sp = splits[i];
                if (sp.wide && dw)
                    ratios[i] = f.width / (sp.rest.width - gap);
                else if (!sp.wide && dh)
                    ratios[i] = f.height / (sp.rest.height - gap);
            }
            if (i >= 1) {   // and the second half of the one before: it gives the space the window has left, when its size says so
                const sp = splits[i - 1];
                const ownWide = i < n - 1 ? splits[i].wide : null;
                if (sp.wide && dw && (ownWide === null || !ownWide))
                    ratios[i - 1] = 1 - f.width / (sp.rest.width - gap);
                else if (!sp.wide && dh && (ownWide === null || ownWide))
                    ratios[i - 1] = 1 - f.height / (sp.rest.height - gap);
            }
            remember(ratios.map(r => Math.max(0.1, Math.min(0.9, r))), null);
            break;
        }
        default:
            break;   // no sizes to keep: it goes back to its tile
        }
    }

    /** `win` goes to place `index` among the tiled windows of `monitor`; the others move over. */
    _insertAt(win, monitor, index) {
        if (win.get_monitor() !== monitor)
            win.move_to_monitor(monitor);
        const others = this._tiledOn(monitor, win);
        this._order = this._order.filter(w => w !== win);
        const before = others[index];
        if (before)
            this._order.splice(this._order.indexOf(before), 0, win);
        else if (others.length)
            this._order.splice(this._order.indexOf(others[others.length - 1]) + 1, 0, win);
        else
            this._order.push(win);
    }

    // ---- Directional focus and swap

    /** The tiled window nearest in `direction` to the focused one, and the list it was found in. */
    _neighborOf(direction) {
        const win = global.display.focus_window;
        if (!win || !this._eligible(win))
            return null;
        const windows = this._tiledOn(win.get_monitor());
        const from = windows.indexOf(win);
        if (from < 0)
            return null;
        const to = neighbor(windows.map(w => w.get_frame_rect()), from, direction);
        return to < 0 ? null : {win, other: windows[to]};
    }

    _focusDir(direction) {
        const found = this._neighborOf(direction);
        if (found)
            found.other.activate(global.get_current_time());
    }

    _swapDir(direction) {
        const found = this._neighborOf(direction);
        if (!found)
            return;
        const a = this._order.indexOf(found.win);
        const b = this._order.indexOf(found.other);
        [this._order[a], this._order[b]] = [found.other, found.win];
        this._schedule();
    }

    /** The quick layout switcher: the ten layouts over the active monitor; the one chosen goes to the active workspace. */
    _openSwitcher() {
        if (this._switcher) {
            this._closeSwitcher();
            return;
        }
        const monitorIndex = global.display.focus_window?.get_monitor() ?? global.display.get_primary_monitor();
        const workspace = global.workspace_manager.get_active_workspace_index();
        this._switcher = new LayoutSwitcher({
            current: this._layoutAt(monitorIndex),
            workspace: workspace + 1,
            closed: () => { this._switcher = null; },
            apply: layout => {
                this.applyLayout(layout, {workspace});
                this._osd(LAYOUTS.find(l => l[0] === layout)[1]);
            },
        });
        if (!this._switcher.open(Main.layoutManager.monitors[monitorIndex]))
            this._switcher = null;
    }

    _closeSwitcher() {
        this._switcher?.close();
        this._switcher = null;
    }

    // ---- What other programs see and ask (D-Bus: org.niro.Tile)

    _exportDBus() {
        try {
            this._dbus = Gio.DBusExportedObject.wrapJSObject(DBUS_XML, this);
            this._dbus.export(Gio.DBus.session, '/org/niro/Tile');
            this._nameId = Gio.bus_own_name_on_connection(Gio.DBus.session, 'org.niro.Tile', Gio.BusNameOwnerFlags.NONE, null, null);
        } catch (e) {
            console.warn(`Tile: could not offer org.niro.Tile: ${e.message}`);
            this._dbus = null;
        }
    }

    _unexportDBus() {
        if (this._nameId) {
            Gio.bus_unown_name(this._nameId);
            this._nameId = 0;
        }
        this._dbus?.unexport();
        this._dbus = null;
    }

    ListLayouts() {
        return JSON.stringify(LAYOUTS.map(([id, title, description]) => ({id, title, description})));
    }

    ApplyLayout(layout, workspace, monitor) {
        return this.applyLayout(layout, {workspace: workspace >= 1 ? workspace - 1 : null, monitor: monitor >= 0 ? monitor : null});
    }

    ClearLayout(workspace, monitor) {
        this.clearLayout({workspace: workspace >= 1 ? workspace - 1 : null, monitor: monitor >= 0 ? monitor : null});
    }

    SetEnabled(enabled) {
        this._settings.set_boolean('enabled', enabled);
    }

    Retile() {
        this._schedule();
    }

    GetWorkspaceApi() {
        // `rules`: the methods that apply the advanced rules to the windows already open (they do not depend on the workspace cores)
        const rules = ['ApplyRules', 'ApplyRulesPreview'];
        return JSON.stringify(this._workspace ? {...this._workspace.api(), rules} : this._noWorkspace());
    }

    GroupsCall(op, args) {
        return JSON.stringify(this._workspace ? this._workspace.groups(op, args) : this._noWorkspace());
    }

    SnapshotsCall(op, args) {
        return JSON.stringify(this._workspace ? this._workspace.snapshots(op, args) : this._noWorkspace());
    }

    MonitorStatus() {
        return JSON.stringify(this._workspace ? this._workspace.monitorStatus() : this._noWorkspace());
    }

    ApplyRules() {
        return JSON.stringify(this._applyRules(false));
    }

    ApplyRulesPreview() {
        return JSON.stringify(this._applyRules(true));
    }

    _noWorkspace() {
        return {api: 1, ok: false, error: 'the workspace features are not installed (shell/shared is missing next to Tile)'};
    }

    /** What the workspace service needs from the shell (see workspace.js). */
    _workspaceHost() {
        const windows = () => global.get_window_actors().map(a => a.meta_window).filter(w => w && w.window_type === Meta.WindowType.NORMAL && !w.skip_taskbar);
        const byId = id => windows().find(w => w.get_id() === id) ?? null;
        const dir = GLib.build_filenamev([GLib.get_user_config_dir(), 'niro']);
        return {
            liveWindows: () => windows().map(w => {
                const r = w.get_frame_rect();
                return {
                    id: w.get_id(), appId: w.get_gtk_application_id?.() || w.get_wm_class() || '', title: w.get_title() ?? '',
                    workspace: w.is_on_all_workspaces() ? 0 : w.get_workspace().index() + 1, monitor: w.get_monitor(),
                    rect: {x: r.x, y: r.y, width: r.width, height: r.height},
                };
            }),
            monitors: () => {
                let logical = [];
                try { logical = global.backend.get_monitor_manager().get_logical_monitors(); } catch (_e) { /* identity falls back to the index */ }
                return Main.layoutManager.monitors.map((m, index) => {
                    let mon = null;
                    try { mon = logical.find(l => l.get_number() === index)?.get_monitors()[0] ?? null; } catch (_e) { /* no detail */ }
                    return {
                        index, connector: mon?.get_connector() ?? `monitor${index}`, vendor: mon?.get_vendor() ?? '', product: mon?.get_product() ?? '', serial: mon?.get_serial() ?? '',
                        width: m.width, height: m.height, scale: global.display.get_monitor_scale(index), x: m.x, y: m.y, primary: index === global.display.get_primary_monitor(),
                    };
                });
            },
            nWorkspaces: () => global.workspace_manager.get_n_workspaces(),
            activeWorkspace: () => global.workspace_manager.get_active_workspace_index() + 1,
            focusedId: () => global.display.focus_window?.get_id() ?? 0,
            moveWindow: (id, {workspace, monitor, rect}) => {
                const w = byId(id);
                if (!w) return false;
                if (workspace !== null && !w.is_on_all_workspaces()) w.change_workspace_by_index(workspace - 1, false);
                if (monitor !== null && w.get_monitor() !== monitor) w.move_to_monitor(monitor);
                if (rect && !isMaximized(w) && !w.fullscreen) w.move_resize_frame(true, rect.x, rect.y, rect.width, rect.height);
                return true;
            },
            focusWindows: ids => {
                for (const id of ids) byId(id)?.activate(global.get_current_time());
            },
            switchWorkspace: n => global.workspace_manager.get_workspace_by_index(n - 1)?.activate(global.get_current_time()),
            launch: appId => {
                const app = Gio.AppInfo.get_all().find(a => a.should_show() && a.get_id()?.toLowerCase() === `${appId}.desktop`.toLowerCase());
                if (!app) return {ok: false, reason: `no desktop entry for ${appId}`};
                try {
                    return {ok: app.launch([], null)};
                } catch (e) {
                    return {ok: false, reason: e.message};
                }
            },
            load: name => {
                try {
                    return JSON.parse(new TextDecoder().decode(Gio.File.new_for_path(GLib.build_filenamev([dir, name])).load_contents(null)[1]));
                } catch (e) {
                    // only a missing file is empty: anything else must reach the caller, or the next save would overwrite it
                    if (e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND)) return null;
                    throw e;
                }
            },
            save: (name, value) => {
                GLib.mkdir_with_parents(dir, 0o755);
                Gio.File.new_for_path(GLib.build_filenamev([dir, name])).replace_contents(new TextEncoder().encode(JSON.stringify(value, null, 1)), null, false, Gio.FileCreateFlags.REPLACE_DESTINATION, null);
            },
            now: () => Date.now(),
            recoveryEnabled: () => Boolean(this._settings?.get_boolean('monitor-recovery')),
        };
    }

    /** Everything a program needs to know: the settings that matter, the workspaces, the monitors and the windows. Workspaces and windows count from 1. */
    GetState() {
        const workspaceManager = global.workspace_manager;
        const active = workspaceManager.get_active_workspace_index();
        const names = (() => {
            try { return new Gio.Settings({schema_id: 'org.gnome.desktop.wm.preferences'}).get_strv('workspace-names'); } catch (_e) { return []; }
        })();
        const monitors = Main.layoutManager.monitors.map((m, index) => ({
            index, x: m.x, y: m.y, width: m.width, height: m.height,
            scale: global.display.get_monitor_scale(index), primary: index === global.display.get_primary_monitor(),
            layout: this._layoutAt(index), tiled: this._tiledOn(index).length,
        }));
        const workspaces = [];
        for (let i = 0; i < workspaceManager.get_n_workspaces(); i++) {
            workspaces.push({
                index: i + 1, name: names[i] ?? '', active: i === active,
                layout: resolveLayout(this._map, i, global.display.get_primary_monitor(), this._settings.get_string('layout')),
                windows: workspaceManager.get_workspace_by_index(i).list_windows().filter(w => w.window_type === Meta.WindowType.NORMAL && !w.skip_taskbar).length,
            });
        }
        const windows = global.get_window_actors().map(a => a.meta_window).filter(w => w.window_type === Meta.WindowType.NORMAL && !w.skip_taskbar).map(w => {
            const r = w.get_frame_rect();
            return {
                id: w.get_id(), title: w.get_title(), class: w.get_wm_class() ?? '', workspace: w.is_on_all_workspaces() ? 0 : w.get_workspace().index() + 1,
                monitor: w.get_monitor(), tiled: this._order.includes(w) && this._eligible(w), floating: this._floating.has(w) || matchRule(this._rules, this._classes(w))?.action === 'float',
                fullscreen: w.fullscreen, maximized: isMaximized(w), minimized: w.minimized, rect: {x: r.x, y: r.y, width: r.width, height: r.height},
            };
        });
        return JSON.stringify({
            version: 1, enabled: this._settings.get_boolean('enabled'), layout: this._settings.get_string('layout'), layoutMap: this._map,
            rules: this._rules, gapInner: this._settings.get_int('gap-inner'), gapOuter: this._settings.get_int('gap-outer'),
            masterFactor: this._settings.get_double('master-factor'), columnWidth: this._settings.get_double('column-width'),
            animate: this._settings.get_boolean('animate'),
            session: {type: Meta.is_wayland_compositor?.() ?? true ? 'wayland' : 'x11', shell: PACKAGE_VERSION},
            monitors, workspaces, windows,
        });
    }

    _stateChanged() {
        try {
            this._dbus?.emit_signal('StateChanged', null);
        } catch (_e) { /* nobody listens */ }
    }

    // ---- Shortcuts

    /** The next layout in the list, for what the active workspace takes its layout from: itself, its monitor, or the general setting. */
    _nextLayout() {
        const monitor = global.display.focus_window?.get_monitor() ?? global.display.get_primary_monitor();
        const current = this._layoutAt(monitor);
        const next = LAYOUT_IDS[(LAYOUT_IDS.indexOf(current) + 1) % LAYOUT_IDS.length];
        const workspace = global.workspace_manager.get_active_workspace_index();
        if (this._map.workspaces[String(workspace + 1)])
            this.applyLayout(next, {workspace});
        else if (this._map.monitors[String(monitor)])
            this.applyLayout(next, {monitor});
        else
            this.applyLayout(next, {});
        this._osd(LAYOUTS.find(l => l[0] === next)[1]);
    }

    /**
     * Gives a workspace (from 0), a monitor, or neither (the general layout) a layout. False for a layout that is not one.
     * Nothing is moved here: the setting changes and the tiling follows it, as for any other way of changing it.
     */
    applyLayout(layout, {workspace = null, monitor = null} = {}) {
        if (!LAYOUT_IDS.includes(layout) || !this._settings)
            return false;
        if ((workspace === null || workspace < 0) && (monitor === null || monitor < 0)) {
            this._settings.set_string('layout', layout);
        } else {
            this._settings.set_string('layout-map', JSON.stringify(withLayout(this._map, layout, {workspace, monitor})));
        }
        return true;
    }

    clearLayout({workspace = null, monitor = null} = {}) {
        this._settings.set_string('layout-map', JSON.stringify(withoutLayout(this._map, {workspace, monitor})));
    }

    _promote() {
        const win = global.display.focus_window;
        const i = this._order.indexOf(win);
        if (i <= 0)
            return;
        this._order.splice(i, 1);
        this._order.unshift(win);
        this._schedule();
    }

    _toggleFloat() {
        const win = global.display.focus_window;
        if (!win || win.window_type !== Meta.WindowType.NORMAL)
            return;
        if (this._floating.has(win))
            this._floating.delete(win);
        else
            this._floating.add(win);
        this._osd(this._floating.has(win) ? 'Floating' : 'Tiled');
        this._schedule();
    }

    _grow(by) {
        const v = this._settings.get_double('master-factor');
        this._settings.set_double('master-factor', Math.max(0.1, Math.min(0.9, Math.round((v + by) * 100) / 100)));
    }

    _layoutTitle() {
        const monitor = global.display.focus_window?.get_monitor() ?? global.display.get_primary_monitor();
        return LAYOUTS.find(l => l[0] === this._layoutAt(monitor))?.[1] ?? '';
    }

    _osd(text) {
        try {
            Main.osdWindowManager.showAll?.(Gio.ThemedIcon.new('view-grid-symbolic'), text, null, null)
                ?? Main.osdWindowManager.show(-1, Gio.ThemedIcon.new('view-grid-symbolic'), text, null);
        } catch (_e) { /* no OSD: the change shows anyway */ }
    }
}
