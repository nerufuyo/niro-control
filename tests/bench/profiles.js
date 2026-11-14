// Profile engine timings against a throw-away settings backend and config folder (nothing real is touched).
// Prints JSON: {op: [ms, ...]}. Run by scripts/benchmark-performance.sh.
import GLib from 'gi://GLib';

import {ProfileEngine} from '../../control/build/profiles.js';
import {Stores} from '../../control/build/store.js';

const N = Number(GLib.getenv('NIRO_BENCH_N') ?? 30);
const tmp = GLib.dir_make_tmp('niro-bench-XXXXXX');
const builtinDir = GLib.path_get_dirname(import.meta.url.replace('file://', '')) + '/../../control/profiles';
const engine = new ProfileEngine(new Stores(), {root: tmp, builtinDir});
const out = {list: [], diff: [], apply: [], backup: [], restore: []};
const time = (key, fn) => { const a = GLib.get_monotonic_time(); const r = fn(); out[key].push((GLib.get_monotonic_time() - a) / 1000); return r; };

for (let i = 0; i < N; i++) {
    time('list', () => engine.list());
    const id = i % 2 ? 'everyday' : 'gaming';
    const settings = engine.settingsOf(engine.get(id));
    time('diff', () => engine.preview(settings));
    time('apply', () => engine.apply(id));
    time('backup', () => engine.backup('bench'));
    const file = engine.backups()[0].file;
    time('restore', () => engine.restore(file));
}
print(JSON.stringify(out));
