# Checks that tests/uat/probes/uat-probe.js records the dock (synthetic pointer). Sourced by dock-session.sh.
HERE_STEPS=$(dirname "$STEPS"); P="$HERE_STEPS/../uat/probes/uat-probe.js"
sleep 4
ev "eval(imports.byteArray.toString(imports.gi.Gio.File.new_for_path('$HERE_STEPS/dock-helper.js').load_contents(null)[1]))" > /dev/null
DS="Main.extensionManager.lookup('dock@niro.local').stateObj.getSettings()"
ev "$DS.set_int('icon-size', 60); $DS.set_boolean('auto-hide', false); $DS.set_boolean('magnification-enabled', true); 1" > /dev/null
sleep 2; M 500 500; sleep .3; ev "Main.overview.hide(); 1" > /dev/null; sleep 1.5
GEOM=$(ev "(function(){const g=global.__t.geom(); return [g.bx,g.by,g.bw,g.bh,g.kids.length].join(' ')})()"); echo "geometry: $GEOM"
read BX BY BW BH NK <<< "$GEOM"
ev "eval(imports.byteArray.toString(imports.gi.GLib.file_get_contents('$P')[1]))" > /dev/null
ev "__uat.start('dock')"
Y=$((BY + BH/2)); for x in $(seq $((BX)) 12 $((BX+BW))); do M $x $Y; sleep .02; done
M 300 300; sleep 2.5
ev "__uat.stop()" | sed 's/\\\\n/\n/g'
