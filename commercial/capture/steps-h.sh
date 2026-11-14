PLAY() { gdbus call --session --dest org.mpris.MediaPlayer2.niro_demo --object-path /org/mpris/MediaPlayer2 --method org.mpris.MediaPlayer2.Player.$1 >/dev/null 2>&1; }
S="Main.extensionManager.lookup('search@niro.local').stateObj"
ev "global.__move(2800, 1400); 1" > /dev/null; PLAY Play; sleep 3; shot h-pill
ev "global.__move(1920, 30); 1" > /dev/null; sleep 0.3; ev "global.__move(1923, 33); 1" > /dev/null; sleep 2.5; shot h-open
ev "global.__move(2800, 1300); 1" > /dev/null; sleep 1.5
ev "$S._open(); $S._entry.set_text('2*pi+17'); 1" > /dev/null; sleep 1.5; shot hs-calc
ev "$S._entry.set_text('dock position'); 1" > /dev/null; sleep 1.2; shot hs-setting
