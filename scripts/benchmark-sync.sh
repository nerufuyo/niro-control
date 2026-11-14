#!/bin/bash
# Appearance-change latency and memory growth of NiroSync (the Shell and GTK stylesheets), in a private headless shell:
#   latency   time from changing the Look opacity to the GTK and Shell stylesheet files being rewritten (20 changes; the rewrites
#             are deliberately debounced, so about a third of a second is by design)
#   growth    shell PSS before and after 200 changes spaced out the same way, with a garbage collection before each reading
# Every run is kept with the machine load. Usage: REPS=3 scripts/benchmark-sync.sh [outdir]
set -u
cd "$(dirname "$0")/.."
REPS=${REPS:-3}
OUTDIR=$(readlink -f "${1:-reports/performance/sync-$(date +%Y%m%d-%H%M%S)}"); mkdir -p "$OUTDIR"
RAW="$OUTDIR/runs.tsv"; printf 'rep\tstatus\tload_start\tload_end\tgtk_ms_median\tgtk_ms_p95\tshell_ms_median\tshell_ms_p95\tpss_before_mb\tpss_after_mb\tnote\n' > "$RAW"
for rep in $(seq 1 "$REPS"); do
  WORK=$(mktemp -d)
  EXTS="$WORK/share/gnome-shell/extensions"; mkdir -p "$EXTS" "$WORK/config"
  for e in "$HOME"/.local/share/*; do [ "$(basename "$e")" = gnome-shell ] || ln -s "$e" "$WORK/share/$(basename "$e")"; done
  for u in island blur; do cp -r /usr/share/gnome-shell/extensions/$u@niro.local "$EXTS/"; chmod -R u+w "$EXTS/$u@niro.local"; done
  cp shell/island/build/src/{niroSync,appearance,appearanceTokens,gtkAdapter,shellTheme}.js "$EXTS/island@niro.local/src/"
  SCHEMAS="$WORK/schemas"; mkdir "$SCHEMAS"; cp control/org.niro.control.gschema.xml "$SCHEMAS/"; glib-compile-schemas "$SCHEMAS"
  cat > "$WORK/install.js" <<J
import {install} from 'file://$PWD/control/build/gtkAdapter.js';
install({configDir: '$WORK/config', backupRoot: '$WORK/backups', consent: true, scheme: 'dark', glass: 80, tint: '#1C1C1E', surfaces: {sidebar: 70, content: 85, elevated: 92}});
J
  gjs -m "$WORK/install.js"
  echo dark > "$WORK/gtk3-answer"; cat > "$WORK/probe.js" <<J
import GLib from 'gi://GLib';
print(new TextDecoder().decode(GLib.file_get_contents('$WORK/gtk3-answer')[1]).trim());
J
  L0=$(cut -d' ' -f1 /proc/loadavg); OUT="$WORK/out.txt"; : > "$OUT"
  timeout 300 dbus-run-session -- env NIRO_GTK3_PROBE="$WORK/probe.js" XDG_DATA_HOME="$WORK/share" XDG_CONFIG_HOME="$WORK/config" XDG_CACHE_HOME="$WORK/cache" GSETTINGS_BACKEND=memory GSETTINGS_SCHEMA_DIR="$SCHEMAS" bash -c '
  gnome-shell --headless --wayland --no-x11 --unsafe-mode --wayland-display=niro-sy-'"$rep"'-$$ --virtual-monitor 1280x720 > '"$WORK"'/shell.log 2>&1 & SP=$!
  sleep 20
  ev() { gdbus call --session --dest org.gnome.Shell --object-path /org/gnome/Shell --method org.gnome.Shell.Eval "$1" 2>&1; }
  EXT="'"$EXTS"'"
  ev "import(\"file://$EXT/island@niro.local/src/niroSync.js\").then(m => { const G=imports.gi.Gio; const src=G.SettingsSchemaSource.new_from_directory(\"$EXT/island@niro.local/schemas\", G.SettingsSchemaSource.get_default(), false); global.__N = new G.Settings({schema_id: \"org.niro.control\"}); global.__N.set_boolean(\"shell-surfaces\", true); global.__ns = new m.NiroSync(new G.Settings({settings_schema: src.lookup(\"org.gnome.shell.extensions.island\", false)})); }); 1" > /dev/null
  sleep 4
  pss() { awk "/^Pss:/{printf \"%.1f\", \$2/1024}" /proc/$SP/smaps_rollup; }
  GTKF="'"$WORK"'/config/gtk-4.0/niro-glass.css"; SHF="'"$WORK"'/cache/niro/shell-appearance.css"
  ev "(function(){ const G=imports.gi.GLib, Gio=imports.gi.Gio; const mt=p=>{ try { const i=Gio.File.new_for_path(p).query_info(\"time::modified,time::modified-usec\",0,null); return i.get_attribute_uint64(\"time::modified\")*1e6+i.get_attribute_uint32(\"time::modified-usec\"); } catch(e) { return 0; } };
    global.__g=[]; global.__s=[]; let n=0;
    const step=()=>{ if (n>=20) { global.__done=true; return; } n++; const t0=G.get_monotonic_time(), g0=mt(\"$GTKF\"), s0=mt(\"$SHF\"); let gd=false, sd=false;
      global.__N.set_int(\"content-opacity\", n%2 ? 75 : 90);
      const poll=G.timeout_add(G.PRIORITY_DEFAULT, 5, () => { const t=(G.get_monotonic_time()-t0)/1000;
        if (!gd && mt(\"$GTKF\")!==g0) { gd=true; global.__g.push(t); } if (!sd && mt(\"$SHF\")!==s0) { sd=true; global.__s.push(t); }
        if ((gd && sd) || t>3000) { G.timeout_add(G.PRIORITY_DEFAULT, 400, () => { step(); return false; }); return false; } return true; }); };
    step(); return 1; })()" > /dev/null
  for i in $(seq 1 40); do [ "$(ev "global.__done === true" | grep -c true)" = 2 ] && break; sleep 1; done
  echo "GTK $(ev "global.__g.join(\",\")" | grep -oE "[0-9.,]+" | tail -1)" >> '"$OUT"'
  echo "SHELL $(ev "global.__s.join(\",\")" | grep -oE "[0-9.,]+" | tail -1)" >> '"$OUT"'
  ev "imports.system.gc(); 1" > /dev/null; sleep 2; echo "PSS0 $(pss)" >> '"$OUT"'
  ev "(function(){ const G=imports.gi.GLib; let n=0; global.__grow=false; G.timeout_add(G.PRIORITY_DEFAULT, 450, () => { global.__N.set_int(\"content-opacity\", n%2 ? 75 : 90); if (++n >= 200) { global.__grow=true; return false; } return true; }); return 1; })()" > /dev/null
  for i in $(seq 1 150); do [ "$(ev "global.__grow" | grep -c true)" = 1 ] && break; sleep 1; done
  sleep 2; ev "imports.system.gc(); 1" > /dev/null; sleep 2; echo "PSS1 $(pss)" >> '"$OUT"'
  kill $SP' > /dev/null 2>&1
  L1=$(cut -d' ' -f1 /proc/loadavg)
  python3 - "$rep" "$L0" "$L1" "$OUT" >> "$RAW" <<'P'
import sys, statistics
rep, l0, l1, path = sys.argv[1:5]
d = {l.split(' ', 1)[0]: (l.split(' ', 1)[1].strip() if ' ' in l else '') for l in open(path).read().splitlines()}
def st(s):
    xs = sorted(float(x) for x in s.split(',') if x)
    return (round(statistics.median(xs), 1), round(xs[min(len(xs) - 1, int(0.95 * len(xs)))], 1)) if xs else ('', '')
g, s = st(d.get('GTK', '')), st(d.get('SHELL', ''))
ok = g[0] != '' and d.get('PSS0') and d.get('PSS1')
print('\t'.join([rep, 'ok' if ok else 'FAILED', l0, l1, str(g[0]), str(g[1]), str(s[0]), str(s[1]), d.get('PSS0', ''), d.get('PSS1', ''), '' if ok else 'incomplete: ' + str(d)[:100]]))
P
  rm -rf "$WORK"
done
cat "$RAW"
