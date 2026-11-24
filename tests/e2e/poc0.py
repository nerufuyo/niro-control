import sys, json, time, subprocess
sys.path.insert(0, sys.argv[1] if len(sys.argv) > 1 else '.')
from gi.repository import Gio, GLib
bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
def tel(m, args=None):
    return bus.call_sync('org.niro.E2E', '/org/niro/E2E', 'org.niro.E2E', m, args, None, 0, 5000, None).unpack()[0]
print(tel('Ping'))
s = json.loads(tel('Snapshot'))
for k in ('pointer', 'keyFocus', 'modal', 'overview', 'animations', 'stageEvents'): print(k, s[k])
for k in ('search', 'island', 'dock'): print(k, json.dumps(s[k])[:300])
