// The screen locking mid-restore (it turns Island off) must lose nothing. The class runs with GNOME stubbed out.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';

test('a restore cut short carries on after the unlock, saving nothing and starting nothing twice', () => {
    const files = new Map([['state/niro/session.json', JSON.stringify({apps: [{id: 'a', windows: [{workspace: -1}]}, {id: 'b', windows: [{}]}]})]]);
    const saved = files.get('state/niro/session.json');
    const timers = new Map();
    let next = 0;
    const started = [];
    let windowCreated;
    let stuck = 0;
    const file = path => ({
        load_contents: () => {
            if (path === '/proc/self/stat')
                return [true, new TextEncoder().encode('1 (gnome-shell) S')];
            if (!files.has(path))
                throw new Error('none');
            return [true, new TextEncoder().encode(files.get(path))];
        },
        replace_contents: bytes => files.set(path, new TextDecoder().decode(bytes)),
    });
    const deps = {
        Gio: {File: {new_for_path: file}, FileCreateFlags: {}},
        GLib: {
            build_filenamev: parts => parts.join('/'), get_user_state_dir: () => 'state', getenv: () => 'marker',
            path_get_dirname: p => p, mkdir_with_parents: () => {}, get_monotonic_time: () => 0,
            timeout_add: (_priority, _ms, run) => (timers.set(++next, run), next),
            Source: {remove: id => timers.delete(id)},
        },
        Meta: {WindowType: {NORMAL: 0}},
        // Both stay "stopped", as an app does until its window shows.
        Shell: {
            AppState: {STOPPED: 0},
            AppSystem: {get_default: () => ({connect: () => 1, disconnect: () => {},
                lookup_app: id => ({state: 0, get_windows: () => [], activate: () => started.push(id)})})},
            WindowTracker: {get_default: () => ({get_window_app: win => ({get_id: () => win.id})})},
        },
        maximize: () => {},
        global: {window_manager: {connect: () => 1, disconnect: () => {}}, display: {connect: (_signal, run) => (windowCreated = run, 1), disconnect: () => {}},
            get_window_actors: () => []},
    };
    const js = readFileSync(new URL('../../shell/island/src/sessionRestore.ts', import.meta.url), 'utf8')
        .replace(/^import[\s\S]*?;$/gm, '').replace('export class', 'class');
    const SessionRestore = new Function(...Object.keys(deps), `${js}\nreturn SessionRestore;`)(...Object.values(deps));
    const settings = {connect: () => 1, disconnect: () => {}, get_boolean: () => true, get_int: () => 1, get_strv: () => []};
    const tick = () => {
        const [id, run] = timers.entries().next().value;
        timers.delete(id);
        run();
    };

    const first = new SessionRestore(settings);
    tick(); // the delay: "a" starts
    first.destroy(); // locked

    const second = new SessionRestore(settings);
    second.save();
    // "a" was started before the lock and shows its window only now: it is still put in its place.
    windowCreated(null, {id: 'a', window_type: 0, stick: () => stuck++, get_compositor_private: () => null});
    assert.equal(stuck, 1);
    assert.equal(files.get('state/niro/session.json'), saved);
    tick(); // the delay: "b" starts
    second.destroy(); // locked again, before it settled

    new SessionRestore(settings);
    assert.equal(files.has('marker'), false);
    tick(); // the delay: nothing left
    tick(); // settled
    assert.deepEqual(started, ['a', 'b']);
    assert.equal(files.has('marker'), true);
});
