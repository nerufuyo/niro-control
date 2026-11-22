# Two virtual monitors (MONITORS="1920x1080 1280x720"): the dock's edge zone must stay on its own monitor. Real virtual-pointer events.
# Sourced by dock-session.sh.
HERE_STEPS=$(dirname "$STEPS")
T="global.__t"
E() { ev "$1"; }
J() { E "JSON.stringify($1)"; }
sleep 4
E "eval(imports.byteArray.toString(imports.gi.Gio.File.new_for_path('$HERE_STEPS/dock-helper.js').load_contents(null)[1]))" > /dev/null
E "$T.out = '$OUT'; $T.patch(); 1" > /dev/null
M 500 500; sleep .3; M 500 500; sleep .3; E "Main.overview.hide(); 1" > /dev/null; sleep 1.5
echo "== MONITORS: $(J "Main.layoutManager.monitors.map(m => [m.index, m.x, m.y, m.width, m.height].join(':'))") primary=$(E "Main.layoutManager.primaryIndex")"
echo "  edge activator: $(J "(function(){ const a = $T.vis()._edgeActivator; return [a.x, a.y, a.width, a.height].join(',') })()")"
echo "  dock actor: $(J "(function(){ const b = $T.box(); return [b.x, b.y, b.width, b.height].join(',') })()")"
H1=$(E "Main.layoutManager.monitors[0].height"); W1=$(E "Main.layoutManager.monitors[0].width")
H2=$(E "Main.layoutManager.monitors[1].height"); X2=$(E "Main.layoutManager.monitors[1].x"); W2=$(E "Main.layoutManager.monitors[1].width"); Y2=$(E "Main.layoutManager.monitors[1].y")
shot mm01-hidden
probe() { # label x y: move there (real event), wait, report the dock state and where the pointer is
  M $2 $3; sleep .5
  echo "  $1 pointer=$(E "$T.pointer()") -> $(J "$T.snap()")"
}
echo "== POINTER ON MONITOR 2 (must not bring the dock)"
E "$T.reset(); 1" > /dev/null
probe "mon2 bottom edge d=4 at x=2300" $((X2 + 380)) $((Y2 + H2 - 4))
probe "mon2 bottom edge d=1 at x=$((X2 + 20))" $((X2 + 20)) $((Y2 + H2 - 1))
probe "mon2 left edge, 30 px above its bottom" $((X2 + 1)) $((Y2 + H2 - 30))
echo "  state events so far: $(J "$T.log.map(l => l.e)")"
shot mm02-pointer-on-mon2
echo "== POINTER ON MONITOR 1"
probe "mon1 bottom edge d=4, x=100" 100 $((H1 - 4))
shot mm03-mon1-edge
echo "  state events: $(J "$T.log.map(l => l.e)")"
echo "== HYSTERESIS ACROSS THE MONITOR BORDER (the pointer slides along mon1's bottom edge towards, and into the dead space beside, mon2)"
for x in $((W1 - 60)) $((W1 - 10)) $((W1 - 1)) $((W1 + 1)) $((W1 + 10)) $((W1 + 60)); do
  M $x $((H1 - 4)); sleep .35
  echo "  moved to x=$x y=$((H1 - 4)): pointer=$(E "$T.pointer()") -> $(J "$T.snap()")"
done
sleep 1
echo "  after resting on mon2: $(J "$T.snap()") events=$(J "$T.log.map(l => l.e)")"
shot mm04-after-border
echo "== EDGE ZONE BOUNDS: pointer at mon1's right end, last column and row"
M $((W1 - 1)) $((H1 - 1)); sleep .6; echo "  (W1-1, H1-1) $(J "$T.snap()")"
echo "== DISABLE/ENABLE x5 with two monitors"
for i in 1 2 3 4 5; do
  E "Main.extensionManager.disableExtension('dock@niro.local'); 1" > /dev/null; sleep 1.2
  E "Main.extensionManager.enableExtension('dock@niro.local'); 1" > /dev/null; sleep 2.5
  echo "  cycle $i: state=$(E "Main.extensionManager.lookup('dock@niro.local').state")"
done
echo "== SHELL LOG: $(grep -ciE 'already disposed|JS ERROR|Exception|TypeError|CRITICAL|WARNING' "$WORK/shell.log") error/warning lines"
grep -iE 'already disposed|JS ERROR|Exception|TypeError|CRITICAL|WARNING' "$WORK/shell.log" | sed -E 's/[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]+//; s/gnome-shell:[0-9]+//' | sort | uniq -c | sort -rn | head -8
