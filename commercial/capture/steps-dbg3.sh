mkdir -p /tmp/Studio
appenv gnome-text-editor /tmp/Studio/notes.md > /dev/null 2>&1 &
for i in $(seq 1 120); do o=$(ev "global.get_window_actors().filter(a => /TextEditor/i.test(a.meta_window.get_wm_class() || '') && a.width > 100).length"); [ "${o:-0}" -ge 1 ] 2>/dev/null && break; sleep 1; done; sleep 5
echo "actor before: $(ev "global.get_window_actors().map(a => [a.x, a.y, a.width, a.height].join(',')).join(' | ')")" >> /tmp/dbg-out.txt
ev "(function(){ const w = global.get_window_actors().map(a => a.meta_window).find(w => /TextEditor/i.test(w.get_wm_class() || '')); w.move_frame(true, 3300, 900); return 1; })()" > /dev/null; sleep 2
echo "after move_frame: $(ev "global.get_window_actors().map(a => [a.x, a.y, a.width, a.height].join(',')).join(' | ')")" >> /tmp/dbg-out.txt
ev "(function(){ const w = global.get_window_actors().map(a => a.meta_window).find(w => /TextEditor/i.test(w.get_wm_class() || '')); w.move_resize_frame(true, 3300, 1000, 3040, 1900); return 1; })()" > /dev/null; sleep 2
echo "after move_resize_frame: $(ev "global.get_window_actors().map(a => [a.x, a.y, a.width, a.height].join(',')).join(' | ')")" >> /tmp/dbg-out.txt
ev "global.__move(7400, 2000); 1" > /dev/null; sleep 2; shot dbg-ed
