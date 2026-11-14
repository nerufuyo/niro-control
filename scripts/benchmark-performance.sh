#!/bin/bash
# Niro Control performance benchmark. Reproducible, read-only against your real settings.
#   scripts/benchmark-performance.sh [--cold] [--quick]
#     --cold   drop the page cache first (needs passwordless sudo) so the first panel start is really cold
#     --quick  fewer samples (smoke run)
# Two kinds of numbers, reported separately:
#   isolated  a private headless GNOME Shell (own D-Bus session, own Wayland display) with the installed Niro extensions, and a
#             second one without them (memory settings backend = stock defaults); the panel and the profile engine run against a
#             throw-away settings backend. Nothing here touches your session or your dconf.
#   real      read-only samples of your running gnome-shell (/proc, journal). No interaction is driven in it.
# Output: reports/performance/<date>-<commit>.{json,md}. Anything that could not be measured is marked unavailable.
set -u
cd "$(dirname "$0")/.."
COLD=0; N=30; WARM=6; IDLE=20
for a in "$@"; do case $a in --cold) COLD=1;; --quick) N=8; WARM=2; IDLE=6;; esac; done
STAMP=$(date +%Y%m%d-%H%M%S); COMMIT=$(git rev-parse --short HEAD 2>/dev/null || echo nogit)
RAW=$(mktemp -d); trap 'rm -rf "$RAW"' EXIT
mkdir -p reports/performance
SCHEMAS="$RAW/schemas"; mkdir "$SCHEMAS"
for d in control shell/island/schemas shell/dock/schemas shell/blur/schemas shell/corners/schemas; do cp $d/*.gschema.xml "$SCHEMAS/"; done
glib-compile-schemas "$SCHEMAS"
ISO="GSETTINGS_BACKEND=memory GSETTINGS_SCHEMA_DIR=$SCHEMAS NIRO_SCHEMA_DIR=$SCHEMAS"

{ echo "date: $(date -Is)"; echo "commit: $COMMIT"; echo "package: $(dpkg-query -W -f='${Version}' niro-control 2>/dev/null)"
  echo "kernel: $(uname -r)"; echo "cpu: $(grep -m1 'model name' /proc/cpuinfo | cut -d: -f2- | xargs) x$(nproc)"
  echo "memory_mb: $(awk '/MemTotal/{print int($2/1024)}' /proc/meminfo)"; echo "gnome-shell: $(gnome-shell --version)"; echo "gjs: $(gjs --version)"
  echo "load_at_start: $(cut -d' ' -f1-3 /proc/loadavg)"; echo "power: $(cat /sys/class/power_supply/*/online 2>/dev/null | tr '\n' ' ')"; } > "$RAW/system.txt"

# ---- isolated: profile engine
env $ISO NIRO_BENCH_N=$N gjs -m tests/bench/profiles.js > "$RAW/profiles.json" 2> "$RAW/profiles.err" || echo '{}' > "$RAW/profiles.json"

# ---- isolated: one headless GNOME Shell; $1 = on (installed Niro extensions, real dconf read-only) or off (stock defaults)
shell_session() {
  local mode=$1 backend=""; [ "$mode" = off ] && backend="GSETTINGS_BACKEND=memory"
  local samples=$N idle=$IDLE warm=$WARM
  timeout 600 dbus-run-session -- env $backend bash -c '
    gnome-shell --headless --wayland --no-x11 --unsafe-mode --wayland-display=niro-bench --virtual-monitor 1280x720 > '"$RAW/shell-$mode.log"' 2>&1 & SP=$!
    sleep 25
    mem() { awk "/^(Rss|Pss):/{printf \"%s=%.1f \", \$1, \$2/1024}" /proc/$SP/smaps_rollup; }
    ticks() { awk "{print \$14+\$15}" /proc/$SP/stat; }
    out='"$RAW/session-$mode.txt"'
    echo "settled_mem $(mem)" > $out
    echo "extensions $(for e in island dock search blur corners emoji emulator; do echo -n "$e=$(gnome-extensions info $e@niro.local 2>&1 | grep State | tr -d " ") "; done)" >> $out
    echo "errors $(grep -ciE "error|exception" '"$RAW/shell-$mode.log"')" >> $out
    t=$(ticks); sleep '"$idle"'; echo "idle_cpu_ticks $(( $(ticks) - t )) over '"$idle"'s" >> $out
    echo "idle_mem $(mem)" >> $out
    if [ '"$mode"' = on ]; then
      ev() { gdbus call --session --dest org.gnome.Shell --object-path /org/gnome/Shell --method org.gnome.Shell.Eval "$1" 2>&1; }
      O="Main.extensionManager.lookup(\"search@niro.local\").stateObj"
      ev "(function(){ const G=imports.gi.GLib, O=$O, now=()=>G.get_monotonic_time()/1000, N='"$samples"'|0, r={};
        const run=(k,f)=>{ r[k]=[]; for(let i=0;i<N;i++){ const a=now(); f(); r[k].push((now()-a).toFixed(3)); O._entry.set_text(\"\"); } };
        run(\"activation\", ()=>{ O._open(); }); O._close();
        O._open();
        for (const [k,q] of [[\"calculator\",\"2*pi+17\"],[\"conversion\",\"20 gb to mb\"],[\"apps\",\"firefox\"],[\"settings\",\"dock position\"],[\"profiles\",\"gaming\"],[\"mixed\",\"set\"],[\"no_match\",\"qqqzzzxx\"]]) run(k, ()=>O._entry.set_text(q));
        O._close();
        return Object.entries(r).map(([k,v])=>k+\":\"+v.join(\",\")).join(\";\"); })()" | sed "s/^/SEARCH /" >> $out
      echo "growth_0 $(mem)" >> $out
      for round in 1 2 3; do
        ev "(function(){ const O=$O; for(let i=0;i<300;i++){ O._open(); O._entry.set_text(i%2?\"dock\":\"2+2\"); O._close(); } return \"done\"; })()" > /dev/null
        sleep 3; ev "imports.system.gc()" > /dev/null; sleep 2; echo "growth_$round $(mem)" >> $out
      done
      # the panel, on this shell'"'"'s display, against throw-away settings
      for i in $(seq 1 '"$warm"'); do
        env '"$ISO"' WAYLAND_DISPLAY=niro-bench GDK_BACKEND=wayland NIRO_NOBANNER=1 NIRO_BENCH_IDLE=6 NIRO_BENCH_T0=$(date +%s%3N) gjs -m tests/bench/panel.js 2>/dev/null | tail -1 | sed "s/^/PANEL /" >> $out
      done
    fi
    kill $SP; wait $SP 2>/dev/null' > /dev/null 2>&1
}

# the cold panel start: the first launch after (optionally) dropping the page cache, in its own shell so nothing is warm
if [ $COLD = 1 ]; then sudo -n sh -c 'sync; echo 3 > /proc/sys/vm/drop_caches' 2>/dev/null && echo "cache dropped" > "$RAW/cold.txt" || echo "could not drop caches" > "$RAW/cold.txt"; else echo "page cache not dropped: the first sample is first-run, not guaranteed cold" > "$RAW/cold.txt"; fi
shell_session on
shell_session off

# ---- real session: read-only
PID=$(pgrep -xo gnome-shell || true)
if [ -n "$PID" ]; then
  tk() { awk '{print $14+$15}' /proc/$PID/stat; }
  { echo "pid $PID"; echo "mem $(awk '/^(Rss|Pss):/{printf "%s=%.1f ", $1, $2/1024}' /proc/$PID/smaps_rollup)"
    echo "threads $(awk '/^Threads/{print $2}' /proc/$PID/status)"
    c0=$(awk '/^voluntary_ctxt_switches/{print $2}' /proc/$PID/status); t0=$(tk); sleep $IDLE
    echo "idle_cpu_ticks $(( $(tk) - t0 )) over ${IDLE}s"
    echo "wakeups_per_s $(( ($(awk '/^voluntary_ctxt_switches/{print $2}' /proc/$PID/status) - c0) / IDLE ))"
    echo "mem_after $(awk '/^(Rss|Pss):/{printf "%s=%.1f ", $1, $2/1024}' /proc/$PID/smaps_rollup)"
    echo "journal_errors $(journalctl --user -b -q _COMM=gnome-shell --no-pager 2>/dev/null | grep -iE '@niro.local|niro' | grep -ciE 'error|exception')"
    true; } > "$RAW/real.txt"
fi
for p in island-daemon; do pid=$(pgrep -xo $p) && echo "daemon_mem $(awk '/^(Rss|Pss):/{printf "%s=%.1f ", $1, $2/1024}' /proc/$pid/smaps_rollup)" >> "$RAW/real.txt"; done

# ---- aggregate
python3 scripts/benchmark-report.py "$RAW" "reports/performance/$STAMP-$COMMIT" "$N" "$IDLE"
