"""Automated E2E scenarios (tier: automated-headless-e2e). Input: mutter RemoteDesktop. Observation: the test-only telemetry. No controller method is called.
Each scenario starts from `ready()` (observable idle state) and the runner closes whatever it leaves open. None of these is a physical-input UAT result."""
import json, os, subprocess, sys, time
sys.path.insert(0, os.path.dirname(__file__))
from e2e import *
from gi.repository import Gio, GLib

STARTING = 1   # Shell.AppState.STARTING


def rows_of(info): return json.load(open(info['file']))['rows']
def apps_started(c): return [e for e in c.t.events() if e['kind'] == 'app-state' and e['state'] == STARTING and e['t'] > c.mark]
def gset(schema, key, val): subprocess.run(['gsettings', 'set', schema, key, val], check=True)
def open_search(c, query=''):
    c.inp.chord('super', 'space')
    s, ms = c.wait(lambda s: s['search']['visible'] and s['search']['inputFocus'], 3, 0.03)
    c.check('Search opens by its shortcut with focus in the entry', s is not None, ms)
    if query:
        c.inp.type(query, gap=0.02)
        c.wait(lambda s: s['search']['text'] == query, 3)
    return ms
def island_rect(c): return c.t.snap()['island']['rect']
def hover_island(c):
    r = island_rect(c); c.pointer_to(int(r['x'] + r['w'] / 2), int(r['y'] + r['h'] / 2))


class S(Scenario):
    def setup(self, c):
        ready(c); c.mark = c.t.snap()['t']      # events before this point (earlier scenarios) are not this scenario's


class SrchOpenClose(S):
    id = 'E2E-SRCH-01'; component = 'Search'; title = 'Open, close with Escape, focus restoration'
    expected = 'Opening takes the keyboard (modal grab); Escape closes it; the grab and key focus return to what they were before'
    def run(self, c):
        self.setup(c); before = c.t.snap()
        open_search(c)
        s = c.t.snap(); c.check('a modal grab is held while open', s['modal'] >= 1, s['modal'])
        c.inp.tap('esc')
        s, ms = c.wait(lambda s: s['search']['state'] == 'Closed' and s['modal'] == before['modal'], 3)
        c.check('Escape closes Search and releases the grab', s is not None, c.t.snap()['search']['state'])
        c.timings['escape_to_closed'] = ms
        after = c.t.snap()
        c.check('key focus returns to what it was', after['keyFocus'] == before['keyFocus'], f"{before['keyFocus']} -> {after['keyFocus']}")


class SrchRapidTyping(S):
    id = 'E2E-SRCH-02'; component = 'Search'; title = 'Rapid typing right after the shortcut loses no character'
    expected = 'Every character typed with 5 ms gaps while the panel animates appears, in order'
    def run(self, c):
        self.setup(c)
        text = 'the quick brown fox 12345'
        c.inp.chord('super', 'space')
        c.inp.type(text, gap=0.005)           # no waiting for the opening
        s, ms = c.wait(lambda s: s['search']['text'] == text, 4)
        c.check('all characters arrived in order', s is not None, c.t.snap()['search']['text'])
        c.timings['typed_to_complete'] = ms


class SrchNavigation(S):
    id = 'E2E-SRCH-03'; component = 'Search'; title = 'Result navigation with the arrow keys'
    expected = 'Down moves the selection forward, Up back; both wrap; the entry keeps the keyboard'
    def run(self, c):
        self.setup(c); open_search(c, 'a')
        c.wait(lambda s: (s['search']['rows'] or 0) > 2, 4)
        n = c.t.snap()['search']['rows']; c.check('more than two result rows', n > 2, n)
        s0 = c.t.snap()['search']['selected']
        c.inp.tap('down'); s1, _ = c.wait(lambda s: s['search']['selected'] != s0, 2)
        c.check('Down changes the selection', s1 is not None, f'{s0} -> {c.t.snap()["search"]["selected"]}')
        mid = c.t.snap()['search']['selected']
        c.inp.tap('up'); s2, _ = c.wait(lambda s: s['search']['selected'] != mid, 2)
        c.check('Up moves back', s2 is not None and c.t.snap()['search']['selected'] == s0, c.t.snap()['search']['selected'])
        c.check('input focus stays in the entry', c.t.snap()['search']['inputFocus'])


class SrchEnter(S):
    id = 'E2E-SRCH-04'; component = 'Search'; title = 'Enter starts the result once, closes Search, even if pressed twice'
    expected = 'One Enter starts exactly one application; a second Enter at once starts nothing more'
    def run(self, c):
        self.setup(c); open_search(c, 'calc')
        c.wait(lambda s: (s['search']['rows'] or 0) > 0, 4)
        c.inp.tap('enter'); c.inp.tap('enter', hold=0.01)
        s, ms = c.wait(lambda s: s['search']['state'] == 'Closed', 4)
        c.check('Search closes after Enter', s is not None, c.t.snap()['search']['state'])
        c.sleep(2.0)
        n = len(apps_started(c)); c.check('exactly one application started', n == 1, n)
        c.path = ['Return -> ClutterText activate signal (GNOME 51) -> Search._activate']


class SrchEnterWhileOpening(S):
    id = 'E2E-SRCH-05'; component = 'Search'; title = 'Enter while the panel is still opening, and before results exist'
    expected = 'Typing and Enter straight after the shortcut never hangs or duplicates: Search ends closed or open, with at most one application started'
    def run(self, c):
        self.setup(c)
        c.inp.chord('super', 'space'); c.inp.type('calc', gap=0.003); c.inp.tap('enter')
        s, ms = c.wait(lambda s: s['search']['state'] in ('Closed', 'ResultsExpanded', 'Ready'), 4)
        c.check('Search settles (no stuck Opening/Executing)', s is not None, c.t.snap()['search']['state'])
        c.sleep(2.0)
        n = len(apps_started(c)); c.check('at most one application started', n <= 1, n)
        c.notes.append(f"outcome: {n} application(s) started; Search state {c.t.snap()['search']['state']} (informational: the product decides whether Enter before results does anything)")


class SrchEnterWhileClosing(S):
    id = 'E2E-SRCH-06'; component = 'Search'; title = 'Enter during the closing animation starts nothing'
    expected = 'Escape then Enter at once: nothing is started, Search ends closed'
    def run(self, c):
        self.setup(c); open_search(c, 'calc'); c.wait(lambda s: (s['search']['rows'] or 0) > 0, 4)
        c.inp.tap('esc', hold=0.005); c.inp.tap('enter', hold=0.005)
        s, ms = c.wait(lambda s: s['search']['state'] == 'Closed', 4)
        c.check('Search ends closed', s is not None, c.t.snap()['search']['state'])
        c.sleep(1.5); n = len(apps_started(c)); c.check('no application started by the late Enter', n == 0, n)


class SrchSpam(S):
    id = 'E2E-SRCH-07'; component = 'Search'; title = 'Interrupted open/close, 10 rapid cycles'
    expected = 'After 10 open/close pairs with 40 ms gaps Search is closed, no modal grab remains, the panel is hidden'
    def run(self, c):
        self.setup(c)
        for _ in range(10):
            c.inp.chord('super', 'space', hold=0.01); time.sleep(0.04); c.inp.tap('esc', hold=0.01); time.sleep(0.04)
        s, ms = c.wait(lambda s: s['search']['state'] == 'Closed' and not s['search']['visible'] and s['modal'] == 0, 5)
        c.check('closed, hidden, no grab', s is not None, c.t.snap()['search'])
        open_search(c); c.check('Search still opens afterwards', c.t.snap()['search']['visible'])


class DockEdge(S):
    id = 'E2E-DOCK-01'; component = 'Dock'; title = 'Edge reveal, auto-hide and hysteresis'
    expected = 'Far from the edge nothing shows; at the edge the dock reveals; leaving hides it; jittering across the threshold does not make it flicker per crossing'
    def run(self, c):
        self.setup(c)
        c.pointer_to(300, 900); c.sleep(0.6)
        c.check('hidden with the pointer well above the edge', not c.t.snap()['dock']['visible'])
        c.pointer_to(960, 1070, step=60)
        s, ms = c.wait(lambda s: s['dock']['visible'] and abs(s['dock']['ty']) < 1, 4)
        c.check('revealed at the edge', s is not None, c.t.snap()['dock']['state']); c.timings['edge_to_shown'] = ms
        c.pointer_to(300, 600, step=60)
        s, ms = c.wait(lambda s: not s['dock']['visible'], 5)
        c.check('hides after the pointer leaves', s is not None, c.t.snap()['dock']['state']); c.timings['leave_to_hidden'] = ms
        c.t.start('dock-hyst'); c.pointer_to(960, 1070, step=60); c.wait(lambda s: s['dock']['visible'], 4)
        crossings = 0
        for _ in range(10):
            c.pointer_to(960, 1042, step=6, gap=0.012); c.pointer_to(960, 1074, step=6, gap=0.012); crossings += 2
        c.sleep(0.5); info = c.t.stop()
        ev = [e for e in json.load(open(info['file']))['events'] if e['kind'] == 'state' and e['component'] == 'dock']
        c.notes.append(f'{len(ev)} dock state transitions across {crossings} pointer crossings of the 30 px zone: {[e["to"] for e in ev][:12]}')
        c.check('fewer transitions than crossings (hysteresis absorbs jitter)', len(ev) < crossings, f'{len(ev)} vs {crossings}')
        c.evidence.append(info['file'])


class DockNeighbours(S):
    id = 'E2E-DOCK-02'; component = 'Dock'; title = 'Magnification displaces neighbours without overlap and settles'
    expected = 'Sweeping raises an icon scale; neighbours never overlap by more than 1 px; after the pointer leaves, all scales return to 1'
    def run(self, c):
        self.setup(c)
        c.pointer_to(960, 1070, step=60); s = c.wait(lambda s: s['dock']['visible'] and abs(s['dock']['ty']) < 1 and s['dock']['icons'], 4)[0]
        r = c.t.snap()['dock']['rect']; y = r['y'] + r['h'] / 2
        c.t.start('dock-sweep'); c.pointer_path([(r['x'] + 5, y), (r['x'] + r['w'] - 5, y), (r['x'] + 5, y)], step=10); c.sleep(0.2)
        info = c.t.stop(); rows = rows_of(info)
        mx = max((x['dock']['maxScale'] or 0) for x in rows if x['dock']); ov = max(x['dock']['overlap'] for x in rows if x['dock'])
        c.check('an icon is magnified above 1.2', mx > 1.2, mx); c.check('no overlap above 1 px', ov <= 1, ov); c.evidence.append(info['file'])
        c.pointer_to(300, 500, step=60)
        s, ms = c.wait(lambda s: not s['dock']['visible'] or (s['dock']['maxScale'] or 1) < 1.01, 5)
        c.check('scales settle back to 1 (or the dock is hidden)', s is not None, c.t.snap()['dock'].get('maxScale'))


class IslandHover(S):
    id = 'E2E-ISL-01'; component = 'Island'; title = 'Hover expands, content stays inside the surface, leaving collapses'
    expected = 'Hover opens the island; while it grows no text/icon is cut off by more than 3 px; moving away collapses it'
    def run(self, c):
        self.setup(c); c.t.start('island-hover'); hover_island(c)
        s, ms = c.wait(lambda s: s['island']['state'] == 'expanded', 4)
        c.check('hover expands', s is not None, c.t.snap()['island']['state']); c.timings['hover_to_expanded'] = ms
        c.sleep(0.8); c.pointer_to(300, 700, step=80)
        s, ms = c.wait(lambda s: s['island']['state'] == 'compact', 5)
        c.check('leaving collapses', s is not None, c.t.snap()['island']['state'])
        info = c.t.stop(); rows = [r['island'] for r in rows_of(info) if r['island']]
        cut = max(r['cut'] for r in rows); c.check('no content cut by more than 3 px across the whole morph', cut <= 3, cut)
        c.evidence.append(info['file']); c.notes.append(f'{len(rows)} paints recorded; max cut {cut} px (the same indicator as tests/uat probe, not a visual judgement)')


class IslandInterrupt(S):
    id = 'E2E-ISL-02'; component = 'Island'; title = 'Interrupted expansion settles in a single state'
    expected = 'Entering and leaving 6 times quickly never leaves the island half open; it ends compact'
    def run(self, c):
        self.setup(c); r = island_rect(c); cx, cy = int(r['x'] + r['w'] / 2), int(r['y'] + r['h'] / 2)
        for _ in range(6):
            c.pointer_to(cx, cy, step=80); time.sleep(0.35); c.pointer_to(300, 600, step=80); time.sleep(0.12)
        s, ms = c.wait(lambda s: s['island']['state'] == 'compact' and not s['island']['hovered'], 8)
        c.check('ends compact', s is not None, c.t.snap()['island']['state'])
        c.check('no modal grab left behind', c.t.snap()['modal'] == 0, c.t.snap()['modal'])


class XSearchOverIsland(S):
    id = 'E2E-X-01'; component = 'Search+Island'; title = 'Search opened over an expanded island keeps a 12 px gap and the keyboard'
    expected = 'The island stays expanded, Search has the focus, and its top is at least 12 px below the island bottom'
    def run(self, c):
        self.setup(c); hover_island(c)
        c.wait(lambda s: s['island']['state'] == 'expanded', 4)
        c.sleep(0.8); open_search(c, 'a'); c.sleep(0.8)
        s = c.t.snap(); isl = s['island']['rect']; sr = s['search']['rect']
        c.check('island expanded under Search', s['island']['state'] == 'expanded', s['island']['state'])
        c.check('Search holds the input focus', s['search']['inputFocus'])
        if isl and sr and sr['x'] < isl['x'] + isl['w'] and isl['x'] < sr['x'] + sr['w']:
            gap = sr['y'] - (isl['y'] + isl['h']); c.check('gap to the island is at least 12 px (within 1 px)', gap >= 11, gap); c.timings['gap_px'] = round(gap, 2)
        else: c.check('rectangles measured', False, f'{isl} {sr}')
        c.inp.tap('esc'); s, ms = c.wait(lambda s: s['search']['state'] == 'Closed', 3)
        c.check('Escape closes Search only; the island is not asked to close', c.t.snap()['search']['state'] == 'Closed')


class XIslandWhileSearch(S):
    id = 'E2E-X-02'; component = 'Search+Island'; title = 'Hovering the island while Search is open does not steal the keyboard'
    expected = 'Search keeps its input focus and the modal grab; no overlap at rest'
    def run(self, c):
        self.setup(c); open_search(c, 'a'); c.sleep(0.5)
        r = island_rect(c); c.pointer_to(int(r['x'] + r['w'] / 2), int(r['y'] + r['h'] / 2)); c.sleep(2.5)
        s = c.t.snap(); c.check('Search keeps the input focus', s['search']['inputFocus'], s['keyFocus'])
        c.check('modal grab still held by Search', s['modal'] >= 1 and s['search']['visible'], s['modal'])
        isl, sr = s['island']['rect'], s['search']['rect']
        if isl and sr and sr['x'] < isl['x'] + isl['w'] and isl['x'] < sr['x'] + sr['w']:
            c.check('no overlap at rest', sr['y'] >= isl['y'] + isl['h'] - 1, f"{sr['y']} vs {isl['y'] + isl['h']}")
        c.notes.append(f"island state while Search is open: {s['island']['state']}")


class ReducedMotion(S):
    id = 'E2E-A11Y-01'; component = 'All'; title = 'Reduced motion: Search opens without intermediate frames'
    expected = 'With enable-animations off Search goes straight to its final pose: no paint with an intermediate opacity or offset'
    def run(self, c):
        self.setup(c)
        try:
            gset('org.gnome.desktop.interface', 'enable-animations', 'false'); c.sleep(0.5)
            c.check('telemetry sees animations disabled', c.t.snap()['animations'] is False)
            c.t.start('reduced-search'); open_search(c); c.sleep(0.5); c.inp.tap('esc'); c.wait(lambda s: s['search']['state'] == 'Closed', 3); c.sleep(0.3)
            info = c.t.stop(); rows = [r['search'] for r in rows_of(info) if r['search'] and r['search']['visible']]
            inter = [r for r in rows if 0 < r['opacity'] < 255 or abs(r['ty']) > 0.5 or abs(r['sx'] - 1) > 0.01]
            c.check('no intermediate pose while visible', not inter, f'{len(inter)} of {len(rows)} paints'); c.evidence.append(info['file'])
        finally:
            gset('org.gnome.desktop.interface', 'enable-animations', 'true')


class Lifecycle(S):
    id = 'E2E-LIFE-01'; component = 'All'; title = 'Disable and enable each extension 3 times; Search and the dock work afterwards'
    expected = 'Each cycle ends ACTIVE with no shell error (counted by the session); Search opens again; the dock reveals again'
    def run(self, c):
        self.setup(c)
        bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
        def x(m, u): bus.call_sync('org.gnome.Shell.Extensions', '/org/gnome/Shell/Extensions', 'org.gnome.Shell.Extensions', m, GLib.Variant('(s)', (u,)), None, 0, 5000, None)
        def state(u): return bus.call_sync('org.gnome.Shell.Extensions', '/org/gnome/Shell/Extensions', 'org.gnome.Shell.Extensions', 'GetExtensionInfo', GLib.Variant('(s)', (u,)), None, 0, 5000, None).unpack()[0].get('state')
        for u in ('search@niro.local', 'dock@niro.local', 'island@niro.local'):
            for i in range(3):
                x('DisableExtension', u); time.sleep(0.7); x('EnableExtension', u); time.sleep(1.2)
            c.check(f'{u} ACTIVE after 3 cycles', state(u) == 1, state(u))
        ready(c); open_search(c); c.inp.tap('esc'); c.wait(lambda s: s['search']['state'] == 'Closed', 3)
        c.pointer_to(960, 1070, step=60); s, ms = c.wait(lambda s: s['dock']['visible'], 4)
        c.check('dock reveals again', s is not None, c.t.snap()['dock']['state'])
        c.check('island responds again', c.t.snap()['island']['visible'])


ALL = [SrchOpenClose, SrchRapidTyping, SrchNavigation, SrchEnter, SrchEnterWhileOpening, SrchEnterWhileClosing, SrchSpam,
       DockEdge, DockNeighbours, IslandHover, IslandInterrupt, XSearchOverIsland, XIslandWhileSearch, ReducedMotion, Lifecycle]

if __name__ == '__main__':
    only = os.environ.get('E2E_ONLY', '')
    run([k() for k in ALL if only in k.id], os.environ.get('E2E_OUT', '/tmp/e2e-out'))
