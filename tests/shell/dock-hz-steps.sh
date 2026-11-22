# Frame pacing of the dock's reveal and of a pointer sweep at the monitor's refresh rate (MONITORS="1920x1080@120" for 120 Hz).
# Sourced by dock-session.sh. Real virtual-pointer events.
HERE_STEPS=$(dirname "$STEPS")
T="global.__t"
E() { ev "$1"; }
J() { E "JSON.stringify($1)"; }
sleep 4
E "eval(imports.byteArray.toString(imports.gi.Gio.File.new_for_path('$HERE_STEPS/dock-helper.js').load_contents(null)[1]))" > /dev/null
E "$T.out = '$OUT'; $T.patch(); 1" > /dev/null
M 500 500; sleep .3; M 500 500; sleep .3; E "Main.overview.hide(); 1" > /dev/null; sleep 1.5
echo "== MODE: $(gdbus call --session --dest org.gnome.Mutter.DisplayConfig --object-path /org/gnome/Mutter/DisplayConfig --method org.gnome.Mutter.DisplayConfig.GetCurrentState 2>&1 | grep -oE "'[0-9]+x[0-9]+@[0-9.]+'" | sort -u | tr '\n' ' ')"
MON_H=$(E "Main.layoutManager.primaryMonitor.height")
GEOM=$(E "(function(){const g=$T.geom(); return [g.bx,g.by,g.bw,g.bh].join(' ')})()"); read BX BY BW BH <<< "$GEOM"
YB=$((BY + BH / 2))
E "$T.reset(); $T.sampling(true); $T.mark = $T.now(); $T.move(100, $MON_H - 10); 1" > /dev/null; sleep 1.2
E "$T.sampling(false); 1" > /dev/null
echo "== REVEAL: $(J "$T.log.map(l => ({e: l.e, ms: Math.round(l.t - $T.mark)}))") frames=$(J "$T.frameStats($T.mark, $T.mark + 700)") samples during slide=$(E "$T.samples.filter(s => s[0] <= $T.mark + 300).length")"
shot hz01-revealed
M $((BX + BW / 2)) $YB; sleep 1
E "$T.reset(); $T.sampling(true); $T.gapSampling(true); $T.mark = $T.now(); $T.sweep($BX + 10, $BX + $BW - 10, $YB, 600, 4); 1" > /dev/null; sleep 2.7
E "$T.sampling(false); $T.gapSampling(false); 1" > /dev/null
echo "== SWEEP: events=$(E "$T.sweepEvents") frames=$(J "$T.frameStats($T.mark, $T.now())") gap=$(J "$T.gap") state events=$(J "$T.log.map(l => l.e)")"
shot hz02-after-sweep
echo "== SHELL LOG: $(grep -ciE 'already disposed|JS ERROR|Exception|TypeError|CRITICAL' "$WORK/shell.log") error lines"
