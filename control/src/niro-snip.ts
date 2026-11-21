// @ts-nocheck: gjs entry
// SPDX-License-Identifier: GPL-3.0-or-later
// niro-snip: a snipping tool with an editor. `niro-snip` takes a screenshot (the desktop's own area / window / screen picker)
// and opens it for marking up; `niro-snip FILE` opens an image the same way. Save writes over the file, as asked for;
// Save As makes a copy. Runs under `gjs -m`.
import Gdk from 'gi://Gdk?version=4.0';
import GdkPixbuf from 'gi://GdkPixbuf';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';
import Soup from 'gi://Soup?version=3.0';
import cairo from 'cairo';
import System from 'system';

import {parseTsv, sensitiveBoxes} from './ocrRules.js';

const APP_ID = 'org.niro.Snip';
const TOOLS = [
    ['pen', 'document-edit-symbolic', 'Pen'],
    ['highlighter', 'format-text-bold-symbolic', 'Highlighter'],
    ['arrow', 'go-next-symbolic', 'Arrow'],
    ['rect', 'view-fullscreen-symbolic', 'Rectangle'],
    ['text', 'insert-text-symbolic', 'Text'],
    ['step', 'emblem-ok-symbolic', 'Numbered step'],
    ['pixelate', 'view-grid-symbolic', 'Hide (pixelate)'],
    ['crop', 'edit-cut-symbolic', 'Crop'],
    ['ruler', 'object-straighten-symbolic', 'Ruler: the distance in pixels'],
    ['picker', 'color-select-symbolic', 'Pick a colour: copies its code'],
];
const COLORS = ['#e8472b', '#f5c518', '#2ecc71', '#2d8cff', '#111111', '#ffffff'];
const BLOCK = 14;

/** The settings Niro Control keeps for Niro Snip (history, upload address); null when the package's schema is not installed. */
function snipSettings() {
    try {
        const source = Gio.SettingsSchemaSource.get_default();
        const schema = source?.lookup('org.niro.control', true);
        return schema?.has_key('snip-history') ? new Gio.Settings({schema_id: 'org.niro.control'}) : null;
    } catch (_e) { return null; }
}

/** Keeps a copy of a fresh capture, when the person asked for a history (Search › Screenshots), and forgets the oldest past the number set in Search › Screenshots (30 by default). */
function keepInHistory(path) {
    const settings = snipSettings();
    if (!settings?.get_boolean('snip-history')) return;
    try {
        const dir = `${GLib.get_user_data_dir()}/niro-snip/history`;
        GLib.mkdir_with_parents(dir, 0o700);
        Gio.File.new_for_path(path).copy(Gio.File.new_for_path(`${dir}/snip-${Date.now()}.png`), Gio.FileCopyFlags.OVERWRITE, null, null);
        const names = [];
        const it = Gio.File.new_for_path(dir).enumerate_children('standard::name', Gio.FileQueryInfoFlags.NONE, null);
        for (let i = it.next_file(null); i; i = it.next_file(null)) if (i.get_name().endsWith('.png')) names.push(i.get_name());
        it.close(null);
        names.sort().slice(0, Math.max(0, names.length - (settings.get_int('snip-history-keep') || 30))).forEach(n => GLib.unlink(`${dir}/${n}`));
    } catch (e) { printerr(`niro-snip: history: ${e.message}`); }
}

/** The picture on a soft gradient with a rounded corner and a shadow, as a slide or a post would show it. */
function framed(surface) {
    const pad = Math.round(Math.max(surface.getWidth(), surface.getHeight()) * 0.07) + 24;
    const w = surface.getWidth() + pad * 2, h = surface.getHeight() + pad * 2;
    const out = new cairo.ImageSurface(cairo.Format.ARGB32, w, h);
    const cr = new cairo.Context(out);
    const g = new cairo.LinearGradient(0, 0, w, h);
    g.addColorStopRGB(0, 0.36, 0.49, 0.98); g.addColorStopRGB(1, 0.69, 0.36, 0.94);
    cr.setSource(g); cr.paint();
    const radius = 14, x = pad, y = pad, iw = surface.getWidth(), ih = surface.getHeight();
    const roundRect = (rx, ry, rw, rh, r) => {
        cr.newSubPath();
        cr.arc(rx + rw - r, ry + r, r, -Math.PI / 2, 0); cr.arc(rx + rw - r, ry + rh - r, r, 0, Math.PI / 2);
        cr.arc(rx + r, ry + rh - r, r, Math.PI / 2, Math.PI); cr.arc(rx + r, ry + r, r, Math.PI, Math.PI * 1.5); cr.closePath();
    };
    for (let i = 10; i >= 1; i--) { cr.setSourceRGBA(0, 0, 0, 0.035); roundRect(x - i + 2, y - i + 12, iw + i * 2, ih + i * 2, radius + i); cr.fill(); }
    cr.save(); roundRect(x, y, iw, ih, radius); cr.clip();
    cr.setSourceSurface(surface, x, y); cr.paint(); cr.restore();
    cr.$dispose();
    return out;
}

/** The screenshot, taken through the desktop portal: the shell's own picker, nothing of ours on the screen. */
function capture(interactive = true) {
    return new Promise((resolve, reject) => {
        const bus = Gio.DBus.session;
        const token = `niro${GLib.get_monotonic_time()}`;
        const sender = bus.get_unique_name().slice(1).replace(/\./g, '_');
        const path = `/org/freedesktop/portal/desktop/request/${sender}/${token}`;
        const sub = bus.signal_subscribe('org.freedesktop.portal.Desktop', 'org.freedesktop.portal.Request', 'Response', path, null,
            Gio.DBusSignalFlags.NONE, (_c, _s, _p, _i, _n, params) => {
                bus.signal_unsubscribe(sub);
                const [code, results] = params.recursiveUnpack();
                if (code === 0 && results.uri) resolve(Gio.File.new_for_uri(results.uri).get_path());
                else reject(new Error(code === 1 ? 'cancelled' : 'the screenshot failed'));
            });
        bus.call('org.freedesktop.portal.Desktop', '/org/freedesktop/portal/desktop', 'org.freedesktop.portal.Screenshot', 'Screenshot',
            new GLib.Variant('(sa{sv})', ['', {handle_token: GLib.Variant.new_string(token), interactive: GLib.Variant.new_boolean(interactive)}]),
            null, Gio.DBusCallFlags.NONE, -1, null, (conn, res) => {
                try { conn.call_finish(res); } catch (e) { bus.signal_unsubscribe(sub); reject(e); }
            });
    });
}

const rgba = hex => { const c = new Gdk.RGBA(); c.parse(hex); return c; };

/** One mark on the picture, in the picture's own pixels. */
function paintMark(cr, m, pixbuf) {
    const c = rgba(m.color);
    cr.setLineCap(cairo.LineCap.ROUND);
    cr.setLineJoin(cairo.LineJoin.ROUND);
    switch (m.tool) {
    case 'pen':
    case 'highlighter':
        if (m.points.length < 2) return;
        cr.setSourceRGBA(c.red, c.green, c.blue, m.tool === 'highlighter' ? 0.35 : 1);
        cr.setLineWidth(m.tool === 'highlighter' ? m.size * 4 : m.size);
        cr.moveTo(m.points[0][0], m.points[0][1]);
        for (const [x, y] of m.points.slice(1)) cr.lineTo(x, y);
        cr.stroke();
        break;
    case 'arrow': {
        const [x1, y1, x2, y2] = m.box;
        const angle = Math.atan2(y2 - y1, x2 - x1), head = Math.max(14, m.size * 4);
        cr.setSourceRGBA(c.red, c.green, c.blue, 1);
        cr.setLineWidth(m.size);
        cr.moveTo(x1, y1); cr.lineTo(x2, y2); cr.stroke();
        cr.moveTo(x2, y2); cr.lineTo(x2 - head * Math.cos(angle - 0.45), y2 - head * Math.sin(angle - 0.45));
        cr.lineTo(x2 - head * Math.cos(angle + 0.45), y2 - head * Math.sin(angle + 0.45)); cr.closePath(); cr.fill();
        break;
    }
    case 'ruler': {
        const [x1, y1, x2, y2] = m.box;
        const px = Math.round(Math.hypot(x2 - x1, y2 - y1));
        cr.setSourceRGBA(c.red, c.green, c.blue, 1);
        cr.setLineWidth(2);
        cr.moveTo(x1, y1); cr.lineTo(x2, y2); cr.stroke();
        const angle = Math.atan2(y2 - y1, x2 - x1) + Math.PI / 2;
        for (const [ex, ey] of [[x1, y1], [x2, y2]]) { cr.moveTo(ex - 6 * Math.cos(angle), ey - 6 * Math.sin(angle)); cr.lineTo(ex + 6 * Math.cos(angle), ey + 6 * Math.sin(angle)); cr.stroke(); }
        cr.selectFontFace('Sans', cairo.FontSlant.NORMAL, cairo.FontWeight.BOLD);
        cr.setFontSize(13);
        const label = `${px} px`, ext = cr.textExtents(label), mx = (x1 + x2) / 2, my = (y1 + y2) / 2 - 10;
        cr.setSourceRGBA(0, 0, 0, 0.75);
        cr.rectangle(mx - ext.width / 2 - 5, my - ext.height - 4, ext.width + 10, ext.height + 8); cr.fill();
        cr.setSourceRGBA(1, 1, 1, 1);
        cr.moveTo(mx - ext.width / 2 - ext.xBearing, my - ext.yBearing - ext.height); cr.showText(label);
        break;
    }
    case 'rect': {
        const [x1, y1, x2, y2] = m.box;
        cr.setSourceRGBA(c.red, c.green, c.blue, 1);
        cr.setLineWidth(m.size);
        cr.rectangle(Math.min(x1, x2), Math.min(y1, y2), Math.abs(x2 - x1), Math.abs(y2 - y1));
        cr.stroke();
        break;
    }
    case 'text':
        cr.setSourceRGBA(c.red, c.green, c.blue, 1);
        cr.selectFontFace('Sans', cairo.FontSlant.NORMAL, cairo.FontWeight.BOLD);
        cr.setFontSize(m.size * 5 + 10);
        m.text.split('\n').forEach((line, i) => { cr.moveTo(m.points[0][0], m.points[0][1] + (i + 1) * (m.size * 5 + 14)); cr.showText(line); });
        break;
    case 'step': {
        const r = m.size * 2 + 12;
        cr.setSourceRGBA(c.red, c.green, c.blue, 1);
        cr.arc(m.points[0][0], m.points[0][1], r, 0, 2 * Math.PI); cr.fill();
        // White on a dark or saturated colour, black on a light one, so the number always reads.
        const light = 0.299 * c.red + 0.587 * c.green + 0.114 * c.blue > 0.6;
        cr.setSourceRGB(light ? 0 : 1, light ? 0 : 1, light ? 0 : 1);
        cr.selectFontFace('Sans', cairo.FontSlant.NORMAL, cairo.FontWeight.BOLD);
        cr.setFontSize(r * 1.1);
        const ext = cr.textExtents(String(m.n));
        cr.moveTo(m.points[0][0] - ext.width / 2 - ext.xBearing, m.points[0][1] - ext.height / 2 - ext.yBearing);
        cr.showText(String(m.n));
        break;
    }
    case 'pixelate': {
        // Each block takes the average colour of the picture under it: what was there cannot be read back.
        const [x1, y1, x2, y2] = m.box;
        const left = Math.max(0, Math.floor(Math.min(x1, x2))), top = Math.max(0, Math.floor(Math.min(y1, y2)));
        const right = Math.min(pixbuf.get_width(), Math.ceil(Math.max(x1, x2))), bottom = Math.min(pixbuf.get_height(), Math.ceil(Math.max(y1, y2)));
        const px = pixbuf.get_pixels(), stride = pixbuf.get_rowstride(), n = pixbuf.get_n_channels();
        for (let by = top; by < bottom; by += BLOCK) for (let bx = left; bx < right; bx += BLOCK) {
            let r = 0, g = 0, b = 0, count = 0;
            for (let y = by; y < Math.min(by + BLOCK, bottom); y++) for (let x = bx; x < Math.min(bx + BLOCK, right); x++) {
                const i = y * stride + x * n; r += px[i]; g += px[i + 1]; b += px[i + 2]; count++;
            }
            if (!count) continue;
            cr.setSourceRGB(r / count / 255, g / count / 255, b / count / 255);
            cr.rectangle(bx, by, Math.min(BLOCK, right - bx), Math.min(BLOCK, bottom - by));
            cr.fill();
        }
        break;
    }
    }
}

class Editor {
    constructor(app, path) {
        this.path = path;
        this.pixbuf = GdkPixbuf.Pixbuf.new_from_file(path);
        this.marks = [];
        this.redo = [];
        this.tool = 'pen';
        this.color = COLORS[0];
        this.size = 4;
        this.drawing = null;
        this.frame = false;
        this.scale = 1; this.offX = 0; this.offY = 0;

        this.win = new Gtk.ApplicationWindow({application: app, title: 'Niro Snip', default_width: 980, default_height: 680});
        const header = new Gtk.HeaderBar();
        this.win.set_titlebar(header);

        const toolBox = new Gtk.Box({css_classes: ['linked']});
        let first = null;
        for (const [id, icon, tip] of TOOLS) {
            const b = new Gtk.ToggleButton({icon_name: icon, tooltip_text: tip, active: id === this.tool});
            if (first) b.set_group(first); else first = b;
            b.connect('toggled', () => { if (b.active) this.tool = id; });
            toolBox.append(b);
        }
        header.pack_start(toolBox);

        const colorBox = new Gtk.Box({spacing: 4, margin_start: 8});
        let firstColor = null;
        for (const hex of COLORS) {
            const b = new Gtk.ToggleButton({tooltip_text: hex, active: hex === this.color, width_request: 26, height_request: 26});
            const css = new Gtk.CssProvider();
            css.load_from_string(`button { background: ${hex}; min-width: 18px; min-height: 18px; padding: 0; border-radius: 13px; }`);
            b.get_style_context().add_provider(css, Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION);
            if (firstColor) b.set_group(firstColor); else firstColor = b;
            b.connect('toggled', () => { if (b.active) this.color = hex; });
            colorBox.append(b);
        }
        header.pack_start(colorBox);
        const size = new Gtk.Scale({orientation: Gtk.Orientation.HORIZONTAL, width_request: 90, draw_value: false, tooltip_text: 'Thickness',
            adjustment: new Gtk.Adjustment({lower: 2, upper: 16, step_increment: 1, value: this.size})});
        size.connect('value-changed', () => { this.size = size.get_value(); });
        header.pack_start(size);

        const saveBtn = new Gtk.Button({label: 'Save', tooltip_text: 'Saves over the original picture (Ctrl+S)', css_classes: ['suggested-action']});
        saveBtn.connect('clicked', () => this.save());
        const copyBtn = new Gtk.Button({icon_name: 'edit-copy-symbolic', tooltip_text: 'Copy the picture (Ctrl+C)'});
        copyBtn.connect('clicked', () => this.copy());
        const asBtn = new Gtk.Button({icon_name: 'document-save-as-symbolic', tooltip_text: 'Save a copy (Ctrl+Shift+S)'});
        asBtn.connect('clicked', () => this.saveAs());
        const undoBtn = new Gtk.Button({icon_name: 'edit-undo-symbolic', tooltip_text: 'Undo (Ctrl+Z)'});
        undoBtn.connect('clicked', () => this.undo());
        const closeBtn = new Gtk.Button({icon_name: 'edit-copy-symbolic', label: 'Copy & close', tooltip_text: 'Copies the picture and closes (Ctrl+Enter)'});
        closeBtn.connect('clicked', () => { this.copy(); GLib.timeout_add(GLib.PRIORITY_DEFAULT, 150, () => { this.win.close(); return GLib.SOURCE_REMOVE; }); });
        const textBtn = new Gtk.Button({icon_name: 'insert-text-symbolic', tooltip_text: 'Copy the text in the picture, or in the cropped area (Ctrl+T)'});
        textBtn.connect('clicked', () => this.copyText());
        const hideBtn = new Gtk.Button({icon_name: 'view-conceal-symbolic', tooltip_text: 'Hide private details: e-mail addresses, phone and card numbers, keys (pixelated; undo removes them one by one)'});
        hideBtn.connect('clicked', () => this.hidePrivate());
        const frameBtn = new Gtk.ToggleButton({icon_name: 'image-x-generic-symbolic', tooltip_text: 'Frame: a gradient, rounded corners and a shadow around the picture (for the copy and the saved file)'});
        frameBtn.connect('toggled', () => { this.frame = frameBtn.get_active(); });
        const upBtn = new Gtk.Button({icon_name: 'send-to-symbolic', tooltip_text: 'Upload to the address set in Search › Screenshots', visible: /^https?:\/\//.test(snipSettings()?.get_string('snip-upload-url') ?? '')});
        upBtn.connect('clicked', () => this.upload());
        header.pack_end(saveBtn);
        header.pack_end(upBtn);
        header.pack_end(frameBtn);
        header.pack_end(hideBtn);
        header.pack_end(textBtn);
        header.pack_end(closeBtn); header.pack_end(asBtn); header.pack_end(copyBtn); header.pack_end(undoBtn);

        this.area = new Gtk.DrawingArea({hexpand: true, vexpand: true, content_width: 400, content_height: 300});
        this.area.set_draw_func((_a, cr, w, h) => this.draw(cr, w, h));
        const drag = new Gtk.GestureDrag();
        drag.connect('drag-begin', (_g, x, y) => this.begin(x, y));
        drag.connect('drag-update', (_g, dx, dy) => this.update(dx, dy));
        drag.connect('drag-end', (_g, dx, dy) => this.end(dx, dy));
        this.area.add_controller(drag);

        this.toast = new Gtk.Label({css_classes: ['osd'], halign: Gtk.Align.CENTER, valign: Gtk.Align.END, margin_bottom: 16, visible: false});
        const overlay = new Gtk.Overlay({child: this.area});
        overlay.add_overlay(this.toast);
        this.win.set_child(overlay);

        const keys = new Gtk.EventControllerKey();
        keys.connect('key-pressed', (_c, key, _code, state) => {
            const ctrl = (state & Gdk.ModifierType.CONTROL_MASK) !== 0, shift = (state & Gdk.ModifierType.SHIFT_MASK) !== 0;
            if (key === Gdk.KEY_Escape) { this.win.close(); return true; }
            if (!ctrl) return false;
            if (key === Gdk.KEY_z) { shift ? this.redoLast() : this.undo(); return true; }
            if (key === Gdk.KEY_y) { this.redoLast(); return true; }
            if (key === Gdk.KEY_c) { this.copy(); return true; }
            if (key === Gdk.KEY_t) { this.copyText(); return true; }
            if (key === Gdk.KEY_Return) { this.copy(); GLib.timeout_add(GLib.PRIORITY_DEFAULT, 150, () => { this.win.close(); return GLib.SOURCE_REMOVE; }); return true; }
            if (key === Gdk.KEY_s) { shift ? this.saveAs() : this.save(); return true; }
            return false;
        });
        this.win.add_controller(keys);
        this.win.present();
    }

    /** What is on the picture now, painted at the given scale. */
    paintAll(cr) {
        Gdk.cairo_set_source_pixbuf(cr, this.pixbuf, 0, 0);
        cr.paint();
        for (const m of [...this.marks, ...(this.drawing ? [this.drawing] : [])]) if (m.tool !== 'crop') paintMark(cr, m, this.pixbuf);
    }

    /** The area kept: the last crop, as [x, y, width, height] in the picture's pixels, or the whole picture. */
    cropBox() {
        const iw = this.pixbuf.get_width(), ih = this.pixbuf.get_height();
        const m = [...this.marks, ...(this.drawing ? [this.drawing] : [])].filter(k => k.tool === 'crop').pop();
        if (!m) return [0, 0, iw, ih];
        const x = Math.max(0, Math.min(m.box[0], m.box[2])), y = Math.max(0, Math.min(m.box[1], m.box[3]));
        const r = Math.min(iw, Math.max(m.box[0], m.box[2])), b = Math.min(ih, Math.max(m.box[1], m.box[3]));
        return r - x < 4 || b - y < 4 ? [0, 0, iw, ih] : [Math.floor(x), Math.floor(y), Math.ceil(r - x), Math.ceil(b - y)];
    }

    draw(cr, w, h) {
        const iw = this.pixbuf.get_width(), ih = this.pixbuf.get_height();
        this.scale = Math.min(w / iw, h / ih, 1);
        this.offX = (w - iw * this.scale) / 2; this.offY = (h - ih * this.scale) / 2;
        cr.translate(this.offX, this.offY);
        cr.scale(this.scale, this.scale);
        cr.rectangle(0, 0, iw, ih); cr.clip();
        this.paintAll(cr);
        const [x, y, cw, ch] = this.cropBox();
        if (cw < iw || ch < ih) {
            cr.setSourceRGBA(0, 0, 0, 0.55);
            cr.rectangle(0, 0, iw, ih); cr.rectangle(x, y, cw, ch);
            cr.setFillRule(cairo.FillRule.EVEN_ODD); cr.fill();
            cr.setSourceRGBA(1, 1, 1, 0.9); cr.setLineWidth(1.5 / this.scale);
            cr.rectangle(x, y, cw, ch); cr.stroke();
        }
    }

    point(x, y) { return [(x - this.offX) / this.scale, (y - this.offY) / this.scale]; }

    begin(x, y) {
        this.startX = x; this.startY = y;
        const [px, py] = this.point(x, y);
        this.redo = [];
        if (this.tool === 'text') { this.askText(x, y, px, py); return; }
        if (this.tool === 'picker') { this.pickColour(px, py); return; }
        if (this.tool === 'step') {
            const n = this.marks.filter(k => k.tool === 'step').length + 1;
            this.marks.push({tool: 'step', color: this.color, size: this.size, points: [[px, py]], n});
            this.area.queue_draw();
            return;
        }
        const m = {tool: this.tool, color: this.color, size: this.size, points: [[px, py]], box: [px, py, px, py]};
        this.drawing = m;
    }

    update(dx, dy) {
        if (!this.drawing) return;
        const [px, py] = this.point(this.startX + dx, this.startY + dy);
        const m = this.drawing;
        if (m.tool === 'pen' || m.tool === 'highlighter') m.points.push([px, py]);
        else m.box = [m.box[0], m.box[1], px, py];
        this.area.queue_draw();
    }

    end(dx, dy) {
        if (!this.drawing) return;
        this.update(dx, dy);
        const m = this.drawing;
        this.drawing = null;
        const small = (m.tool === 'pen' || m.tool === 'highlighter') ? m.points.length < 2 : Math.hypot(m.box[2] - m.box[0], m.box[3] - m.box[1]) < 4;
        if (!small) this.marks.push(m);
        this.area.queue_draw();
    }

    askText(x, y, px, py) {
        const pop = new Gtk.Popover({has_arrow: true, autohide: true});
        pop.set_parent(this.area);
        pop.set_pointing_to(new Gdk.Rectangle({x: Math.round(x), y: Math.round(y), width: 1, height: 1}));
        const entry = new Gtk.Entry({placeholder_text: 'Type, then Enter', width_chars: 24});
        entry.connect('activate', () => {
            const text = entry.get_text().trim();
            if (text) { this.marks.push({tool: 'text', color: this.color, size: this.size, points: [[px, py]], text}); this.area.queue_draw(); }
            pop.popdown();
        });
        pop.connect('closed', () => GLib.idle_add(GLib.PRIORITY_DEFAULT, () => { pop.unparent(); return GLib.SOURCE_REMOVE; }));
        pop.set_child(entry);
        pop.popup();
        entry.grab_focus();
    }

    undo() { const m = this.marks.pop(); if (m) { this.redo.push(m); this.area.queue_draw(); } }
    redoLast() { const m = this.redo.pop(); if (m) { this.marks.push(m); this.area.queue_draw(); } }

    /** The picture with its marks, at its own size. */
    render() {
        const surface = new cairo.ImageSurface(cairo.Format.ARGB32, this.pixbuf.get_width(), this.pixbuf.get_height());
        const cr = new cairo.Context(surface);
        this.paintAll(cr);
        cr.$dispose();
        const [x, y, w, h] = this.cropBox();
        if (w === surface.getWidth() && h === surface.getHeight()) return this.frame ? framed(surface) : surface;
        const cropped = new cairo.ImageSurface(cairo.Format.ARGB32, w, h);
        const cc = new cairo.Context(cropped);
        cc.setSourceSurface(surface, -x, -y);
        cc.paint();
        cc.$dispose();
        return this.frame ? framed(cropped) : cropped;
    }

    say(text) {
        this.toast.label = text; this.toast.visible = true;
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 2200, () => { this.toast.visible = false; return GLib.SOURCE_REMOVE; });
    }

    write(path) {
        const surface = this.render();
        const lower = path.toLowerCase();
        if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) {
            Gdk.pixbuf_get_from_surface(surface, 0, 0, surface.getWidth(), surface.getHeight()).savev(path, 'jpeg', ['quality'], ['95']);
        } else {
            surface.writeToPNG(path);
        }
    }

    save() {
        try { this.write(this.path); this.copy(); this.say('Saved over the original, and copied'); } catch (e) { this.say(`Could not save: ${e.message}`); }
    }

    saveAs() {
        const dialog = new Gtk.FileDialog({title: 'Save a copy', initial_name: GLib.path_get_basename(this.path).replace(/(\.\w+)?$/, '-edited.png')});
        dialog.save(this.win, null, (d, res) => {
            try {
                const file = d.save_finish(res);
                this.write(file.get_path());
                this.say(`Saved ${file.get_basename()}`);
            } catch (e) { if (!e.matches?.(Gtk.DialogError, Gtk.DialogError.DISMISSED)) this.say(`Could not save: ${e.message}`); }
        });
    }

    /** Copies the colour under the pointer as #RRGGBB. */
    pickColour(px, py) {
        const x = Math.floor(px), y = Math.floor(py);
        if (x < 0 || y < 0 || x >= this.pixbuf.get_width() || y >= this.pixbuf.get_height()) return;
        const n = this.pixbuf.get_n_channels(), stride = this.pixbuf.get_rowstride(), px8 = this.pixbuf.get_pixels(), i = y * stride + x * n;
        const hex = `#${[px8[i], px8[i + 1], px8[i + 2]].map(v => v.toString(16).padStart(2, '0')).join('').toUpperCase()}`;
        this.win.get_clipboard().set(hex);
        this.say(`Copied ${hex}`);
    }

    /** POSTs the picture to the address set in Search › Screenshots (the person's own server) and copies what the server answers (usually a link). */
    upload() {
        const url = snipSettings()?.get_string('snip-upload-url') ?? '';
        if (!/^https?:\/\//.test(url)) { this.say('Set the upload address first (Niro Control › Search › Screenshots)'); return; }
        const tmp = GLib.build_filenamev([GLib.get_tmp_dir(), `niro-snip-up-${GLib.get_monotonic_time()}.png`]);
        try { this.write(tmp); } catch (e) { this.say(`Could not upload: ${e.message}`); return; }
        const bytes = GLib.file_get_contents(tmp)[1];
        GLib.unlink(tmp);
        const msg = Soup.Message.new('POST', url);
        msg.set_request_body_from_bytes('image/png', new GLib.Bytes(bytes));
        this.say('Uploading…');
        new Soup.Session({timeout: 20}).send_and_read_async(msg, GLib.PRIORITY_DEFAULT, null, (session, res) => {
            try {
                const reply = new TextDecoder().decode(session.send_and_read_finish(res).get_data()).trim().slice(0, 500);
                if (msg.get_status() >= 300) throw new Error(`HTTP ${msg.get_status()}`);
                this.win.get_clipboard().set(reply);
                this.say(reply ? `Uploaded: ${reply.slice(0, 80)} (copied)` : 'Uploaded');
            } catch (e) { this.say(`Could not upload: ${e.message}`); }
        });
    }

    /** Finds private-looking words with `tesseract` (TSV: where each word is) and puts a pixelate mark over each. */
    hidePrivate() {
        const tmp = GLib.build_filenamev([GLib.get_tmp_dir(), `niro-snip-hide-${GLib.get_monotonic_time()}.png`]);
        try {
            const surface = new cairo.ImageSurface(cairo.Format.ARGB32, this.pixbuf.get_width(), this.pixbuf.get_height());
            const cr = new cairo.Context(surface);
            Gdk.cairo_set_source_pixbuf(cr, this.pixbuf, 0, 0);
            cr.paint(); cr.$dispose();
            surface.writeToPNG(tmp);                                   // the picture itself, without marks, so nothing drawn gets in the way
        } catch (e) { this.say(`Could not read the picture: ${e.message}`); return; }
        this.say('Looking for private details…');
        let proc;
        try {
            proc = Gio.Subprocess.new(['tesseract', tmp, 'stdout', '--psm', '11', 'tsv'], Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE);
        } catch (e) {
            GLib.unlink(tmp);
            this.say('Needs tesseract: sudo dnf install tesseract tesseract-langpack-ind');
            return;
        }
        proc.communicate_utf8_async(null, null, (p, res) => {
            GLib.unlink(tmp);
            try {
                const [, out, err] = p.communicate_utf8_finish(res);
                if (!p.get_successful()) { this.say(`Could not read the text: ${(err ?? '').split('\n')[0]}`); return; }
                const boxes = sensitiveBoxes(parseTsv(out ?? ''));
                for (const box of boxes) this.marks.push({tool: 'pixelate', color: this.color, size: this.size, points: [[box[0], box[1]]], box});
                this.redo = [];
                this.area.queue_draw();
                this.say(boxes.length ? `Hid ${boxes.length} private ${boxes.length === 1 ? 'detail' : 'details'}: check the picture` : 'Nothing private found');
            } catch (e) { this.say(`Could not read the text: ${e.message}`); }
        });
    }

    /** OCR: reads the picture (or the cropped area) with `tesseract` and puts the words on the clipboard. */
    copyText() {
        const tmp = GLib.build_filenamev([GLib.get_tmp_dir(), `niro-snip-ocr-${GLib.get_monotonic_time()}.png`]);
        try { this.render().writeToPNG(tmp); } catch (e) { this.say(`Could not read the picture: ${e.message}`); return; }
        this.say('Reading the text…');
        const run = langs => {
            let proc;
            try {
                proc = Gio.Subprocess.new(['tesseract', tmp, 'stdout', ...(langs ? ['-l', langs] : [])],
                    Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE);
            } catch (e) {
                GLib.unlink(tmp);
                this.say('Reading text needs tesseract: sudo dnf install tesseract tesseract-langpack-ind');
                return;
            }
            proc.communicate_utf8_async(null, null, (p, res) => {
                try {
                    const [, out, err] = p.communicate_utf8_finish(res);
                    // a missing language pack: try again with what is installed
                    if (!p.get_successful() && langs && /language|traineddata/i.test(err ?? '')) return run(null);
                    GLib.unlink(tmp);
                    const text = (out ?? '').replace(/\f/g, '').trim();
                    if (!p.get_successful()) this.say(`Could not read the text: ${(err ?? '').split('\n')[0]}`);
                    else if (!text) this.say('No text found');
                    else { this.win.get_clipboard().set(text); this.say(`Copied ${text.split(/\s+/).length} words`); }
                } catch (e) { GLib.unlink(tmp); this.say(`Could not read the text: ${e.message}`); }
            });
        };
        run('ind+eng');
    }

    copy() {
        try {
            const surface = this.render();
            const pixbuf = Gdk.pixbuf_get_from_surface(surface, 0, 0, surface.getWidth(), surface.getHeight());
            this.win.get_clipboard().set_texture(Gdk.Texture.new_for_pixbuf(pixbuf));
            this.say('Copied');
        } catch (e) { this.say(`Could not copy: ${e.message}`); }
    }
}

const app = new Gtk.Application({application_id: APP_ID, flags: Gio.ApplicationFlags.NON_UNIQUE});
const fail = message => { printerr(`niro-snip: ${message}`); System.exit(1); };
app.connect('activate', () => {
    app.hold();
    const open = path => {
        try { new Editor(app, path); } catch (e) { fail(`cannot open ${path}: ${e.message}`); }
        app.release();
    };
    const delayAt = ARGV.indexOf('--delay');
    const delay = delayAt >= 0 ? Math.min(30, Math.max(0, parseInt(ARGV[delayAt + 1], 10) || 0)) : 0;
    const arg = ARGV.find((a, i) => !a.startsWith('-') && !(delayAt >= 0 && i === delayAt + 1));
    if (arg) { open(arg); return; }
    const full = ARGV.includes('--full');
    // With a delay the screen is taken after it, so a menu can be opened first; the picker comes after, as before.
    const start = () => capture(!full);
    const kept = path => { keepInHistory(path); return path; };
    (delay ? new Promise(resolve => GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, delay, () => { resolve(); return GLib.SOURCE_REMOVE; })).then(start) : start()).then(kept).then(open).catch(e => { app.release(); if (e.message !== 'cancelled') printerr(`niro-snip: ${e.message}`); });
});
System.exit(app.run([]));
