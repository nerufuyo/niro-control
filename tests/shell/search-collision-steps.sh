# Steps for tests/shell/search-collision.sh, sourced inside island-session.sh (needs ev, shot, wait_ms, $C; WITH_SEARCH=1).
S='Main.extensionManager.lookup("search@niro.local").stateObj'
ev "$C.collapse(); 1" > /dev/null; wait_ms 900
if [ -n "${SHOTS:-}" ]; then
    ev "$S._open(); 1" > /dev/null; wait_ms 900; shot search-compact-island
    ev "$C.expand(); 1" > /dev/null; wait_ms 1300; shot search-clear-of-island
    ev "$S._close(); 1" > /dev/null; wait_ms 800
    ev "$C.collapse(); 1" > /dev/null; wait_ms 900
fi
gdbus call --session --dest org.gnome.Shell --object-path /org/gnome/Shell --method org.gnome.Shell.Eval "$(< "$HERE/search-collision.js")" > /dev/null
for _ in $(seq 240); do
    R=$(gdbus call --session --dest org.gnome.Shell --object-path /org/gnome/Shell --method org.gnome.Shell.Eval "global.__searchCollision" 2>&1)
    case "$R" in *running*) sleep 1;; *) break;; esac
done
echo "RESULT $R"
