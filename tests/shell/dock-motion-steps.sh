# Runtime checks of the dock's motion, driven by the compositor's virtual pointer (real stage events). Sourced by dock-session.sh.
# Results: lines on stdout, JSON and screenshots in $OUT. Anything marked SYNTHETIC is fed by calling the dock directly, not by input events.
HERE_STEPS=$(dirname "$STEPS")
T="global.__t"
E() { ev "$1"; }
J() { E "JSON.stringify($1)"; }
S() { E "$T.save('$1', $2)" > /dev/null; }
sleep 4
E "eval(imports.byteArray.toString(imports.gi.Gio.File.new_for_path('$HERE_STEPS/dock-helper.js').load_contents(null)[1]))" > /dev/null
E "$T.out = '$OUT'; $T.patch(); 1" > /dev/null
DS="Main.extensionManager.lookup('dock@niro.local').stateObj.getSettings()"
E "$DS.set_int('icon-size', 60); $DS.set_boolean('auto-hide', true); $DS.set_boolean('magnification-enabled', true); 1" > /dev/null
sleep 2
M 500 500; sleep .3; M 500 500; sleep .3
E "Main.overview.hide(); 1" > /dev/null; sleep 1.5
echo "== SETUP seat events real: pointer=$(E "$T.pointer()") state=$(J "$T.snap()")"
E "$T.save('geom-rest', $T.geom())" > /dev/null
GEOM=$(E "(function(){const g=$T.geom(); return [g.bx,g.by,g.bw,g.bh,g.kids.length].join(' ')})()"); echo "dock geometry (x y w h n): $GEOM"
read BX BY BW BH NK <<< "$GEOM"
MON_H=$(E "Main.layoutManager.primaryMonitor.height"); MON_W=$(E "Main.layoutManager.primaryMonitor.width")
echo "primary monitor ${MON_W}x${MON_H} hz=$(E "Main.layoutManager.primaryMonitor ? global.display.get_monitor_geometry(0).width : 0")"
shot m01-hidden

# ---- 1. edge activation (REAL pointer), outside the dock's own span so only the edge zone can act. enter distance = show-threshold 25 px
echo "== EDGE ACTIVATION x=100: distance to bottom edge -> state"
for d in 80 40 30 27 26 25 24; do
  y=$((MON_H - d)); M 100 $y; sleep .25
  echo "  d=$d y=$y -> $(J "$T.snap()")"
done
sleep .8; shot m02-revealed-by-edge

# ---- 2. hysteresis: oscillate across the enter boundary (d=27 outside, d=23 inside); leave threshold is deeper (37)
E "$T.reset(); 1" > /dev/null
for i in $(seq 1 25); do M 100 $((MON_H - 27)); M 100 $((MON_H - 23)); done
sleep .5
echo "== HYSTERESIS 50 crossings of the enter boundary: state=$(J "$T.snap()") events=$(J "$T.log.map(l => l.e)")"
M 100 $((MON_H - 35)); sleep .6
echo "  d=35 (inside leave 37): $(J "$T.snap()") events=$(J "$T.log.map(l => l.e)")"

# ---- 3. auto-hide delay: leave to d=60; time from the motion to the dismiss
E "$T.reset(); $T.mark = $T.now(); $T.move(100, $MON_H - 60); 1" > /dev/null; sleep 1.2
echo "== AUTO-HIDE: log=$(J "$T.log.map(l => ({e: l.e, ms: Math.round(l.t - $T.mark), to: l.to}))")"
echo "  after: $(J "$T.snap()")"
sleep .8

# ---- 4. reveal timing and overshoot, sampled on every painted frame
E "$T.reset(); $T.sampling(true); 1" > /dev/null
E "$T.mark = $T.now(); $T.move(100, $MON_H - 10); 1" > /dev/null; sleep 1.2
E "$T.sampling(false); 1" > /dev/null
S reveal-samples "{mark: $T.mark, log: $T.log, samples: $T.samples, frames: $T.frameStats($T.mark, $T.mark + 1000)}"
echo "== REVEAL: log=$(J "$T.log.map(l => ({e: l.e, ms: Math.round(l.t - $T.mark), to: l.to}))") minTy=$(E "Math.min(...$T.samples.map(s => s[1]))") (negative = overshoot above rest)"
shot m03-revealed

# ---- 5. cancelable dismissal: leave, then come back while it is sliding out (the spring turns around with its velocity)
E "$T.reset(); $T.sampling(true); $T.cancel = null;
   const id = imports.gi.GLib.timeout_add(0, 3, () => { const v = $T.vis(); if (v._state === 'dismissing' && v._slide.value < 0.85) { $T.cancel = {t: $T.now(), slide: v._slide.value, vel: v._slide.velocity}; $T.move(100, $MON_H - 12); return imports.gi.GLib.SOURCE_REMOVE; } return imports.gi.GLib.SOURCE_CONTINUE; });
   $T.mark = $T.now(); $T.move(100, $MON_H - 200); 1" > /dev/null
sleep 1.5
E "$T.sampling(false); 1" > /dev/null
S cancel-samples "{cancel: $T.cancel, log: $T.log, samples: $T.samples}"
echo "== CANCELABLE DISMISSAL: cancel=$(J "$T.cancel") events=$(J "$T.log.map(l => l.from + '>' + l.e + '>' + l.to)") final=$(J "$T.snap()")"
sleep .5; M 100 300; sleep 1; echo "  hidden again: $(J "$T.snap()")"

# ---- 6. magnification (REAL pointer over the dock): scales and displacement at several pointer positions
echo "== MAGNIFICATION"
YB=$((BY + BH / 2))
M $((BX + BW / 2)) $((MON_H - 12)); sleep 1.2
for k in $(seq 0 $((NK - 1))); do :; done
POS=$(E "(function(){const g=$T.geom(); return [g.kids[0].cx, g.kids[1].cx, (g.kids[1].cx+g.kids[2].cx)/2, g.kids[2].cx, g.kids[g.kids.length-2].cx, g.kids[g.kids.length-1].cx].map(x=>Math.round(x+g.bx)).join(' ')})()")
echo "  pointer x targets: $POS"
i=0
for x in $POS; do
  i=$((i+1)); M $x $YB; sleep 1.4
  S mag-$i "{pointer: $T.pointer(), geom: $T.geom(), snap: $T.snap(), minGap: $T.minGap()}"
  echo "  x=$x -> minGap=$(E "$T.minGap()") state=$(E "$T.vis()._state") maxScale=$(E "Math.max(...$T.geom().kids.map(k => k.s))")"
  shot m04-mag-$i
done
M $((BX + BW / 2)) 300; sleep 1.5
echo "  pointer away: state=$(E "$T.vis()._state") maxScale=$(E "Math.max(...$T.geom().kids.map(k => k.s))") translations=$(E "$T.geom().kids.map(k => k.tx).join(',')")"
M $((BX + BW / 2)) $((MON_H - 12)); sleep 1.2

# ---- 7. rapid pointer sweeps over the icons: frame times, flicker (events, opacity), overlap per painted frame
echo "== RAPID SWEEP (real events, ~125 Hz, 4 laps of 600 ms across the dock)"
E "$T.reset(); $T.sampling(true); $T.gapSampling(true); $T.mark = $T.now(); $T.sweep($BX + 10, $BX + $BW - 10, $YB, 600, 4); 1" > /dev/null
sleep 2.6
E "$T.sampling(false); $T.gapSampling(false); 1" > /dev/null
S sweep "{events: $T.sweepEvents, log: $T.log, gap: $T.gap, frames: $T.frameStats($T.mark, $T.now()), opacity: $T.samples.map(s => s[2]), states: $T.samples.map(s => s[3])}"
echo "  events=$(E "$T.sweepEvents") frames=$(J "$T.frameStats($T.mark, $T.now())") gap=$(J "$T.gap")"
echo "  state-machine events during sweep: $(J "$T.log.map(l => l.e)")"
echo "  opacity min during sweep (flicker if < 255): $(E "Math.min(...$T.samples.map(s => s[2]))")"
shot m05-after-sweep
echo "  sweep that leaves the dock at both ends (x from -40 to +40 px past it, 4 laps), then rests outside:"
E "$T.reset(); $T.mark = $T.now(); $T.sweep($BX - 40, $BX + $BW + 40, $YB, 600, 4); 1" > /dev/null; sleep 3.2
echo "    events=$(E "$T.sweepEvents") dismiss/reveal log=$(J "$T.log.filter(l => l.e === 'dismiss' || l.e === 'reveal').map(l => l.e + '@' + Math.round(l.t - $T.mark))")"
M $((BX + BW / 2)) $((MON_H - 12)); sleep 1
# sweep along the edge outside the dock: x from 20 to 1900 at d=10 (edge zone, no icons)
E "$T.reset(); $T.sweep(20, 1900, $MON_H - 10, 700, 2); 1" > /dev/null; sleep 1.8
echo "  edge sweep: events=$(E "$T.sweepEvents") log=$(J "$T.log.map(l => l.e)") state=$(E "$T.vis()._state")"
M 960 300; sleep 1.5

# ---- 8. launch feedback: click the Calculator icon with the virtual pointer (real click, real app)
echo "== LAUNCH (real click on the first icon, gnome-calculator)"
M $((BX + BW / 2)) $((MON_H - 12)); sleep 1.2
E "Main.overview.hide(); 1" > /dev/null
CX=$(E "(function(){const g=$T.geom(); const k = g.kids.find(k => k.name === 'dock-icon'); return Math.round(g.bx + k.x + k.w / 2)})()")
M $CX $YB; sleep 1.2
E "$T.reset(); $T.sampling(true); const a = $T.im().getIconActor(imports.gi.Shell.AppSystem.get_default().lookup_app('org.gnome.Calculator.desktop')); $T.watchBounce(a, 10, 2500); $T.click(); 1" > /dev/null
sleep .5; shot m06-launch-bounce; sleep 5
E "$T.sampling(false); 1" > /dev/null
S launch "{log: $T.log, bounce: $T.bounce}"
echo "  state seq: $(J "$T.log.map(l => l.to)")"
echo "  bounce min ty=$(E "Math.min(...$T.bounce.map(b => b[1]))") (about -28 expected) samples=$(E "$T.bounce.length") windows=$(E "global.get_window_actors().length") state now=$(E "$T.vis()._state")"
shot m07-after-launch

# ---- 9. urgent window: Calculator asks for attention while a second app has the focus
echo "== URGENT (window-demands-attention on an unfocused window; set from the shell side)"
E "imports.gi.Gio.AppInfo.create_from_commandline('gnome-text-editor', null, 0).launch([], null); 1" > /dev/null; sleep 6
echo "  windows: $(E "global.get_window_actors().map(a => a.meta_window.get_wm_class()).join(',')") focus=$(E "global.display.focus_window ? global.display.focus_window.get_wm_class() : 'none'")"
E "const win = global.get_window_actors().map(a => a.meta_window).find(w => (w.get_wm_class() || '').toLowerCase().includes('calc')); win.activate(global.get_current_time()); 1" > /dev/null; sleep 1.5
E "const ed = global.get_window_actors().map(a => a.meta_window).find(w => (w.get_wm_class() || '').toLowerCase().includes('editor')); ed.activate(global.get_current_time()); 1" > /dev/null; sleep 1.5
E "const a = $T.im().getIconActor(imports.gi.Shell.AppSystem.get_default().lookup_app('org.gnome.Calculator.desktop')); $T.watchBounce(a, 10, 1200); const win = global.get_window_actors().map(a => a.meta_window).find(w => (w.get_wm_class() || '').toLowerCase().includes('calc')); win.set_demands_attention(); 1" > /dev/null
sleep .4; shot m08-urgent; sleep 1.2
echo "  unfocused window demands attention: bounce min ty=$(E "Math.min(...$T.bounce.map(b => b[1]))")"
E "const a = $T.im().getIconActor(imports.gi.Shell.AppSystem.get_default().lookup_app('org.gnome.TextEditor.desktop')); $T.watchBounce(a, 10, 1200); const ed = global.get_window_actors().map(a => a.meta_window).find(w => (w.get_wm_class() || '').toLowerCase().includes('editor')); ed.set_demands_attention(); 1" > /dev/null
sleep 1.5; echo "  focused window demands attention (control, no bounce expected): min ty=$(E "Math.min(...$T.bounce.map(b => b[1]))")"

# ---- 10. fullscreen: the dock goes away, the edge brings it back
echo "== FULLSCREEN"
E "const ed = global.get_window_actors().map(a => a.meta_window).find(w => (w.get_wm_class() || '').toLowerCase().includes('editor')); ed.activate(global.get_current_time()); ed.make_fullscreen(); 1" > /dev/null
M 960 300; sleep 3
echo "  inFullscreen=$(E "Main.layoutManager.primaryMonitor.inFullscreen") fsForced=$(E "$T.dm()._fsForced") scanoutInhibited=$(E "$T.dm()._scanoutInhibited") dock=$(J "$T.snap()") chromeVisible=$(E "$T.box().visible")"
shot m09-fullscreen-away
E "$T.reset(); 1" > /dev/null; M 960 $((MON_H - 4)); sleep 1.2
echo "  pointer at the bottom edge: $(J "$T.snap()") events=$(J "$T.log.map(l => l.e)") scanoutInhibited=$(E "$T.dm()._scanoutInhibited")"
shot m10-fullscreen-edge
M 960 300; sleep 1.5
echo "  pointer away again: $(J "$T.snap()")"
E "const ed = global.get_window_actors().map(a => a.meta_window).find(w => (w.get_wm_class() || '').toLowerCase().includes('editor')); ed.unmake_fullscreen(); 1" > /dev/null; sleep 2
echo "  left fullscreen: inFullscreen=$(E "Main.layoutManager.primaryMonitor.inFullscreen") fsForced=$(E "$T.dm()._fsForced")"

# ---- 11. reduced motion: the desktop's animation switch off
echo "== REDUCED MOTION (org.gnome.desktop.interface enable-animations=false)"
E "new imports.gi.Gio.Settings({schema_id: 'org.gnome.desktop.interface'}).set_boolean('enable-animations', false); 1" > /dev/null; sleep 1
echo "  St enable_animations=$(E "imports.gi.St.Settings.get().enable_animations")"
M 960 300; sleep 1.5
E "$T.reset(); $T.sampling(true); $T.mark = $T.now(); $T.move(100, $MON_H - 10); 1" > /dev/null; sleep 1
E "$T.sampling(false); 1" > /dev/null
echo "  reveal: log=$(J "$T.log.map(l => ({e: l.e, ms: Math.round(l.t - $T.mark), to: l.to}))") intermediate opacities=$(E "[...new Set($T.samples.map(s => s[2]))].join(',')") (jump = only 0/255)"
M $((BX + BW / 2)) $YB; sleep 1
E "$T.gapSampling(true); 1" > /dev/null; M $((BX + 60)) $YB; sleep .06
echo "  magnification 60 ms after the pointer moved: maxScale=$(E "Math.max(...$T.geom().kids.map(k => k.s))") (spring off: at the target at once)"
sleep 1; E "$T.gapSampling(false); 1" > /dev/null
echo "  magnification settled: maxScale=$(E "Math.max(...$T.geom().kids.map(k => k.s))") minGap=$(E "$T.minGap()")"
E "const a = $T.im().getIconActor(imports.gi.Shell.AppSystem.get_default().lookup_app('org.gnome.Calculator.desktop')); $T.watchBounce(a, 10, 800); $T.im().bounceForApp(imports.gi.Shell.AppSystem.get_default().lookup_app('org.gnome.Calculator.desktop')); 1" > /dev/null; sleep 1.2
echo "  bounce min ty=$(E "Math.min(...$T.bounce.map(b => b[1]))") (0 = skipped)"
shot m11-reduced
E "new imports.gi.Gio.Settings({schema_id: 'org.gnome.desktop.interface'}).set_boolean('enable-animations', true); 1" > /dev/null; sleep 1
M 960 300; sleep 1.5

# ---- 12. disable/enable x5 with windows open and the dock mid-use: the shell log must stay clean
echo "== DISABLE/ENABLE x5"
for i in 1 2 3 4 5; do
  M $((BX + BW / 2)) $((MON_H - 12)); sleep .5
  E "Main.extensionManager.disableExtension('dock@niro.local'); 1" > /dev/null; sleep 1.2
  E "Main.extensionManager.enableExtension('dock@niro.local'); 1" > /dev/null; sleep 2.5
  E "imports.system.gc(); 1" > /dev/null
  echo "  cycle $i: state=$(E "Main.extensionManager.lookup('dock@niro.local').state") icons=$(E "$T.box().get_n_children()") signals=$(E "$T.im()._signals.size")"
done
shot m12-after-cycles
echo "== SHELL LOG: $(grep -ciE 'already disposed|JS ERROR|Exception|TypeError|CRITICAL' "$WORK/shell.log") error lines"
grep -iE 'already disposed|JS ERROR|Exception|TypeError|CRITICAL|WARNING' "$WORK/shell.log" | sed -E 's/[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]+//; s/gnome-shell:[0-9]+//' | sort | uniq -c | sort -rn | head -12
