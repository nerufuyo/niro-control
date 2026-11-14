// @ts-nocheck: converted from JavaScript; types are added file by file
// One look for the whole desktop: org.niro.control (opacity, blur, blur-strength; the niro-control package installs it)
// is copied, when it changes, to what Island's glass, the dock and the app windows (Blur my Shell) read. Without the
// schema (the package isn't installed) nothing happens.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {effective, gtk3Scheme, migrateLegacy, PRESET_KEYS, resolveScheme} from './appearance.js';
import {isDarkSurface, shellStylesheet} from './shellTheme.js';
import {refresh as refreshGtk} from './gtkAdapter.js';
import {setBlurRadius} from './blurPipeline.js';

const EXTENSION_DIRS = [GLib.get_user_data_dir(), '/usr/local/share', '/usr/share'].map(base => `${base}/gnome-shell/extensions`);

/** Settings of another extension, read from the schemas folder it ships; null when it isn't there. */
function extensionSettings(uuid, schemaId) {
    for (const base of EXTENSION_DIRS) {
        try {
            const source = Gio.SettingsSchemaSource.new_from_directory(
                `${base}/${uuid}/schemas`,
                Gio.SettingsSchemaSource.get_default(), false);
            const schema = source.lookup(schemaId, false);
            if (schema)
                return new Gio.Settings({settings_schema: schema});
        } catch (_e) {
            // not in this place
        }
    }
    return null;
}

export class NiroSync {
    constructor(islandSettings) {
        this._island = islandSettings;
        const source = Gio.SettingsSchemaSource.get_default();
        if (!source?.lookup('org.niro.control', true))
            return;
        this._shared = new Gio.Settings({schema_id: 'org.niro.control'});
        this._dock = extensionSettings('dock@niro.local', 'org.gnome.shell.extensions.dock');
        this._apps = extensionSettings('blur@niro.local', 'org.gnome.shell.extensions.blur-my-shell.applications');
        this._blur = extensionSettings('blur@niro.local', 'org.gnome.shell.extensions.blur-my-shell');
        this._iface = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'});
        this._a11y = new Gio.Settings({schema_id: 'org.gnome.desktop.a11y.interface'});
        this._id = this._shared.connect('changed', () => this._apply());
        // signals, not polling: GNOME's colour scheme and high contrast
        this._ifaceId = this._iface.connect('changed::color-scheme', () => this._queueGtk());
        this._themeId = this._iface.connect('changed::gtk-theme', () => this._queueGtk());
        this._a11yId = this._a11y.connect('changed::high-contrast', () => this._apply());
        this._migrate();
        this._surfaces();
        this._shellStyle();
        this._queueGtk();
        try {
            this._applyAccent(this._shared.get_string('accent'));
        } catch (e) {
            console.error(`Island: accent not applied: ${e.message}`);
        }
    }

    _flag(key, fallback) { try { return this._shared.get_boolean(key); } catch (_e) { return fallback; } }
    /** Safe mode, or GNOME's high-contrast setting: solid surfaces and no effects. */
    _safe() { return this._flag('safe-mode', false) || this._a11y.get_boolean('high-contrast'); }

    /** The old whole-window fade: saved once, windows go back to full opacity, the switch brings it back (see migrateLegacy). */
    _migrate() {
        if (!this._apps) return;
        try {
            const saved = this._shared.get_int('legacy-window-opacity'), now = this._apps.get_int('opacity');
            const next = migrateLegacy({appsOpacity: now, saved, legacyFade: this._flag('legacy-global-fade', false)});
            if (next.saved !== saved) this._shared.set_int('legacy-window-opacity', next.saved);
            if (next.appsOpacity !== now) this._apps.set_int('opacity', next.appsOpacity);
        } catch (e) { console.error(`Island: legacy fade not migrated: ${e.message}`); }
    }

    /** Top bar, Overview, menus, notifications, quick settings: the blur extension's own blur switches, in step with the look. */
    _surfaces() {
        try {
            const parts = ['panel', 'overview', 'popup'];
            const settings = Object.fromEntries(parts.map(p => [p, extensionSettings('blur@niro.local', `org.gnome.shell.extensions.blur-my-shell.${p}`)]));
            let backup = JSON.parse(this._shared.get_string('shell-surfaces-backup') || '{}');
            const on = this._flag('shell-surfaces', false) && this._flag('universal-enabled', true) && this._flag('affect-shell', true);
            if (on) {
                if (!Object.keys(backup).length) {
                    backup = Object.fromEntries(parts.filter(p => settings[p]).map(p => [p, settings[p].get_boolean('blur')]));
                    this._shared.set_string('shell-surfaces-backup', JSON.stringify(backup));
                }
                const blur = this._shared.get_boolean('blur') && !this._safe() && !this._flag('performance-mode', false);
                for (const p of parts) if (settings[p] && settings[p].get_boolean('blur') !== blur) settings[p].set_boolean('blur', blur);
            } else if (Object.keys(backup).length) {
                for (const p of parts) if (settings[p] && p in backup) settings[p].set_boolean('blur', backup[p]);
                this._shared.set_string('shell-surfaces-backup', '{}');
            }
        } catch (e) { console.error(`Island: shell surfaces not synced: ${e.message}`); }
    }

    /** The Shell stylesheet (see shellTheme.ts): loaded when shell-surfaces is on, never in high contrast, unloaded when off. Rewritten only when its text changes. */
    _shellStyle() {
        try {
            const theme = St.ThemeContext.get_for_stage(global.stage).get_theme();
            const on = this._flag('shell-surfaces', false) && this._flag('universal-enabled', true) && this._flag('affect-shell', true) && !this._a11y.get_boolean('high-contrast');
            if (!on) { this._unloadShellStyle(); return; }
            const values = Object.fromEntries(PRESET_KEYS.map(k => [k, typeof this._shared.get_value(k).unpack() === 'boolean' ? this._shared.get_boolean(k) : this._shared.get_int(k)]));
            const e = effective(values, {safeMode: this._flag('safe-mode', false), highContrast: false});
            const css = shellStylesheet({accent: this._shared.get_string('accent'), tint: this._shared.get_string('tint'), sidebar: e.sidebar, content: e.content, elevated: e.elevated, dark: this._shellDark()});
            if (css === this._shellCss && this._shellFile) return;
            const dir = GLib.build_filenamev([GLib.get_user_cache_dir(), 'niro']);
            GLib.mkdir_with_parents(dir, 0o755);
            const path = GLib.build_filenamev([dir, 'shell-appearance.css']);
            GLib.file_set_contents(`${path}.tmp`, css);
            Gio.File.new_for_path(`${path}.tmp`).move(Gio.File.new_for_path(path), Gio.FileCopyFlags.OVERWRITE, null, null);
            if (this._shellFile) theme.unload_stylesheet(this._shellFile);
            this._shellFile = Gio.File.new_for_path(path);
            theme.load_stylesheet(this._shellFile);
            this._shellCss = css;
        } catch (e) { console.error(`Island: shell stylesheet not applied: ${e.message}`); }
    }

    /** Which surfaces the shell theme draws light text on, measured from the live actors (their own colour, not ours: we set none). */
    _shellDark() {
        const dark = actor => { try { return isDarkSurface(this._rgb(actor.get_theme_node().get_foreground_color())); } catch (_e) { return true; } };
        const sa = Main.panel.statusArea;
        return {panel: dark(sa.dateMenu?._clockDisplay ?? Main.panel), popup: dark(sa.dateMenu?.menu?.actor ?? Main.panel), quick: dark(sa.quickSettings?.menu?.actor ?? Main.panel), overview: dark(Main.overview.searchEntry ?? Main.panel)};
    }

    _rgb(c) { return {r: c.red / 255, g: c.green / 255, b: c.blue / 255}; }

    _unloadShellStyle() {
        if (!this._shellFile) return;
        St.ThemeContext.get_for_stage(global.stage).get_theme().unload_stylesheet(this._shellFile);
        this._shellFile = null; this._shellCss = null;
    }

    /** A preset or profile writes several keys at once: the Shell stylesheet is built once, shortly after the last of them. */
    _queueShell() {
        if (this._shellTimer) return;
        this._shellTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 250, () => { this._shellTimer = 0; this._shellStyle(); return GLib.SOURCE_REMOVE; });
    }

    /** One rewrite at a time, shortly after the last change; refreshGtk skips files whose content would not change. */
    _queueGtk() {
        if (this._gtkTimer) return;
        this._gtkTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 400, () => {
            this._gtkTimer = 0;
            try {
                const values = Object.fromEntries(PRESET_KEYS.map(k => [k, typeof this._shared.get_value(k).unpack() === 'boolean' ? this._shared.get_boolean(k) : this._shared.get_int(k)]));
                const e = effective(values, {safeMode: this._flag('safe-mode', false), highContrast: this._a11y.get_boolean('high-contrast')});
                refreshGtk({configDir: GLib.get_user_config_dir(), // third-party GTK 4 apps follow GNOME's scheme and GTK 3 apps their theme: Niro's own light/dark choice is for its panel only
                    scheme: resolveScheme('system', this._iface.get_string('color-scheme')), scheme3: gtk3Scheme(this._iface.get_string('gtk-theme')),
                    glass: e.glass, tint: this._shared.get_string('tint'), surfaces: {sidebar: e.sidebar, content: e.content, elevated: e.elevated},
                    disabled: !this._flag('universal-enabled', true) || !this._flag('affect-gtk', true)});
            } catch (err) { console.error(`Island: GTK stylesheet not refreshed: ${err.message}`); }
            return GLib.SOURCE_REMOVE;
        });
    }

    /** Island's own highlights in the accent: its stylesheet names the colour in a few places, overridden here. */
    _applyAccent(accent) {
        const dir = GLib.build_filenamev([GLib.get_user_cache_dir(), 'niro']);
        GLib.mkdir_with_parents(dir, 0o755);
        const path = GLib.build_filenamev([dir, 'accent.css']);
        const css = `.island-pill-accent, .island-sys-fill, .island-privacy-dot.screenShare { background-color: ${accent}; }
.island-power-on { background-color: ${accent}; color: #ffffff; }
.island-power-danger { color: ${accent}; }
`;
        GLib.file_set_contents(path, css);
        const theme = St.ThemeContext.get_for_stage(global.stage).get_theme();
        const file = Gio.File.new_for_path(path);
        if (this._accentFile)
            theme.unload_stylesheet(this._accentFile);
        theme.load_stylesheet(file);
        this._accentFile = file;
    }

    _apply() {
        this._migrate();
        this._surfaces();
        this._queueShell();
        this._queueGtk();
        // Universal Appearance: switched off (or off for the shell), the island, dock and search keep the values they have;
        // safe mode and performance mode make the glass solid and drop the blur (mirrors effective() in control/src/appearance.ts)
        const flag = (key, fallback) => { try { return this._shared.get_boolean(key); } catch (_e) { return fallback; } };
        if (!flag('universal-enabled', true) || !flag('affect-shell', true))
            return;
        const safe = this._safe();
        const opacity = safe ? 100 : this._shared.get_int('opacity');
        const blur = this._shared.get_boolean('blur') && !safe && !flag('performance-mode', false);
        const strength = this._shared.get_int('blur-strength');
        this._island.set_int('glass-tint', opacity);
        const accent = this._shared.get_string('accent');
        const tint = this._shared.get_string('tint');
        try {
            this._applyAccent(accent);
        } catch (e) {
            console.error(`Island: accent not applied: ${e.message}`);
        }
        if (this._dock) {
            this._dock.set_int('dock-opacity', opacity);
            this._dock.set_boolean('dock-blur-enabled', blur);
            this._dock.set_string('dock-background-color', tint);
            this._dock.set_string('custom-css',
                `.dock-indicator-dot { background-color: ${accent}; } .dock-indicator-bar { background-color: ${accent}; }`);
        }
        if (this._blur) {
            try {
                setBlurRadius(this._blur, strength);
            } catch (e) {
                console.error(`Island: blur strength not applied: ${e.message}`);
            }
        }
        if (this._apps) {
            // (the whole-window opacity is handled by _migrate: 255 unless the old fade was switched back on)
            this._apps.set_boolean('blur', blur);
        }
    }

    destroy() {
        if (this._accentFile) {
            St.ThemeContext.get_for_stage(global.stage).get_theme().unload_stylesheet(this._accentFile);
            this._accentFile = null;
        }
        if (this._id)
            this._shared.disconnect(this._id);
        this._id = 0;
        if (this._ifaceId) this._iface.disconnect(this._ifaceId);
        this._unloadShellStyle();
        if (this._themeId) this._iface.disconnect(this._themeId);
        if (this._a11yId) this._a11y.disconnect(this._a11yId);
        this._ifaceId = this._themeId = this._a11yId = 0;
        if (this._shellTimer) GLib.source_remove(this._shellTimer);
        this._shellTimer = 0;
        if (this._gtkTimer) GLib.source_remove(this._gtkTimer);
        this._gtkTimer = 0;
    }
}
