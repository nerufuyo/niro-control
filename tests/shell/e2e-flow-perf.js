// Timing client for tests/shell/e2e-flow-perf.sh: runs against the private session bus it is started in.
//   gjs -m e2e-flow-perf.js ping N          org.freedesktop.DBus.Peer.Ping on org.niro.Search (the bus round trip alone)
//   gjs -m e2e-flow-perf.js dispatch ID ARGS N   Search RunAction ID ARGS, N times, one after the other (@I@ in ARGS becomes the
//                                                call number: Search refuses an identical repeated request as a duplicate)
//   gjs -m e2e-flow-perf.js flowrun PREFIX N     Flow RunNow of the workflows PREFIX-0 .. PREFIX-(N+2), one each (Flow's cooldown and
//                                                loop guard refuse a quick repeat of one workflow), until WorkflowCompleted/Failed arrives
// Prints one line: `<what> n=.. min=.. median=.. p95=.. max=.. mean=..` in milliseconds (monotonic clock, in-process).
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

const bus = Gio.DBus.session;
const [what, ...rest] = ARGV;
const ms = () => GLib.get_monotonic_time() / 1000;

function stats(label, xs) {
    const s = [...xs].sort((a, b) => a - b);
    const q = p => s[Math.min(s.length - 1, Math.floor(p * s.length))];
    const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
    print(`${label} n=${xs.length} min=${s[0].toFixed(2)} median=${q(0.5).toFixed(2)} p95=${q(0.95).toFixed(2)} max=${s[s.length - 1].toFixed(2)} mean=${mean.toFixed(2)}`);
}

function call(name, path, iface, method, params, replyType) {
    return bus.call_sync(name, path, iface, method, params, replyType ? new GLib.VariantType(replyType) : null, Gio.DBusCallFlags.NO_AUTO_START, 30000, null);
}

if (what === 'ping') {
    const n = parseInt(rest[0], 10), xs = [];
    for (let i = 0; i < 20; i++) call('org.niro.Search', '/org/niro/Search', 'org.freedesktop.DBus.Peer', 'Ping', null, '()');
    for (let i = 0; i < n; i++) {
        const t = ms();
        call('org.niro.Search', '/org/niro/Search', 'org.freedesktop.DBus.Peer', 'Ping', null, '()');
        xs.push(ms() - t);
    }
    stats('peer-ping', xs);
} else if (what === 'dispatch') {
    const [id, args, nText] = rest, n = parseInt(nText, 10), xs = [];
    let seq = 0;
    const run = () => call('org.niro.Search', '/org/niro/Search', 'org.niro.Search', 'RunAction', new GLib.Variant('(ss)', [id, args.replaceAll('@I@', String(seq++))]), '(s)');
    for (let i = 0; i < 10; i++) run();   // warm up
    let last = '';
    for (let i = 0; i < n; i++) {
        const t = ms();
        last = run().deepUnpack()[0];
        xs.push(ms() - t);
    }
    stats(`dispatch ${id}`, xs);
    print(`last answer: ${last.slice(0, 120)}`);
} else if (what === 'flowrun') {
    const [prefix, nText] = rest, n = parseInt(nText, 10), xs = [], replies = [];
    const loop = GLib.MainLoop.new(null, false);
    let doneAt = 0, outcome = '';
    for (const sig of ['WorkflowCompleted', 'WorkflowFailed']) {
        bus.signal_subscribe('org.niro.island.Daemon', 'org.niro.Flow1', sig, '/org/niro/island/Daemon', null, Gio.DBusSignalFlags.NONE, () => { doneAt = ms(); outcome = sig; loop.quit(); });
    }
    const failures = [];
    for (let i = 0; i < n + 3; i++) {
        doneAt = 0;
        const wf = `${prefix}-${i}`;
        const t = ms();
        try { call('org.niro.island.Daemon', '/org/niro/island/Daemon', 'org.niro.Flow1', 'RunNow', new GLib.Variant('(s)', [wf]), '(s)'); } catch (e) { failures.push(e.message); break; }
        const reply = ms() - t;
        if (!doneAt) {
            const guard = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 20000, () => { loop.quit(); return GLib.SOURCE_REMOVE; });
            loop.run();
            GLib.source_remove(guard);
        }
        if (!doneAt) { failures.push('no completion signal'); break; }
        if (outcome !== 'WorkflowCompleted') failures.push(outcome);
        if (i >= 3) { xs.push(doneAt - t); replies.push(reply); }   // the first three are warm-up
    }
    if (xs.length) { stats(`flow RunNow->completed ${prefix}-*`, xs); stats('flow RunNow reply only', replies); }
    print(`failures: ${failures.length ? failures.slice(0, 3).join(' | ') : 'none'}`);
} else {
    print('usage: ping N | dispatch ID ARGS N | flowrun PREFIX N');
}
