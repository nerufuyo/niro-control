# Lifecycle of the dock's icons: reloads (favorites change), garbage collection, then disable/enable x5; the shell log is the verdict
# (sourced by dock-session.sh). A reload drops the icons from the container: when they are only detached (not destroyed) their handlers stay
# connected, and the GC later disposes them, so the next disconnectAll() at disable() meets a disposed object.
echo "STATE $(ev "Main.extensionManager.lookup('dock@niro.local').state")"
sleep 3
FAV() { ev "new imports.gi.Gio.Settings({schema_id: 'org.gnome.shell'}).set_strv('favorite-apps', $1); 1" > /dev/null; sleep 1; }
for i in 1 2 3; do
  FAV "['org.gnome.Calculator.desktop','org.gnome.Nautilus.desktop']"
  FAV "['org.gnome.Calculator.desktop','org.gnome.Nautilus.desktop','org.gnome.TextEditor.desktop','org.gnome.Settings.desktop']"
done
for i in 1 2 3; do ev "imports.system.gc(); 1" > /dev/null; sleep 1; done
for i in 1 2 3 4 5; do
  ev "Main.extensionManager.disableExtension('dock@niro.local'); 1" > /dev/null; sleep 1.5
  ev "Main.extensionManager.enableExtension('dock@niro.local'); 1" > /dev/null; sleep 3
  ev "imports.system.gc(); 1" > /dev/null
  echo "CYCLE $i state=$(ev "Main.extensionManager.lookup('dock@niro.local').state")"
done
shot lifecycle-after
echo "ERRORS $(grep -ciE 'already disposed|JS ERROR|Exception|TypeError|CRITICAL' "$WORK/shell.log")"
grep -iE 'already disposed|JS ERROR|Exception|TypeError|CRITICAL' "$WORK/shell.log" | sed -E 's/[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]+//; s/gnome-shell:[0-9]+//' | sort | uniq -c | sort -rn | head -20
