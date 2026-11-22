# Lifecycle: the extension disabled and enabled five times, each time with something live (music, a timer, an open island, an alert, a
# morph in flight), and nothing may be left behind: no GLib timeout the island made, no signal on the shell's long-lived objects, no
# actor in the UI group or the layout manager's chrome, no error in the shell log. The counters wrap GLib.timeout_add/source_remove and
# GObject connect/disconnect inside the shell; the baseline is the shell with the island disabled.
UUID=island@niro.local
source "$HERE/island-steps-lib.sh"
LC="Main.extensionManager.lookup('$UUID').stateObj._controller"
state() { ev "Main.extensionManager.lookup('$UUID').state"; }
wait_enabled() { for i in $(seq 1 40); do [ "$(state)" = "1" ] && ev "Main.extensionManager.lookup('$UUID').stateObj._controller ? 1 : 0" | grep -q 1 && return 0; sleep 0.5; done; return 1; }
isl_set string auto-hide "'off'"
start_player; sleep 3; PLAY Play; sleep 2
# The instruments (installed once, in the shell). A timeout counts as left behind only while its source still exists in the main context, a
# signal only while its handler is still connected, so removal by any route (source_remove, Source.remove, returning false) is honoured.
ev "(function(){
  const GLib = imports.gi.GLib, GObject = imports.gi.GObject, St = imports.gi.St;
  const L = globalThis.__life = {live: new Map(), conns: new Map(), long: new Map(), calls: {add: 0, conn: 0}};
  const add = GLib.timeout_add;
  GLib.timeout_add = function(prio, ms, fn, ...rest) { L.calls.add++; const id = add.call(GLib, prio, ms, fn, ...rest); L.live.set(id, {ms, fn: String(fn).split(String.fromCharCode(10)).join(' ').slice(0, 110)}); return id; };
  const targets = {stage: global.stage, display: global.display, wm: global.window_manager, ws: global.workspace_manager, global: global, st: St.Settings.get(), layout: Main.layoutManager, overview: Main.overview, tray: Main.messageTray, session: Main.sessionMode};
  for (const [k, o] of Object.entries(targets)) L.long.set(o, k);
  const proto = GObject.Object.prototype, oc = proto.connect;
  proto.connect = function(name, fn) { const id = oc.call(this, name, fn); L.calls.conn++; const k = L.long.get(this); if (k) L.conns.set(k + ':' + id, {obj: this, id, name}); return id; };
  return 1; })()" > /dev/null
census() { # label: written as a file by the shell itself
    ev "(function(){ const L = __life, GLib = imports.gi.GLib, GObject = imports.gi.GObject, ctx = GLib.MainContext.default();
      const live = [...L.live].filter(([id]) => ctx.find_source_by_id(id) !== null);
      const conns = [...L.conns.values()].filter(c => GObject.signal_handler_is_connected(c.obj, c.id));
      GLib.file_set_contents('$OUT/census-$1.json', JSON.stringify({uiGroup: Main.uiGroup.get_n_children(), chrome: Main.layoutManager._trackedActors.length, timeouts: live.length,
        conns: conns.length, leftoverTimeouts: live.map(([id, v]) => v.ms + 'ms ' + v.fn), leftoverConns: conns.map(c => L.long.get(c.obj) + ':' + c.name), instrumented: L.calls})); return 1; })()" > /dev/null
}
# Baseline: the island disabled.
ev "Main.extensionManager.disableExtension('$UUID'); 1" > /dev/null; sleep 2
echo "STATE_DISABLED $(state)"
census baseline
for n in 1 2 3 4 5; do
    ev "Main.extensionManager.enableExtension('$UUID'); 1" > /dev/null
    wait_enabled || echo "FAIL enable $n did not finish"
    sleep 1.5
    ev "$LC._daemon.call('pomodoro', 'Start'); 1" > /dev/null
    case $n in
        1) sleep 2 ;;                                                                      # closed, music + timer (split)
        2) ev "$LC.expand('music'); 1" > /dev/null; sleep 2 ;;                              # open on the music page
        3) ev "$LC.expand('timer'); 1" > /dev/null; sleep 1.2 ;;                            # open, the timer page
        4) ev "$LC._post({key: 'lc-alert', kind: 'notification', priority: 'instant', tone: 'warning', title: 'Alert $n', subtitle: 'while disabled', icon: 'dialog-warning-symbolic', duration: 5000}); 1" > /dev/null; sleep 0.9 ;;
        5) ev "$LC.expand('music'); 1" > /dev/null; sleep 0.09 ;;                           # mid-morph
    esac
    echo "CYCLE $n $(ev "$LC._surface.state + '/' + $LC._presentation + ' morphing=' + $LC._island.morphing")"
    ev "Main.extensionManager.disableExtension('$UUID'); 1" > /dev/null
    sleep 2
    echo "STATE_$n $(state)"
    census "disabled_$n"
done
# And enabled once more, working.
ev "Main.extensionManager.enableExtension('$UUID'); 1" > /dev/null; wait_enabled && echo "FINAL_ENABLED 1"; sleep 2
ev "$LC.expand('music'); 1" > /dev/null; sleep 1.5
echo "FINAL $(ev "$LC._surface.state + '/' + $LC._presentation + ' ' + $LC._island.width + 'x' + $LC._island.height")"
ev "$LC.collapse(); 1" > /dev/null; sleep 1.5
python3 "$HERE/island-lifecycle.py" "$OUT" 2>&1 || true
