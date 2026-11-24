"""Proof of concept (Phase 2): Search by its shortcut, typing, Enter; Dock pointer magnification; Island hover. All through RemoteDesktop input."""
import sys, os
sys.path.insert(0, os.path.dirname(__file__))
from e2e import *

def leave_overview(c):
    """Real path: Escape leaves the Overview a headless session starts in; then wait until nothing holds the keyboard and the island's startup alert is gone."""
    if c.t.snap()['overview']:
        c.inp.tap('esc')
    s, ms = c.wait(lambda s: not s['overview'] and s['modal'] == 0 and s['island']['presentation'] == 'compact', 40, 0.2)
    c.check('session is idle (no overview, no modal grab, island compact)', s is not None, c.t.snap())
    c.sleep(0.5)

class SearchTypeEnter(Scenario):
    id = 'E2E-POC-SRCH-01'; component = 'Search'; title = 'Shortcut opens Search, typing lands, Enter activates'
    expected = 'Super+Space opens Search with input focus; the typed text appears; Enter starts the matching application and closes Search'
    def run(self, c):
        leave_overview(c)
        s0 = c.t.snap()
        c.check('Search starts closed', s0['search']['state'] == 'Closed', s0['search']['state'])
        c.inp.chord('super', 'space')
        s, ms = c.wait(lambda s: s['search']['visible'] and s['search']['inputFocus'], 3)
        c.check('shortcut opens Search with focus in the entry', s is not None, 'timeout' if s is None else f'{ms:.0f} ms')
        c.timings['open_to_focus'] = ms
        c.inp.type('calc', gap=0.03)
        s, ms = c.wait(lambda s: s['search']['text'] == 'calc', 3)
        c.check('typed text appears in the entry', s is not None, (s or c.t.snap())['search']['text'])
        c.wait(lambda s: s['search']['rows'] and s['search']['rows'] > 0, 3)
        c.inp.tap('enter')
        s, ms = c.wait(lambda s: s['search']['state'] in ('Closed', 'Closing', 'Executing'), 3)
        c.check('Enter starts the selected result (Search leaves its results state)', s is not None, c.t.snap()['search']['state'])
        c.sleep(2.5)
        evs = [e for e in c.t.events() if e['kind'] == 'app-state']
        c.check('an application state change followed Enter', len(evs) > 0, evs[:3])
        fin = c.t.snap()
        c.check('Search is closed afterwards', fin['search']['state'] == 'Closed', fin['search']['state'])
        c.path = ['RemoteDesktop NotifyKeyboardKeycode -> mutter virtual keyboard -> stage', f"stage key-press events counted: {fin['stageEvents'].get('key-press')}"]
        c.check('stage saw the shortcut press (later keys go to the modal grab, not the stage)', fin['stageEvents'].get('key-press', 0) >= 1, fin['stageEvents'])

class DockMagnify(Scenario):
    id = 'E2E-POC-DOCK-01'; component = 'Dock'; title = 'Pointer reveals the dock and magnifies icons'
    expected = 'Moving the pointer to the bottom edge shows the dock; sweeping across icons raises one icon scale above 1 while neighbours stay clear of each other'
    def run(self, c):
        leave_overview(c)
        c.pointer_to(300, 500)
        c.sleep(0.5)
        c.pointer_to(960, 1079, step=60)
        s, ms = c.wait(lambda s: s['dock']['state'] not in ('hidden',) and s['dock']['visible'] and s['dock']['icons'], 4)
        c.check('dock becomes visible at the bottom edge', s is not None, (s or c.t.snap())['dock'].get('state'))
        c.timings['edge_to_visible'] = ms
        s = c.wait(lambda s: s['dock']['rect'] and abs(s['dock']['ty']) < 1, 3)[0] or c.t.snap()
        d = s['dock']; r = d['rect']
        y = r['y'] + r['h'] / 2
        c.t.start('poc-dock')
        c.pointer_path([(r['x'] + 5, y), (r['x'] + r['w'] - 5, y)], step=10)
        c.sleep(0.3)
        info = c.t.stop()
        import json
        rows = json.load(open(info['file']))['rows']
        mx = max((x['dock']['maxScale'] or 0) for x in rows if x['dock'])
        ov = max((x['dock']['overlap'] for x in rows if x['dock']))
        c.check('an icon was magnified above 1.2 during the sweep', mx > 1.2, f'max scale {mx}')
        c.check('no neighbouring icons overlapped by more than 1 px', ov <= 1, f'max overlap {ov}')
        c.evidence.append(info['file'])
        c.path = ['RemoteDesktop NotifyPointerMotionRelative -> mutter virtual pointer -> stage motion', f"stage motion events: {c.t.snap()['stageEvents'].get('motion')}"]
        c.check('stage received motion events', c.t.snap()['stageEvents'].get('motion', 0) > 20, c.t.snap()['stageEvents'])

class IslandHover(Scenario):
    id = 'E2E-POC-ISL-01'; component = 'Island'; title = 'Pointer hover expands the Island and leaving collapses it'
    expected = 'Hovering the closed Island expands it; moving away collapses it'
    def run(self, c):
        leave_overview(c)
        c.pointer_to(300, 500)
        s, ms = c.wait(lambda s: s['island']['presentation'] == 'compact' and s['island']['state'] == 'compact', 40, 0.2)
        c.check('island settles to the compact idle shape (startup alert gone)', s is not None, c.t.snap()['island']['presentation'])
        c.sleep(0.5)
        isl = c.t.snap()['island']; r = isl['rect']
        c.timings['island_rect'] = r
        c.pointer_to(int(r['x'] + r['w'] / 2), int(r['y'] + r['h'] / 2))
        s, ms = c.wait(lambda s: s['island']['state'] == 'expanded', 3)
        c.check('hover expands the island', s is not None, c.t.snap()['island']['state'])
        c.timings['hover_to_expanded'] = ms
        c.sleep(0.8)
        c.pointer_to(300, 700, step=80)
        s, ms = c.wait(lambda s: s['island']['state'] == 'compact', 4)
        c.check('leaving collapses the island', s is not None, c.t.snap()['island']['state'])
        c.timings['leave_to_compact'] = ms
        c.path = ['RemoteDesktop NotifyPointerMotionRelative -> stage enter/leave on the island', f"stage events: {c.t.snap()['stageEvents']}"]

if __name__ == '__main__':
    only = os.environ.get('E2E_ONLY', '')
    run([x for x in (SearchTypeEnter(), DockMagnify(), IslandHover()) if only in x.id], os.environ.get('E2E_OUT', '/tmp/e2e-out'))
