#!/bin/bash
# Cost of the window effects, in private headless shells (one fresh shell and display name per run) with six GTK 4 windows open:
#   legacy   the installed extension with the old whole-window fade (applications opacity 80%)
#   engine   this repository's extension, per-application rules, no fade by default, blur radius 30
#   heavy    the same with blur radius 100
#   safe     the same with safe mode on (no blur, no fade)
#   none     no blur extension at all (the floor)
# Per run: idle shell CPU, RSS/PSS, frames painted while idle, and frame intervals while one window is moved continuously for
# MOTION seconds (median and p95 of the interval between painted frames, and frames per second). Every run is kept, failed ones too
# (with the reason), together with the machine load at its start and end; summary.md gives median and p95 over the completed runs.
#   REPS=5 scripts/benchmark-appearance.sh [outdir]
# Not measured: GPU load, battery, several monitors, video, screen sharing, high-resolution displays, application start-up.
set -u
cd "$(dirname "$0")/.."
REPS=${REPS:-5}; WINDOW=${WINDOW:-20}; MOTION=${MOTION:-6}; N=${N:-6}
OUTDIR=$(readlink -f "${1:-reports/performance/appearance-$(date +%Y%m%d-%H%M%S)}"); mkdir -p "$OUTDIR"
WORK=$(mktemp -d); trap 'rm -rf "$WORK"' EXIT
SHARE="$WORK/share"; mkdir -p "$SHARE/gnome-shell/extensions"
for e in "$HOME"/.local/share/*; do [ "$(basename "$e")" = gnome-shell ] || ln -s "$e" "$SHARE/$(basename "$e")"; done
cp -r /usr/share/gnome-shell/extensions/blur@niro.local "$SHARE/gnome-shell/extensions/"; chmod -R u+w "$SHARE/gnome-shell/extensions/blur@niro.local"
cp shell/blur/components/applications/index.js "$SHARE/gnome-shell/extensions/blur@niro.local/components/applications/index.js"
SCHEMAS="$WORK/schemas"; mkdir "$SCHEMAS"; cp control/org.niro.control.gschema.xml "$SCHEMAS/"; glib-compile-schemas "$SCHEMAS"
RAW="$OUTDIR/runs.tsv"; printf 'variant\trep\tstatus\tload_start\tload_end\tcpu_idle_percent\tframes_idle\trss_mb\tpss_mb\tframe_median_ms\tframe_p95_ms\tfps_motion\tnote\n' > "$RAW"
load() { cut -d' ' -f1 /proc/loadavg; }
variant() { # name rep repo(1/0) ext(1/0) sigma opacity niro-js
  local name=$1 rep=$2 repo=$3 ext=$4 sigma=$5 opacity=$6 js=$7 L0 L1
  local data="$HOME/.local/share"; [ "$repo" = 1 ] && data="$SHARE"
  local disp="niro-bm-$name-$rep-$$" log="$WORK/shell-$name-$rep.log" res="$WORK/res-$name-$rep.txt"; rm -f "$res"
  L0=$(load)
  timeout 240 dbus-run-session -- env XDG_DATA_HOME="$data" GSETTINGS_BACKEND=memory GSETTINGS_SCHEMA_DIR="$SCHEMAS" bash -c '
  gnome-shell --headless --wayland --no-x11 --unsafe-mode --wayland-display='"$disp"' --virtual-monitor 1280x720 > '"$log"' 2>&1 & SP=$!
  sleep 20
  ev() { gdbus call --session --dest org.gnome.Shell --object-path /org/gnome/Shell --method org.gnome.Shell.Eval "$1" 2>&1; }
  if [ '"$ext"' = 1 ]; then
    ev "Main.extensionManager.enableExtension(\"blur@niro.local\"); 1" > /dev/null; sleep 4
    ev "(function(){ const G=imports.gi.Gio; const src=G.SettingsSchemaSource.new_from_directory(\"'"$SHARE"'/gnome-shell/extensions/blur@niro.local/schemas\", G.SettingsSchemaSource.get_default(), false); const s=new G.Settings({settings_schema: src.lookup(\"org.gnome.shell.extensions.blur-my-shell.applications\", false)}); s.set_boolean(\"blur\", true); s.set_boolean(\"enable-all\", true); s.set_strv(\"blacklist\", []); s.set_boolean(\"dynamic-opacity\", false); s.set_int(\"opacity\", '"$opacity"'); s.set_int(\"sigma\", '"$sigma"'); return 1; })()" > /dev/null
  fi
  ev "'"$js"'" > /dev/null
  APP="imports.gi.versions.Gtk=\"4.0\"; const {Gtk,GLib}=imports.gi; Gtk.init(); const a=new Gtk.Application({application_id: ARGV[0]}); a.connect(\"activate\",()=>{ const w=new Gtk.ApplicationWindow({application:a, title: ARGV[0]}); w.set_child(new Gtk.Label({label: ARGV[0]})); w.present(); }); a.run([]);"
  for i in $(seq 1 '"$N"'); do (WAYLAND_DISPLAY='"$disp"' GDK_BACKEND=wayland gjs -c "$APP" org.niro.Bench$i >/dev/null 2>&1 & echo $! >> '"$WORK"'/pids-'"$name"'-'"$rep"'); sleep 1.5; done
  sleep 3; ev "Main.overview.hide(); 1" > /dev/null; sleep 3
  ev "global.__paints = 0; global.__stamps = []; global.stage.connect(\"after-paint\", () => { global.__paints++; if (global.__rec) global.__stamps.push(imports.gi.GLib.get_monotonic_time()); }); 1" > /dev/null
  ticks() { awk "{print \$14+\$15}" /proc/$SP/stat 2>/dev/null; }
  t=$(ticks); sleep '"$WINDOW"'; d=$(( $(ticks) - t ))
  paints=$(ev "global.__paints" | grep -oE "[0-9]+" | tail -1)
  mem=$(awk "/^(Rss|Pss):/{printf \"%s=%.0f \", \$1, \$2/1024}" /proc/$SP/smaps_rollup)
  # frame intervals while one window moves continuously (every repaint of it re-renders what is behind it)
  ev "(function(){ const G=imports.gi.GLib; const a=global.get_window_actors()[0]; global.__rec=true; let i=0; global.__mv=G.timeout_add(G.PRIORITY_DEFAULT, 16, () => { a.translation_x = (i++ % 160); return true; }); return 1; })()" > /dev/null
  sleep '"$MOTION"'
  ev "global.__rec=false; imports.gi.GLib.source_remove(global.__mv); 1" > /dev/null
  stamps=$(ev "global.__stamps.join(\",\")" | grep -oE "[0-9,]+" | tail -1)
  echo "cpu=$(awk "BEGIN{printf \"%.2f\", $d/100/'"$WINDOW"'*100}") idle_frames=$paints $mem" > '"$res"'
  echo "$stamps" > '"$res"'.stamps
  kill $(cat '"$WORK"'/pids-'"$name"'-'"$rep"') 2>/dev/null; kill $SP' > /dev/null 2>&1
  L1=$(load)
  if [ -s "$res" ] && grep -q "Pss" "$res"; then
    python3 - "$name" "$rep" "$L0" "$L1" "$res" "$MOTION" >> "$RAW" <<'P'
import sys, statistics
name, rep, l0, l1, res, motion = sys.argv[1:7]
d = dict(p.split('=') for p in open(res).read().split() if '=' in p)
stamps = [int(x) for x in open(res + '.stamps').read().strip().split(',') if x.isdigit()]
iv = sorted((b - a) / 1000 for a, b in zip(stamps, stamps[1:]))
med = round(statistics.median(iv), 2) if iv else ''
p95 = round(iv[min(len(iv) - 1, int(0.95 * len(iv)))], 2) if iv else ''
fps = round(len(stamps) / float(motion), 1)
print('\t'.join([name, rep, 'ok', l0, l1, d.get('cpu', ''), d.get('idle_frames', ''), d.get('Rss:', ''), d.get('Pss:', ''), str(med), str(p95), str(fps), '']))
P
  else
    printf '%s\t%s\tFAILED\t%s\t%s\t\t\t\t\t\t\t\t%s\n' "$name" "$rep" "$L0" "$L1" "$(grep -iE "error|segfault|abort" "$log" | head -1 | cut -c1-120)" >> "$RAW"
    cp "$log" "$OUTDIR/failed-$name-$rep.log" 2>/dev/null
  fi
}
for rep in $(seq 1 "$REPS"); do
  variant legacy $rep 0 1 30 204 "1"
  variant engine $rep 1 1 30 255 "1"
  variant heavy $rep 1 1 100 255 "1"
  variant safe $rep 1 1 30 255 "new imports.gi.Gio.Settings({schema_id:\"org.niro.control\"}).set_boolean(\"safe-mode\", true); 1"
  variant none $rep 0 0 30 255 "1"
done
python3 - "$RAW" "$OUTDIR" <<'P'
import csv, sys, statistics
rows = list(csv.DictReader(open(sys.argv[1]), delimiter='\t'))
def stats(xs):
    xs = sorted(float(x) for x in xs if x not in ('', None))
    if not xs: return 'n/a'
    return f"{statistics.median(xs):.2f} / {xs[min(len(xs)-1, int(0.95*len(xs)))]:.2f} (n={len(xs)})"
out = ['# Window effects: runs and summary', '', f"Machine load average at the start of each run is in runs.tsv (columns load_start, load_end). Failed runs are listed, not dropped.", '',
       '| Variant | ok / runs | idle CPU % median / p95 | PSS MB | frame interval ms median / p95 (during motion) | fps in motion |', '|---|---|---|---|---|---|']
for v in ['legacy', 'engine', 'heavy', 'safe', 'none']:
    rs = [r for r in rows if r['variant'] == v]; ok = [r for r in rs if r['status'] == 'ok']
    out.append(f"| {v} | {len(ok)} / {len(rs)} | {stats([r['cpu_idle_percent'] for r in ok])} | {stats([r['pss_mb'] for r in ok])} | {stats([r['frame_median_ms'] for r in ok])} median-of-medians; p95s {stats([r['frame_p95_ms'] for r in ok])} | {stats([r['fps_motion'] for r in ok])} |")
fails = [r for r in rows if r['status'] != 'ok']
out += ['', f"Failed runs: {len(fails)}" + ''.join(f"\n- {r['variant']} #{r['rep']}: {r['note'] or 'no reason found in the log'}" for r in fails)]
loads = [float(r['load_start']) for r in rows if r['load_start']]
out += ['', f"Load average at start of runs: median {statistics.median(loads):.2f}, max {max(loads):.2f}." if loads else '']
open(sys.argv[2] + '/summary.md', 'w').write('\n'.join(out) + '\n')
print('\n'.join(out))
P
