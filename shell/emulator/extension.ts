// @ts-nocheck: GNOME Shell's modules are untyped here
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

export default class Emulator extends Extension {
    enable() {
        this._conns = [];
        this._createdId = global.display.connect('window-created', (_d, w) => this._handle(w));
        global.get_window_actors().forEach(a => this._handle(a.meta_window));
    }

    _handle(w) {
        if (w.get_wm_class() !== 'Emulator')
            return;
        const apply = () => {
            const title = w.get_title() || '';
            if (title.startsWith('Android Emulator'))
                w.make_above();
            else if (title === 'Emulator' && w.get_transient_for() && !w.minimized)
                w.minimize(); // the side toolbar strip
        };
        apply();
        this._conns.push([w, w.connect('notify::title', apply)]);
        this._conns.push([w, w.connect('notify::minimized', apply)]);
    }

    disable() {
        global.display.disconnect(this._createdId);
        for (const [w, id] of this._conns) {
            try {
                w.disconnect(id);
            } catch (_e) {
                // the window is gone
            }
        }
        this._conns = [];
    }
}
