# film shots, part 1: the Search palette, as it is: empty (with its suggestions), a calculation, a unit, a time zone, and a setting typed letter by letter
S="Main.extensionManager.lookup('search@niro.local').stateObj"
M() { ev "global.__move($1, $2); 1" > /dev/null; }
M 500 500; sleep .3; M 500 500; sleep .4; ev "Main.overview.hide(); 1" > /dev/null; sleep 2
M 1700 900; ev "Main.overview.hide(); 1" > /dev/null; sleep 2
ev "$S._open(); 1" > /dev/null; sleep 1.5; shot s-open
for q in 'a' 'ac' 'acc' 'accent'; do ev "$S._entry.set_text('$q'); 1" > /dev/null; sleep 1.2; shot s-$q; done
ev "$S._entry.set_text('2*pi+17'); 1" > /dev/null; sleep 1.5; shot s-calc
ev "$S._entry.set_text('10 km to mi'); 1" > /dev/null; sleep 1.5; shot s-unit
ev "$S._entry.set_text('10:00 jakarta to london'); 1" > /dev/null; sleep 1.5; shot s-zone
ev "$S._close(); 1" > /dev/null
