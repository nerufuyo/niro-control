# C: NIRO Control and the desktop's reaction. Two user profiles are written into this session's own config (the real engine reads them).
mkdir -p "$XDG_CONFIG_HOME/niro-control/profiles"
cat > "$XDG_CONFIG_HOME/niro-control/profiles/film-everyday.json" <<J
{"format":"niro-profile","version":1,"id":"film-everyday","name":"Everyday","description":"Balanced glass, a dock that magnifies, alerts on","createdAt":"2026-11-14T00:00:00.000Z",
 "settings":{"niro.accent":"#8E9BFF","niro.tint":"#0A1030","niro.opacity":70,"niro.blur":true,"niro.blur-strength":40,"dock.auto-hide":false,"dock.magnification-enabled":true,"island.auto-hide":"off"}}
J
cat > "$XDG_CONFIG_HOME/niro-control/profiles/film-deepwork.json" <<J
{"format":"niro-profile","version":1,"id":"film-deepwork","name":"Deep Work","description":"Fewer distractions: quiet alerts, a hidden dock, the island out of the way","createdAt":"2026-11-14T00:00:00.000Z",
 "settings":{"niro.accent":"#8FD3FF","niro.tint":"#06101F","niro.opacity":86,"niro.blur":true,"niro.blur-strength":20,"dock.auto-hide":true,"dock.magnification-enabled":true,"island.auto-hide":"always"}}
J
PLAY() { gdbus call --session --dest org.mpris.MediaPlayer2.niro_demo --object-path /org/mpris/MediaPlayer2 --method org.mpris.MediaPlayer2.Player.$1 >/dev/null 2>&1; }
panel() { # page
  [ -n "${PANEL:-}" ] && kill $PANEL 2>/dev/null; sleep 1
  appenv env NIRO_NOBANNER=1 NIRO_SIZE=1180x780 NIRO_PAGE=$1 niro-control > /tmp/claude-1000/s/panel.log 2>&1 &
  PANEL=$!
  sleep 7; winpos org.niro.control 740 330 2360 1560; sleep 1.5
}
PLAY Play; niro-control --apply-profile film-everyday > /tmp/claude-1000/s/apply.log 2>&1; sleep 3
panel look; ev "global.__move(3700, 200); 1" > /dev/null; sleep 1; shot c-look-a
gsettings set org.niro.control accent "'#8FD3FF'"; sleep 2.5; shot c-look-accent
gsettings set org.niro.control preset "'crystal'"; sleep 3; shot c-look-crystal
gsettings set org.niro.control preset "'balanced'"; sleep 2
niro-control --apply-profile film-everyday > /dev/null 2>&1; sleep 2
panel profiles; shot c-prof-everyday
niro-control --apply-profile film-deepwork >> /tmp/claude-1000/s/apply.log 2>&1; sleep 3
panel profiles; shot c-prof-deepwork
kill $PANEL 2>/dev/null; sleep 2; ev "global.__move(3700, 200); 1" > /dev/null; sleep 2.5; shot c-desk-deepwork
niro-control --apply-profile film-everyday > /dev/null 2>&1; sleep 3.5; shot c-desk-everyday
