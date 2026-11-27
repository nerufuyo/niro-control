// The system docks the dock turned off are turned on again even by a later instance (after a lock or a new login). GNOME is faked.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {registerHooks} from 'node:module';

const enabled = [];
const states = {'ubuntu-dock@ubuntu.com': 1};
globalThis.__manager = {
    lookup: uuid => uuid in states ? {state: states[uuid]} : null,
    disableExtension: uuid => { states[uuid] = 2; },
    enableExtension: uuid => { states[uuid] = 1; enabled.push(uuid); },
};
const fake = src => ({url: `data:text/javascript,${encodeURIComponent(src)}`, shortCircuit: true});
registerHooks({resolve(spec, ctx, next) {
    if (spec.startsWith('gi://')) return fake('export default {};');
    if (spec.endsWith('/ui/main.js')) return fake('export const extensionManager = globalThis.__manager;');
    if (ctx.parentURL?.endsWith('/dockManager.js')) {
        // the dock's other parts are not under test: stand-ins with the names it imports
        const names = {compat: ['box', 'inhibitScanout', 'isWayland', 'setVertical'], dockVisibility: ['DockVisibility'], genie: ['genie'],
            iconManager: ['IconManager'], intellihide: ['Intellihide'], magnification: ['Magnification'], mediaManager: ['MediaManager'],
            signalManager: ['SignalManager'], windowPreview: ['WindowPreviewPopup']}[spec.slice(2, -3)];
        if (names) return fake(names.map(n => `export class ${n} {}`).join(';'));
    }
    return next(spec, ctx);
}});

const store = {'disabled-system-docks': []};
let hide = true;
const settings = {get_boolean: () => hide, get_strv: k => [...store[k]], set_strv: (k, v) => { store[k] = [...v]; }};

test('dock remembers across instances which system docks it turned off', async () => {
    const {DockManager} = await import('../../shell/dock/dist/lib/dockManager.js');
    const instance = () => Object.assign(Object.create(DockManager.prototype), {_settings: settings});

    instance()._syncSystemDocks();
    assert.deepEqual(store['disabled-system-docks'], ['ubuntu-dock@ubuntu.com']);

    const later = instance();
    later._syncSystemDocks();                           // already off: still remembered
    assert.deepEqual(store['disabled-system-docks'], ['ubuntu-dock@ubuntu.com']);
    hide = false;
    later._syncSystemDocks();
    assert.deepEqual(enabled, ['ubuntu-dock@ubuntu.com']);
    assert.deepEqual(store['disabled-system-docks'], []);
});
