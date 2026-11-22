// @ts-nocheck: the shared cores are plain JS copied into build/shared by the build
// Which capability (shared/permissions.js) a program needs to run each Search action, and the permission gate for programs that call
// over D-Bus. Pure: no GNOME imports, so node tests it. With `permissions-enforced` off nothing here is consulted.
import {CAPABILITIES, createPermissions} from './shared/permissions.js';

/** null: the action only computes or reads what the caller already passed in; it needs no capability. */
export const ACTION_CAPABILITY: Record<string, string | null> = {
    'app.launch': 'launch',
    'file.open': 'file', 'qr.make': 'file', 'snip.open': 'file', 'note.add': 'file', 'todo.add': 'file', 'todo.done': 'file', 'habit.log': 'file', 'macro.save': 'file',
    'clipboard.copy': 'clipboard',
    'window.activate': 'window', 'window.above.toggle': 'window', 'layout.save': 'window', 'layout.restore': 'window',
    'ha.call': 'network', 'system.network.speed': 'network', 'system.network.devices': 'network',
    'system.battery.info': 'device',
    'process.kill': 'automation', 'autostart.toggle': 'automation', 'settings.open': 'automation', 'profile.apply': 'automation', 'profile.undo': 'automation',
    'system.vpn.toggle': 'automation', 'system.clean.trash': 'automation', 'system.clean.thumbnails': 'automation', 'system.spotlight.toggle': 'automation',
    'system.zoom.toggle': 'automation', 'system.record': 'automation', 'system.lock': 'automation', 'system.dnd.toggle': 'automation',
    'system.presentation.toggle': 'automation', 'system.wifi.toggle': 'automation', 'system.bluetooth.toggle': 'automation', 'system.mute.toggle': 'automation',
    'system.nightlight.toggle': 'automation', 'system.snip': 'automation', 'system.snip.delay': 'automation', 'system.snip.full': 'automation',
    'system.screenshot': 'automation', 'system.suspend': 'automation', 'system.logout': 'automation', 'system.restart': 'automation', 'system.shutdown': 'automation',
    'plan.run': 'automation', 'macro.play': 'automation',
    'clipboard.smart.sweep': 'clipboard',
    'notifications.summary': 'notifications', 'notifications.snooze': 'notifications', 'notifications.rule': 'notifications', 'notifications.quiet': 'notifications', 'notifications.clear': 'notifications',
    'perf.report': 'device', 'perf.export': 'device', 'widgets.list': 'device', 'widgets.show': 'device', 'privacy.status': 'device', 'privacy.history': 'device',
    'audio.devices': 'device', 'audio.streams': 'device', 'audio.stream.volume': 'automation', 'audio.stream.move': 'automation',
    'hud.show': 'notifications',
    'collection.list': 'file', 'collection.create': 'file', 'collection.add': 'file', 'collection.remove': 'file', 'collection.delete': 'file',
    'text.transform': null, 'url.clean': null, 'clipboard.sensitive.check': null, 'extensions.check': null,
    'plan.preview': null, 'macro.list': null, 'macro.stop': null, 'adaptive.dismiss': null, 'adaptive.history': null, 'adaptive.lock': null,
};

/** The capability an action needs. An action this table does not know needs 'automation': a new action is never silently free. */
export function capabilityFor(id: string): string | null {
    return Object.prototype.hasOwnProperty.call(ACTION_CAPABILITY, id) ? ACTION_CAPABILITY[id] : 'automation';
}

export const CAPABILITY_TEXT: Record<string, string> = {
    file: 'read or write your files', clipboard: 'use the clipboard', window: 'move or switch your windows', launch: 'start applications',
    network: 'use the network or read its state', device: 'read device information', automation: 'change settings and run system actions',
    'ai-external': 'send text to an outside AI service', notifications: 'show notifications', plugin: 'act as a plugin',
};

/** A D-Bus caller's process name as a permission subject (letters, digits and . _ : - only, at most 80). */
export function subjectOf(caller: string | null | undefined): string {
    const s = String(caller ?? 'unknown').replace(/[^\w.:-]/g, '_').slice(0, 80);
    return s || 'unknown';
}

/**
 * The gate and the store behind it. `read`/`write` are the file (JSON text) in the user's config dir; `ask(subject, capability)` shows the
 * dialog and answers 'deny' | 'once' | 'always'. Nothing is cached between calls except the grants themselves, so a revoke is enforced by the next call.
 */
export function createGate({read = () => null, write = () => {}, ask = async () => 'deny', now = () => Date.now()} = {}) {
    const perms = createPermissions({now});
    const text = read();
    if (typeof text === 'string') perms.load(text);
    const save = () => { try { write(perms.serialize()); } catch (_e) { /* the grant still holds for this session */ } };
    return {
        perms,
        /** {allowed, reason?, capability}. Actions with no capability always pass. */
        async check(caller: string, actionId: string) {
            const capability = capabilityFor(actionId);
            if (capability === null) return {allowed: true, capability};
            const subject = subjectOf(caller);
            let verdict = perms.decide(subject, capability);
            if (verdict === 'deny') return {allowed: false, capability, reason: `${subject} is not allowed to ${CAPABILITY_TEXT[capability]}`};
            if (verdict === 'ask') {
                let answer = 'deny';
                try { answer = await ask(subject, capability); } catch (_e) { answer = 'deny'; }
                if (answer === 'always') { perms.grant(subject, capability, 'always'); save(); }
                else if (answer === 'once') perms.grant(subject, capability, 'once');
                else return {allowed: false, capability, reason: `${subject} was not allowed to ${CAPABILITY_TEXT[capability]}`};
                verdict = perms.decide(subject, capability);       // spends a 'once' and records the final verdict
            }
            return verdict === 'allow' ? {allowed: true, capability} : {allowed: false, capability, reason: 'not allowed'};
        },
        /** Throws what is wrong with a grant, without making it. */
        validate(subject: string, capability: string, scope: string) { createPermissions().grant(subject, capability, scope); },
        grant(subject: string, capability: string, scope: string) { perms.grant(subject, capability, scope); save(); },
        revoke(subject: string, capability: string | null = null) { perms.revoke(subject, capability || null); save(); },
        list: () => perms.list(),
        history: (limit = 50) => perms.history().slice(-Math.max(1, Math.min(limit, 200))),
        clearHistory: () => perms.clearHistory(),
    };
}

export {CAPABILITIES};
