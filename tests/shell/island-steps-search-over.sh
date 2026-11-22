# Search opened over an expanded island: who holds the keyboard, and what the island does. Needs WITH_SEARCH=1.
S='Main.extensionManager.lookup("search@niro.local").stateObj'
snap() { echo "$1 | island=$(ev "$C._surface.state") expanded=$(ev "$C._presentation") modal=$(ev "Main.modalCount") focus=$(ev "String(global.stage.key_focus)" | cut -c1-60) searchState=$(ev "$S._sm.state")"; }
snap start
ev "$C.expand(); 1" >/dev/null; wait_ms 900; snap island-open
ev "$S._open(); 1" >/dev/null; wait_ms 900; snap search-over-island
shot search-over-island
ev "$S._close(); 1" >/dev/null; wait_ms 900; snap search-closed
shot after-close
ev "$C.collapse(); 1" >/dev/null; wait_ms 900; snap island-closed
echo "-- reverse: island opened while search is open"
ev "$S._open(); 1" >/dev/null; wait_ms 700; snap search-open
ev "$C.expand(); 1" >/dev/null; wait_ms 900; snap island-over-search
ev "$S._close(); 1" >/dev/null; wait_ms 900; snap search-closed-2
ev "$C.collapse(); 1" >/dev/null; wait_ms 600; snap end
