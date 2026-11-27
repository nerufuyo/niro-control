// A folder stack still being read when a drag starts must not open its menu during the drag. GNOME is faked.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {registerHooks} from 'node:module';

globalThis.__fake = {Gio: {Cancellable: class { cancel() { this.done = true; } is_cancelled() { return !!this.done; } }}};
const fake = src => ({url: `data:text/javascript,${encodeURIComponent(src)}`, shortCircuit: true});
registerHooks({resolve(spec, ctx, next) {
    if (spec.startsWith('gi://')) return fake(`export default globalThis.__fake['${spec.slice(5)}'] ?? {};`);
    if (spec.endsWith('/ui/popupMenu.js')) return fake('export class PopupMenu { constructor() { throw new Error("menu opened"); } }');
    if (spec.startsWith('resource://')) return fake('export default {};');
    if (spec === './motion.js') return fake('export const animationsEnabled = () => true;');
    if (spec === './compat.js') return fake('export const box = () => ({});');
    if (spec === './iconTheme.js') return fake('export class ThemeResolver {}');
    return next(spec, ctx);
}});

test('a drag cancels a pending dock folder stack', async () => {
    const {IconManager} = await import('../../shell/dock/dist/lib/iconManager.js');
    let read;
    const m = Object.assign(Object.create(IconManager.prototype), {
        _menuManager: {}, _stackScan: null, _stackMenu: null,
        _closeContextMenu() {}, _hideTooltip() {}, _captureSlot: () => null,
        _stackSpec: () => ({name: 'Downloads', file: {}}),
        _stackFiles: () => new Promise(resolve => { read = resolve; }),
    });

    const opening = m._openStack({}, 'downloads');
    m._onDragBegin('a.desktop');
    read([]);
    await opening;                                      // would reject with "menu opened"
});
