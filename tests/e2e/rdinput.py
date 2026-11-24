"""Input adapter for the E2E runner: the compositor's own RemoteDesktop D-Bus API (org.gnome.Mutter.RemoteDesktop), the same
service the XDG RemoteDesktop portal wraps. Events enter mutter's seat as a virtual device and travel the normal stage event path
(keymap, key focus, grabs, input method, picking) just as libinput events do. Only usable in a session the caller owns: in a real
session mutter allows this call to any client on the bus too, so the runner refuses to run outside an isolated session (see e2e.sh)."""
import time
from gi.repository import Gio, GLib

BASE = 'org.gnome.Mutter.RemoteDesktop'
# evdev keycodes, US layout (the isolated session's layout)
KEY = {'esc': 1, 'enter': 28, 'space': 57, 'backspace': 14, 'tab': 15, 'super': 125, 'shift': 42, 'ctrl': 29, 'alt': 56,
       'up': 103, 'down': 108, 'left': 105, 'right': 106}
ROW = {c: i for i, c in enumerate('1234567890', 2)}
for i, c in enumerate('qwertyuiop', 16): ROW[c] = i
for i, c in enumerate('asdfghjkl', 30): ROW[c] = i
for i, c in enumerate('zxcvbnm', 44): ROW[c] = i
ROW.update({' ': 57, '-': 12, '=': 13, '.': 52, ',': 51, '/': 53, ';': 39})


class RemoteInput:
    def __init__(self):
        self.bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
        self.session = None
        self.log = []          # (monotonic ms, call, args): what was sent

    def _call(self, method, args=None, iface=BASE + '.Session', path=None):
        r = self.bus.call_sync(BASE, path or self.session, iface, method, args, None, Gio.DBusCallFlags.NONE, 5000, None)
        return r.unpack() if r else None

    def start(self):
        self.session = self._call('CreateSession', None, BASE, '/org/gnome/Mutter/RemoteDesktop')[0]
        self._call('Start')
        return self

    def stop(self):
        if self.session:
            try: self._call('Stop')
            finally: self.session = None

    def _rec(self, name, *a): self.log.append((GLib.get_monotonic_time() / 1000, name, a))

    def key(self, code, down):
        self._rec('key', code, down); self._call('NotifyKeyboardKeycode', GLib.Variant('(ub)', (code, down)))

    def tap(self, name, hold=0.03):
        code = KEY[name] if name in KEY else ROW[name]
        self.key(code, True); time.sleep(hold); self.key(code, False)

    def chord(self, *names, hold=0.05):
        codes = [KEY[n] if n in KEY else ROW[n] for n in names]
        for c in codes: self.key(c, True)
        time.sleep(hold)
        for c in reversed(codes): self.key(c, False)

    def type(self, text, gap=0.02):
        for ch in text:
            low = ch.lower()
            shift = ch != low
            if shift: self.key(KEY['shift'], True)
            self.tap(low, hold=0.01)
            if shift: self.key(KEY['shift'], False)
            time.sleep(gap)

    def move_rel(self, dx, dy):
        self._rec('rel', dx, dy); self._call('NotifyPointerMotionRelative', GLib.Variant('(dd)', (float(dx), float(dy))))

    def button(self, btn, down):
        self._rec('button', btn, down); self._call('NotifyPointerButton', GLib.Variant('(ib)', (btn, down)))
