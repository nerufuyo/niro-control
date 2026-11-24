// Test-only telemetry for the isolated E2E sessions (tests/e2e/session.sh). It is NOT part of the package and is copied only into the
// private session's own XDG_DATA_HOME. Design limits, all deliberate:
//   * inert unless NIRO_E2E=1 is in the shell's environment (set by session.sh only): enable() returns without doing anything otherwise;
//   * a fixed set of read-only D-Bus methods on its own bus name org.niro.E2E: no argument is evaluated, interpreted or used as a path;
//   * recordings go to NIRO_E2E_OUT (an environment variable fixed at shell start), under a name made only of [a-z0-9_-];
//   * it reads the extensions' private fields (stateObj._...) and the stage, and writes none of them;
//   * disable() drops the bus name, the signal connections and the recording; nothing persists, no setting is touched.
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Clutter from 'gi://Clutter';
import Shell from 'gi://Shell';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

const IFACE = `<node><interface name="org.niro.E2E">
  <method name="Ping"><arg type="s" direction="out"/></method>
  <method name="Snapshot"><arg type="s" direction="out"/></method>
  <method name="Start"><arg type="s" direction="in" name="name"/><arg type="s" direction="out"/></method>
  <method name="Stop"><arg type="s" direction="out"/></method>
  <method name="Events"><arg type="s" direction="out"/></method>
</interface></node>`;

const now = () => GLib.get_monotonic_time() / 1000;
const r2 = v => Math.round(v * 100) / 100;
const walk = (a, f) => { if (f(a)) return a; for (const c of a.get_children()) { const r = walk(c, f); if (r) return r; } return null; };
const rect = a => { const [x, y] = a.get_transformed_position(), [w, h] = a.get_transformed_size(); return Number.isFinite(x + y + w + h) ? {x: r2(x), y: r2(y), w: r2(w), h: r2(h)} : null; };

export default class E2ETelemetry extends Extension {
    enable() {
        if (GLib.getenv('NIRO_E2E') !== '1') return;       // inert outside the E2E sessions
        this._out = GLib.getenv('NIRO_E2E_OUT') || null;
        this._rec = null; this._events = []; this._conns = []; this._prev = null;
        this._exported = Gio.DBusExportedObject.wrapJSObject(IFACE, this);
        this._exported.export(Gio.DBus.session, '/org/niro/E2E');
        this._owner = Gio.bus_own_name_on_connection(Gio.DBus.session, 'org.niro.E2E', Gio.BusNameOwnerFlags.NONE, null, null);
        const apps = Shell.AppSystem.get_default();
        this._conns.push([apps, apps.connect('app-state-changed', (s, app) => this._event('app-state', {id: app.get_id(), state: app.state}))]);
        this._conns.push([global.stage, global.stage.connect('after-paint', () => this._paint())]);
        // how many input events of each kind reached the stage, so a test can show the injected input took the real event path
        this._stageEvents = {};
        const names = {[Clutter.EventType.KEY_PRESS]: 'key-press', [Clutter.EventType.KEY_RELEASE]: 'key-release', [Clutter.EventType.MOTION]: 'motion',
            [Clutter.EventType.BUTTON_PRESS]: 'button-press', [Clutter.EventType.BUTTON_RELEASE]: 'button-release', [Clutter.EventType.ENTER]: 'enter', [Clutter.EventType.LEAVE]: 'leave'};
        this._conns.push([global.stage, global.stage.connect('captured-event', (a, e) => { const n = names[e.type()]; if (n) this._stageEvents[n] = (this._stageEvents[n] ?? 0) + 1; return Clutter.EVENT_PROPAGATE; })]);
        this._conns.push([global.stage, global.stage.connect('notify::key-focus', () => this._event('key-focus', this._focus()))]);
    }

    disable() {
        for (const [o, id] of this._conns ?? []) { try { o.disconnect(id); } catch (_e) { /* gone */ } }
        this._conns = [];
        if (this._exported) { this._exported.unexport(); this._exported = null; }
        if (this._owner) { Gio.bus_unown_name(this._owner); this._owner = 0; }
        this._rec = null; this._events = []; this._prev = null;
    }

    _ext(uuid) { try { return Main.extensionManager.lookup(uuid)?.stateObj ?? null; } catch (_e) { return null; } }
    _focus() { const k = global.stage.key_focus; return k ? {type: k.constructor.name, cls: k.style_class || '', name: k.name || ''} : null; }
    _event(kind, data) { this._events.push({t: r2(now()), kind, ...data}); if (this._events.length > 5000) this._events.shift(); }

    _search() {
        const s = this._ext('search@niro.local');
        if (!s || !s._box) return null;
        const b = s._box, text = s._entry?.clutter_text;
        return {state: s._sm?.state ?? null, visible: b.visible, opacity: b.opacity, rect: b.visible ? rect(b) : null, ty: r2(b.translation_y), sx: r2(b.scale_x),
            text: s._entry?.get_text() ?? '', inputFocus: Boolean(text) && global.stage.key_focus === text, selected: s._selected ?? null, rows: s._list?.get_n_children?.() ?? null};
    }

    _island() {
        const c = this._ext('island@niro.local')?._controller;
        const isl = c?._island;
        if (!isl) return null;
        const e = isl.visible ? rect(isl) : null;
        let cut = 0, leaves = 0;
        if (e && isl.opacity > 8) {
            walk(isl, a => {
                if (a !== isl && a.get_n_children() === 0 && /^(Clutter_Text|St_Icon|St_Label|BotIcon)$/.test(a.constructor.name) && a.mapped && a.get_paint_opacity() > 8 && a.width > 0) {
                    const x = rect(a);
                    if (x && x.x < e.x + e.w && x.x + x.w > e.x && x.y < e.y + e.h && x.y + x.h > e.y) { leaves++; cut = Math.max(cut, e.x - x.x, x.x + x.w - (e.x + e.w), e.y - x.y, x.y + x.h - (e.y + e.h), 0); }
                }
                return false;
            });
        }
        return {hovered: Boolean(isl.hovered), expandWanted: Boolean(c._expandWanted), state: c._surface?.state ?? null, presentation: c._surface?.presentation ?? null, visible: isl.visible, opacity: isl.opacity, rect: e,
            views: (isl._views ?? []).filter(v => v.visible && v.opacity > 8).map(v => v.constructor.name), cut: r2(cut), textLeaves: leaves};
    }

    _dock() {
        const d = this._ext('dock@niro.local')?._dockManager;
        const box = d?._container;
        if (!box) return null;
        const icons = box.visible ? box.get_children().filter(c => c.visible && c.width > 0).map(c => { const x = rect(c); return x ? {s: r2(c.scale_x), l: x.x, r: r2(x.x + x.w), cx: r2(x.x + x.w / 2)} : null; }).filter(Boolean) : [];
        let overlap = 0;
        for (let i = 1; i < icons.length; i++) overlap = Math.max(overlap, icons[i - 1].r - icons[i].l);
        return {state: d._visibility?._state ?? null, visible: box.visible, rect: box.visible ? rect(box) : null, ty: r2(box.translation_y), icons, maxScale: icons.length ? Math.max(...icons.map(i => i.s)) : null, overlap: r2(overlap)};
    }

    _snap() {
        const [px, py] = global.get_pointer();
        return {t: r2(now()), pointer: [px, py], keyFocus: this._focus(), modal: Main.modalCount ?? null, overview: Main.overview.visible,
            animations: St.Settings.get().enable_animations, stageEvents: {...this._stageEvents}, search: this._search(), island: this._island(), dock: this._dock()};
    }

    _paint() {
        if (!this._rec) return;
        const s = this._snap();
        // state changes between paints become events, so a scenario can assert on the order of transitions without polling
        const p = this._prev;
        for (const k of ['search', 'island', 'dock']) {
            const was = p?.[k]?.state ?? null, is = s[k]?.state ?? null;
            if (was !== is) this._event('state', {component: k, from: was, to: is});
        }
        this._prev = s; this._rec.rows.push(s);
    }

    // ---- D-Bus methods (read-only)
    Ping() { return 'niro-e2e-telemetry 1'; }
    Snapshot() { return JSON.stringify(this._snap()); }
    Start(name) {
        if (!/^[a-z0-9_-]{1,60}$/.test(name)) return JSON.stringify({error: 'bad name'});
        this._rec = {name, started: now(), rows: []}; this._events = []; this._prev = null;
        return JSON.stringify({recording: name});
    }
    Stop() {
        const rec = this._rec; this._rec = null;
        if (!rec) return JSON.stringify({error: 'not recording'});
        const doc = {name: rec.name, started: rec.started, stopped: now(), events: this._events, rows: rec.rows};
        let file = null;
        if (this._out) { file = `${this._out}/${rec.name}.json`; try { GLib.file_set_contents(file, JSON.stringify(doc)); } catch (e) { file = `NOT WRITTEN: ${e.message}`; } }
        return JSON.stringify({name: rec.name, rows: rec.rows.length, file});
    }
    Events() { return JSON.stringify(this._events); }
}

