"""E2E runner library: input adapter + telemetry client + scenario/result bookkeeping.

Tier recorded on every result (never mixed with physical UAT):
  automated-headless-e2e   an isolated headless session, input through mutter's RemoteDesktop API, observation through the test-only telemetry
Nothing here is physical input: the events enter mutter's seat as a virtual device, not through libinput from a device node."""
import json, os, sys, time, traceback
from gi.repository import Gio, GLib
sys.path.insert(0, os.path.dirname(__file__))
from rdinput import RemoteInput

TIER = 'automated-headless-e2e'
INPUT_MECHANISM = 'org.gnome.Mutter.RemoteDesktop D-Bus session (NotifyKeyboardKeycode, NotifyPointerMotionRelative, NotifyPointerButton)'


class Telemetry:
    def __init__(self):
        self.bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
    def _c(self, m, args=None):
        return self.bus.call_sync('org.niro.E2E', '/org/niro/E2E', 'org.niro.E2E', m, args, None, 0, 8000, None).unpack()[0]
    def snap(self): return json.loads(self._c('Snapshot'))
    def start(self, name): return json.loads(self._c('Start', GLib.Variant('(s)', (name,))))
    def stop(self): return json.loads(self._c('Stop'))
    def events(self): return json.loads(self._c('Events'))


class Ctx:
    """What a scenario gets: input, observation, and a place to put its assertions and timings."""
    def __init__(self, out):
        self.out = out; self.inp = RemoteInput().start(); self.t = Telemetry()
        self.asserts = []; self.timings = {}; self.notes = []; self.path = []; self.evidence = []
    def close(self): self.inp.stop()
    def reset(self):
        """Between scenarios: close what a scenario left open, through the keyboard (Escape), so the next one starts from the idle state."""
        for _ in range(3):
            s = self.t.snap()
            if s['search']['visible'] or s['modal'] > 0 and not s['overview']:
                self.inp.tap('esc'); time.sleep(0.8)
            else: break
        self.pointer_to(300, 500)
        time.sleep(0.5)

    def sleep(self, s): time.sleep(s)
    def wait(self, pred, timeout=3.0, step=0.03, what=''):
        """Poll the telemetry until pred(snapshot) is truthy; returns (snapshot, elapsed ms). Polling is only for waiting, never an assertion on its own."""
        t0 = time.monotonic(); s = None
        while time.monotonic() - t0 < timeout:
            s = self.t.snap()
            try:
                if pred(s): return s, (time.monotonic() - t0) * 1000
            except (TypeError, KeyError): pass
            time.sleep(step)
        return None, None
    def check(self, name, ok, detail=''):
        self.asserts.append({'name': name, 'ok': bool(ok), 'detail': str(detail)}); return bool(ok)

    # ---- pointer: relative motion with closed-loop correction against the telemetry's pointer position
    def pointer_to(self, x, y, step=40, gap=0.008, tol=1):
        for _ in range(400):
            px, py = self.t.snap()['pointer']
            dx, dy = x - px, y - py
            if abs(dx) <= tol and abs(dy) <= tol: return True
            mx = max(-step, min(step, dx)); my = max(-step, min(step, dy))
            self.inp.move_rel(mx, my); time.sleep(gap)
        return False
    def pointer_path(self, pts, step=12, gap=0.008):
        """Move through (x, y) waypoints in small relative steps without reading telemetry each step (a realistic sweep); returns when done."""
        px, py = self.t.snap()['pointer']
        for x, y in pts:
            while abs(x - px) > 0.5 or abs(y - py) > 0.5:
                dx = max(-step, min(step, x - px)); dy = max(-step, min(step, y - py))
                self.inp.move_rel(dx, dy); px += dx; py += dy; time.sleep(gap)


def ready(c, timeout=60):
    """Observable readiness, no fixed sleeps: the Overview a headless session starts in is left with Escape (real path), then wait until no modal
    grab is held, Search is closed and the island has dropped its startup alert and settled (same rectangle over 0.6 s)."""
    if c.t.snap()['overview']: c.inp.tap('esc')
    last = [None, 0.0]
    def idle(s):
        if s['overview'] or s['modal'] != 0 or s['search']['state'] != 'Closed' or s['island']['presentation'] != 'compact' or s['island']['state'] != 'compact': last[0] = None; return False
        r = s['island']['rect']
        if last[0] != r: last[0] = r; last[1] = time.monotonic(); return False
        return time.monotonic() - last[1] > 0.6
    s, ms = c.wait(idle, timeout, 0.1)
    c.check('session is idle (no overview, no modal grab, Search closed, island compact and still)', s is not None, 'timeout')
    if s is None: raise Blocked('the session never became idle')
    return ms


def run(scenarios, out, env_note=''):
    os.makedirs(out, exist_ok=True)
    results = []
    for sc in scenarios:
        ctx = Ctx(out); t0 = time.monotonic(); status = 'Pass'; err = None
        try:
            sc.run(ctx)
            if not all(a['ok'] for a in ctx.asserts): status = 'Fail'
            if not ctx.asserts: status = 'Blocked'; err = 'no assertions ran'
        except Blocked as b:
            status = 'Blocked'; err = str(b)
        except Exception:
            status = 'Fail'; err = traceback.format_exc()
        finally:
            try: ctx.reset()
            except Exception: pass
            ctx.close()
        r = {'id': sc.id, 'tier': TIER, 'component': sc.component, 'scenario': sc.title, 'input_mechanism': INPUT_MECHANISM,
             'event_path_observed': ctx.path, 'expected': sc.expected, 'assertions': ctx.asserts, 'timings_ms': ctx.timings,
             'notes': ctx.notes, 'evidence': ctx.evidence, 'status': status, 'error': err, 'duration_s': round(time.monotonic() - t0, 2)}
        results.append(r)
        print(f"[{status:7}] {sc.id}  {sc.title}  ({r['duration_s']}s)")
        for a in ctx.asserts:
            if not a['ok']: print(f"          FAIL {a['name']}: {a['detail']}")
        if err: print('          ' + err.strip().splitlines()[-1])
    json.dump({'env': env_note, 'results': results}, open(os.path.join(out, 'e2e-results.json'), 'w'), indent=1)
    return results


class Blocked(Exception):
    pass


class Scenario:
    id = title = component = expected = ''
    def run(self, ctx): raise NotImplementedError
