// What typing in Search costs: nothing is fetched, spawned or re-read per keystroke. The extension's class runs with the Shell stubbed out.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import {fileNeedle, findArgs, rankFiles} from '../../shell/search/build/files.js';
import {contentNeedle, grepArgs, historyMatches} from '../../shell/search/build/lookups.js';
import {moneyQuery} from '../../shell/search/build/units.js';

const timers = new Map(), spawned = [], sent = [], dbus = [], reads = [];
let ids = 0;
const GLib = {
    PRIORITY_DEFAULT: 0, SOURCE_REMOVE: false, UserDirectory: {DIRECTORY_DOCUMENTS: 0, DIRECTORY_DESKTOP: 1},
    timeout_add: (_p, _ms, fn) => { timers.set(++ids, fn); return ids; }, timeout_add_seconds: () => ++ids, source_remove: id => timers.delete(id),
    get_home_dir: () => '/home/u', get_user_special_dir: () => '/home/u/Documents', Variant: class {},
};
const Gio = {
    SubprocessFlags: {}, FileQueryInfoFlags: {}, DBusCallFlags: {},
    Subprocess: {new: argv => {
        const p = {argv, killed: false, force_exit() { this.killed = true; }, communicate_utf8_async(_i, _c, cb) { this.end = out => cb({communicate_utf8_finish: () => [true, out]}, null); }};
        spawned.push(p);
        return p;
    }},
    File: {new_for_path: path => ({query_info: () => ({get_size: () => 5}), read: () => { reads.push(path); return {read_bytes: () => ({toArray: () => new TextEncoder().encode('docker ps\n')}), close() {}}; }})},
    DBus: {session: {call: (...a) => dbus.push(a.at(-1))}},
};
const Soup = {Message: {new: (_m, url) => ({url, get_status: () => 200})}, Status: {OK: 200}};
const deps = {GLib, Gio, Soup, Extension: class {}, Clutter: {Orientation: {}}, PACKAGE_VERSION: '51',
    fileNeedle, findArgs, rankFiles, contentNeedle, grepArgs, historyMatches, moneyQuery, parseEvents: () => []};
const js = readFileSync(new URL('../../shell/search/build/extension.js', import.meta.url), 'utf8').replace(/^import [^\n]*;$/gm, '').replace('export default class', 'return class');
const Search = new Function(...Object.keys(deps), js)(...Object.values(deps));

function palette() {
    const s = new Search();
    Object.assign(s, {text: '', draws: 0, said: [], _files: new Map(), _contents: new Map(), _net: new Map(), _procs: new Map(), _rates: new Map()});
    s._entry = {get_text: () => s.text};
    s._soup = {send_and_read_async: (msg, _p, _c, cb) => sent.push({url: msg.url, answer: body => cb({send_and_read_finish: () => ({get_data: () => new TextEncoder().encode(body)})}, null)})};
    s._live = () => true;
    s._say = t => s.said.push(t);
    return s;
}
const type = (s, text) => { s.text = text; if (text !== s._typed) s._rest(text); };
const rest = () => { for (const [id, fn] of [...timers]) { timers.delete(id); fn(); } };

test('find and grep wait for the typing to rest, and a superseded one is killed and not cached', () => {
    const s = palette();
    s._refresh = () => { s._findFiles(s.text); if (contentNeedle(s.text)) s._searchContents(contentNeedle(s.text)); };
    for (const t of ['f re', 'f rep']) { type(s, t); s._refresh(); }
    assert.equal(spawned.length, 0);
    assert.equal(timers.size, 1);
    rest();
    assert.equal(spawned.length, 1);
    type(s, 'fc invoice');
    assert.equal(spawned[0].killed, true);
    spawned[0].end('/home/u/rep\n');
    assert.equal(s._files.size, 0);
    s._refresh(); rest();
    assert.equal(spawned[1].argv[0], 'grep');
    s._stopSearch('_grepRun');
    spawned[1].end('');
    assert.equal(s._contents.size, 0);
});

test('a web answer is drawn although more was typed; its failure is only shown while the query asks for it', () => {
    const s = palette();
    s._refresh = () => s.draws++;
    type(s, 'define word');
    s._remote('def:word', 'u1', j => j);
    assert.equal(sent.length, 0);
    rest();
    s._wanted = new Set();
    s._remote('def:word', 'u1', j => j);
    s._remote('def:other', 'u2', j => j);
    s.text = 'define word ';
    s.draws = 0;
    sent[0].answer('"ok"');
    assert.equal(s.draws, 1);
    s._wanted = new Set(['def:word']);
    sent[1].answer('not json');
    assert.deepEqual(s.said, []);
});

test('the shell history is read once, and the calendar is asked once without blocking', () => {
    const s = palette();
    s._refresh = () => s.draws++;
    assert.deepEqual(s._terminalHistory('dock'), ['docker ps']);
    s._terminalHistory('docker');
    assert.equal(reads.length, 2);                       // .bash_history and .zsh_history, once each
    assert.equal(s._agendaEvents(), null);
    assert.equal(s._agendaEvents(), null);
    assert.equal(dbus.length, 1);
    dbus[0]({call_finish: () => ({deepUnpack: () => [{deepUnpack: () => '[]'}]})}, null);
    assert.deepEqual(s._agendaEvents(), []);
    assert.equal(s.draws, 1);
});
