# Checks that tests/uat/probes/uat-probe.js loads and records in a headless session (both island and search enabled). Synthetic input only.
P="$ROOT/tests/uat/probes/uat-probe.js"
LOAD="eval(imports.byteArray.toString(imports.gi.GLib.file_get_contents('$P')[1]))"
ev "$LOAD"
ev "(function(){ const C = imports.gi.Clutter, G = imports.gi.GLib; const seat = global.stage.context.get_backend().get_default_seat(); globalThis.__kb = seat.create_virtual_device(C.InputDeviceType.KEYBOARD_DEVICE); globalThis.__key = k => { const t = G.get_monotonic_time(); __kb.notify_keyval(t, k, C.KeyState.PRESSED); __kb.notify_keyval(t + 4000, k, C.KeyState.RELEASED); }; return 1; })()" >/dev/null
echo "--- search"
ev "__uat.start('search')"
ev "$C._island.collapse && 1" >/dev/null
ev "Main.extensionManager.lookup('search@niro.local').stateObj._open(); 1" >/dev/null
for ch in a c e t x; do ev "__key('$ch'.charCodeAt(0)); 1" >/dev/null; wait_ms 30; done
wait_ms 600
ev "__uat.mark('typed'); 1" >/dev/null
ev "__uat.stop()"
echo "--- island"
ev "__uat.start('island')"; ev "__uat.mark('expand'); 1" >/dev/null
ev "$C.expand(); 1" >/dev/null; wait_ms 900; ev "__uat.mark('collapse'); 1" >/dev/null; ev "$C.collapse(); 1" >/dev/null; wait_ms 900
ev "__uat.stop()"
echo "--- frames"
ev "__uat.start('frames')"; ev "$C.expand(); 1" >/dev/null; wait_ms 800; ev "$C.collapse(); 1" >/dev/null; wait_ms 800
ev "__uat.stop()"
echo "--- errors"; ev "typeof __uat.start"
