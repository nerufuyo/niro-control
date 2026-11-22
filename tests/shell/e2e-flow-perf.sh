#!/bin/bash
# Measurements for docs/PERFORMANCE-VNEXT.md, in a headless nested GNOME Shell on a private D-Bus session (never the real desktop).
#   vnext     bash tests/shell/run-staged.sh e2e-flow-perf          this checkout (staged) and target/release/island-daemon
#   baseline  NIRO_PERF_MODE=baseline bash tests/shell/e2e-flow-perf.sh   what is installed under /usr (the released package)
# It measures: extension load time (Search, Tile; cold and repeated), Search action dispatch latency (with the bus round trip
# alone for reference), Flow workflow run latency (vnext only), and the daemon's idle CPU and RSS (Flow disabled, enabled with no
# workflow, enabled with one scheduled workflow). HOME and every XDG folder are scratch folders; settings live in memory.
# Env: NIRO_PERF_ONLY_EXT=1 (only the extension load times, then stop: run it several times for several cold starts), NIRO_PERF_IDLE_SECS (default 45, seconds of each idle sample), NIRO_PERF_ROUNDS (default 2), NIRO_PERF_N (default 200 calls).
set -u
cd "$(dirname "$0")/../.."
MODE="${NIRO_PERF_MODE:-vnext}"
if [ "$MODE" = baseline ]; then
  DAEMON=/usr/bin/island-daemon; NIRO_EXT_ROOT=/usr/share/gnome-shell/extensions
else
  [ -n "${NIRO_EXT_ROOT:-}" ] || { echo "vnext mode runs through tests/shell/run-staged.sh e2e-flow-perf"; exit 2; }
  DAEMON="${DAEMON:-$PWD/target/release/island-daemon}"
fi
[ -x "$DAEMON" ] || { echo "no daemon at $DAEMON"; exit 2; }
NIRO_PERF_ONLY_EXT="${NIRO_PERF_ONLY_EXT:-}"; IDLE="${NIRO_PERF_IDLE_SECS:-45}"; ROUNDS="${NIRO_PERF_ROUNDS:-2}"; N="${NIRO_PERF_N:-200}"
WORK=$(mktemp -d); trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/home" "$WORK/config" "$WORK/data" "$WORK/state" "$WORK/cache" "$WORK/svc/dbus-1/services"
# the bus would start the installed daemon by itself the moment something asks for it; this earlier service file makes it a no-op, so the only daemon is the one started here
printf "[D-BUS Service]\nName=org.niro.island.Daemon\nExec=/bin/false\n" > "$WORK/svc/dbus-1/services/org.niro.island.Daemon.service"
export GSETTINGS_BACKEND="${GSETTINGS_BACKEND:-memory}"
export DAEMON WORK MODE IDLE ROUNDS N NIRO_EXT_ROOT NIRO_PERF_ONLY_EXT CLIENT="$PWD/tests/shell/e2e-flow-perf.js"
echo "mode=$MODE daemon=$DAEMON ($("$DAEMON" --version)) extensions=$NIRO_EXT_ROOT cpus=$(nproc) idle=${IDLE}s rounds=$ROUNDS n=$N"

timeout 1500 dbus-run-session -- env HOME="$WORK/home" XDG_CONFIG_HOME="$WORK/config" XDG_DATA_HOME="$WORK/data" XDG_STATE_HOME="$WORK/state" XDG_CACHE_HOME="$WORK/cache" XDG_DATA_DIRS="$WORK/svc:${XDG_DATA_DIRS:-/usr/local/share:/usr/share}" \
  bash -c '
Q=$(printf "\047")
gnome-shell --headless --wayland --no-x11 --unsafe-mode --wayland-display=niro-perf --virtual-monitor 1280x720 > "$WORK/shell.log" 2>&1 & SP=$!
sleep 20
ev() { gdbus call --session --dest org.gnome.Shell --object-path /org/gnome/Shell --method org.gnome.Shell.Eval "$1" 2>&1; }
state() { ev "Main.extensionManager.lookup(\"$1\").state" | grep -oE "[0-9]+" | tail -1; }
now() { date +%s%N; }
ext_ms() { # uuid: enable, poll until ACTIVE (state 1), print ms
  local t0=$(now) s=""
  ev "Main.extensionManager.enableExtension(\"$1\")" >/dev/null
  for i in $(seq 400); do s=$(state "$1"); [ "$s" = 1 ] && break; done
  echo "$(( ($(now) - t0) / 1000000 ))"
}
echo "== extension load (ms from enableExtension to ACTIVE, polled through Eval: +- a few ms)"
echo "search cold $(ext_ms search@niro.local)"
echo "tile cold $(ext_ms tile@niro.local)"
for r in 1 2 3 4 5; do
  t0=$(now); ev "Main.extensionManager.disableExtension(\"search@niro.local\")" >/dev/null
  for i in $(seq 400); do [ "$(state search@niro.local)" = 2 ] && break; done   # 2 = DISABLED
  echo "search disable $r $(( ($(now) - t0) / 1000000 ))"
  echo "search reload $r $(ext_ms search@niro.local)"
done
echo "extension state search=$(state search@niro.local) tile=$(state tile@niro.local)"
[ -n "${NIRO_PERF_ONLY_EXT:-}" ] && { kill $SP; wait $SP 2>/dev/null; exit 0; }
gdbus wait --session --timeout 30 org.niro.Search
sleep 3
echo "== Search dispatch latency (ms; gjs client, synchronous calls, one after the other)"
gjs -m "$CLIENT" ping $N
gjs -m "$CLIENT" dispatch url.clean "{\"url\":\"https://example.com/?utm_source=x&id=@I@\"}" $N
gjs -m "$CLIENT" dispatch clipboard.copy "{\"text\":\"niro-perf-@I@\"}" $N

D="--session --dest org.niro.island.Daemon --object-path /org/niro/island/Daemon"
WFDIR="$WORK/config/niro/flow/workflows"
start_daemon() { # label, env assignments...
  local label=$1; shift
  rm -rf "$WORK/state/niro/flow" "$WORK/config/niro/flow/flow.enabled"
  env -u NIRO_FLOW_ENABLED "$@" "$DAEMON" > "$WORK/daemon-$label.log" 2>&1 & DP=$!
  gdbus wait --session --timeout 30 org.niro.island.Daemon
}
stop_daemon() { kill $DP 2>/dev/null; wait $DP 2>/dev/null; }
sample() { # label: idle CPU and RSS of $DP over $IDLE seconds
  local label=$1 tck=$(getconf CLK_TCK)
  sleep 8
  local a=$(awk "{print \$14+\$15}" /proc/$DP/stat) r0=$(awk "/VmRSS/{print \$2}" /proc/$DP/status)
  sleep $IDLE
  local b=$(awk "{print \$14+\$15}" /proc/$DP/stat) r1=$(awk "/VmRSS/{print \$2}" /proc/$DP/status)
  local th=$(awk "/Threads/{print \$2}" /proc/$DP/status) hwm=$(awk "/VmHWM/{print \$2}" /proc/$DP/status)
  awk -v l="$label" -v a=$a -v b=$b -v t=$tck -v s=$IDLE -v r0=$r0 -v r1=$r1 -v th=$th -v h=$hwm "BEGIN{printf \"idle %-28s cpu_ticks=%d over %ds = %.3f%% of one core; rss_start=%d kB rss_end=%d kB hwm=%d kB threads=%d\n\", l, b-a, s, (b-a)/t/s*100, r0, r1, h, th}"
}
if [ "$MODE" = vnext ]; then
  echo "== Flow workflow run latency (ms; RunNow until the WorkflowCompleted signal; the action is clipboard.copy)"
  start_daemon lat NIRO_FLOW_ENABLED=1
  mkdir -p "$WFDIR"
  FN=60
  for i in $(seq 0 $((FN + 2))); do
    WFJ="{\"version\":1,\"id\":\"perf-copy-$i\",\"name\":\"perf-copy-$i\",\"trigger\":{\"type\":\"manual\"},\"allow\":[\"clipboard.copy\"],\"steps\":[{\"kind\":\"action\",\"id\":\"s1\",\"name\":\"clipboard.copy\",\"args\":{\"text\":\"niro-perf-wf-$i\"},\"next\":null}]}"
    gdbus call $D --method org.niro.Flow1.Save "$Q$WFJ$Q" >/dev/null
  done
  gdbus call $D --method org.niro.Flow1.List | grep -o "perf-copy-[0-9]*" | sort -u | wc -l | sed "s/^/workflows saved: /"
  gjs -m "$CLIENT" flowrun perf-copy $FN
  gdbus call $D --method org.niro.Flow1.History "" | grep -o "\"status\":\"[a-z]*\"" | sort | uniq -c | tr "\n" " " | sed "s/^/history statuses: /"; echo
  stop_daemon
fi
echo "== daemon idle (isolated HOME, private bus, Search loaded in the nested shell)"
for r in $(seq $ROUNDS); do
  if [ "$MODE" = baseline ]; then
    rm -rf "$WORK/config/niro"; start_daemon base; sample "baseline-1.5.9 round $r"; stop_daemon
  else
    rm -rf "$WORK/config/niro"; start_daemon off; sample "vnext flow-off round $r"; stop_daemon
    start_daemon on NIRO_FLOW_ENABLED=1; sample "vnext flow-on, 0 workflows r$r"; stop_daemon
    mkdir -p "$WFDIR"; echo "{\"version\":1,\"id\":\"perf-sched\",\"name\":\"perf-sched\",\"trigger\":{\"type\":\"schedule\",\"at\":\"03:00\"},\"allow\":[\"clipboard.copy\"],\"steps\":[{\"kind\":\"action\",\"id\":\"s1\",\"name\":\"clipboard.copy\",\"args\":{\"text\":\"x\"},\"next\":null}]}" > "$WFDIR/perf-sched.json"
    start_daemon sched NIRO_FLOW_ENABLED=1; sample "vnext flow-on, 1 schedule wf r$r"; stop_daemon
    rm -rf "$WORK/config/niro"
  fi
done
echo "JS ERROR lines in the shell log: $(grep -c "JS ERROR" "$WORK/shell.log")"; grep -A2 "JS ERROR" "$WORK/shell.log" | head -8
kill $SP; wait $SP 2>/dev/null' 2>&1 | grep -vE "^(dbus-daemon|Gdk-Message|\(|$|A connection)"
