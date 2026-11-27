// The dock reads Downloads off the main loop: one read at a time, and none that finishes after the stacks are gone. GNOME is faked.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {registerHooks} from 'node:module';

const reads = [];                                       // folder reads, finished by the test
let timer = null;
const folder = {                                        // no enumerate_children: nothing may block
    enumerate_children_async: (...a) => reads.push(() => a[4](null, null)),
    enumerate_children_finish() {
        let batches = [[{get_name: () => 'a.part', get_attribute_uint64: () => Math.floor(Date.now() / 1000)}], []];
        return {next_files_async: (...a) => a[3](null, null), next_files_finish: () => batches.shift(), close_async() {}};
    },
};
globalThis.__fake = {
    Gio: {File: {new_for_path: () => folder}, FileQueryInfoFlags: {}, Cancellable: class { cancel() { this.done = true; } is_cancelled() { return !!this.done; } }},
    GLib: {timeout_add: (_p, _ms, fn) => { timer = fn; return 1; }, source_remove() {}},
};
const fake = src => ({url: `data:text/javascript,${encodeURIComponent(src)}`, shortCircuit: true});
registerHooks({resolve(spec, ctx, next) {
    if (spec.startsWith('gi://')) return fake(`export default globalThis.__fake['${spec.slice(5)}'] ?? {};`);
    if (spec.startsWith('resource://')) return fake('export default {};');
    if (spec === './motion.js') return fake('export const animationsEnabled = () => true;');
    if (spec === './compat.js') return fake('export const box = () => ({});');
    if (spec === './iconTheme.js') return fake('export class ThemeResolver {}');
    return next(spec, ctx);
}});
const settle = () => new Promise(setImmediate);

test('dock download scans do not overlap and do not outlive the stacks', async () => {
    const {IconManager} = await import('../../shell/dock/dist/lib/iconManager.js');
    const m = Object.assign(Object.create(IconManager.prototype), {_downloadTimer: 0, _downloadScan: null, _downloadActiveSeconds: 90, _downloading: 0});

    m._scheduleDownloadScan('/d'); timer();
    m._scheduleDownloadScan('/d');                      // changes while reading
    assert.equal(reads.length, 1);
    assert.equal(m._downloadTimer, 0);
    reads.shift()(); await settle();
    assert.equal(m._downloading, 1);
    assert.equal(m._downloadTimer, 1);                  // one more look afterwards

    timer();
    m._unwatchDownloads();                              // disabled while reading
    reads.shift()(); await settle();
    assert.equal(m._downloading, 0);
});
