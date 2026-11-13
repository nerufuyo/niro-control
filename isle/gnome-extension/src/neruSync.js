// One look for the whole desktop: org.neru.desktop (opacity, blur, blur-strength; neru-desktop-defaults installs it)
// is copied, when it changes, to what Isle's glass, the dock and the app windows (Blur my Shell) read. Without the
// schema (the package isn't installed) nothing happens.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';

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

export class NeruSync {
    constructor(isleSettings) {
        this._isle = isleSettings;
        const source = Gio.SettingsSchemaSource.get_default();
        if (!source?.lookup('org.neru.desktop', true))
            return;
        this._shared = new Gio.Settings({schema_id: 'org.neru.desktop'});
        this._dock = extensionSettings('macos-dock@vinnytherobot.github.io', 'org.gnome.shell.extensions.macosdock');
        this._apps = extensionSettings('blur-my-shell@aunetx', 'org.gnome.shell.extensions.blur-my-shell.applications');
        this._id = this._shared.connect('changed', () => this._apply());
        try {
            this._applyAccent(this._shared.get_string('accent'));
        } catch (e) {
            console.error(`Isle: accent not applied: ${e.message}`);
        }
    }

    /** Isle's own highlights in the accent: its stylesheet names the colour in a few places, overridden here. */
    _applyAccent(accent) {
        const dir = GLib.build_filenamev([GLib.get_user_cache_dir(), 'neru']);
        GLib.mkdir_with_parents(dir, 0o755);
        const path = GLib.build_filenamev([dir, 'accent.css']);
        const css = `.isle-pill-accent, .isle-sys-fill, .isle-privacy-dot.screenShare { background-color: ${accent}; }
.isle-power-on { background-color: ${accent}; color: #ffffff; }
.isle-power-danger { color: ${accent}; }
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
        const opacity = this._shared.get_int('opacity');
        const blur = this._shared.get_boolean('blur');
        const strength = this._shared.get_int('blur-strength');
        this._isle.set_int('glass-tint', opacity);
        const accent = this._shared.get_string('accent');
        const tint = this._shared.get_string('tint');
        try {
            this._applyAccent(accent);
        } catch (e) {
            console.error(`Isle: accent not applied: ${e.message}`);
        }
        if (this._dock) {
            this._dock.set_int('dock-opacity', opacity);
            this._dock.set_boolean('dock-blur-enabled', blur);
            this._dock.set_string('dock-background-color', tint);
            this._dock.set_string('custom-css',
                `.macos-dock-indicator-dot { background-color: ${accent}; } .macos-dock-indicator-bar { background-color: ${accent}; }`);
        }
        if (this._apps) {
            this._apps.set_int('opacity', Math.round(opacity * 2.55));
            this._apps.set_boolean('blur', blur);
            this._apps.set_int('sigma', strength);
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
    }
}
