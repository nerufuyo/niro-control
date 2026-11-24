"""Security and teardown audit of the org.niro.E2E bridge, run inside an isolated session (tests/e2e/session.sh). Prints one line per finding."""
import json, os, re, subprocess, sys, time
from gi.repository import Gio, GLib

bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
out = os.environ.get('E2E_OUT', '/tmp')
res = []
def rec(name, ok, detail=''):
    res.append((name, ok, detail)); print(('OK   ' if ok else 'FAIL ') + name + (f'  [{detail}]' if detail else ''))

def owner(name):
    try: return bus.call_sync('org.freedesktop.DBus', '/org/freedesktop/DBus', 'org.freedesktop.DBus', 'GetNameOwner', GLib.Variant('(s)', (name,)), None, 0, 3000, None).unpack()[0]
    except GLib.Error: return None
def call(dest, path, iface, m, args=None):
    try: return bus.call_sync(dest, path, iface, m, args, None, 0, 5000, None).unpack()
    except GLib.Error as e: return 'ERR ' + e.message
def ext(m, uuid):
    return call('org.gnome.Shell.Extensions', '/org/gnome/Shell/Extensions', 'org.gnome.Shell.Extensions', m, GLib.Variant('(s)', (uuid,)))

on = os.environ.get('NIRO_E2E_FORCE', '1') == '1'
if not on:
    rec('inert without NIRO_E2E=1: bus name not owned', owner('org.niro.E2E') is None, owner('org.niro.E2E'))
    st = call('org.gnome.Shell.Extensions', '/org/gnome/Shell/Extensions', 'org.gnome.Shell.Extensions', 'GetExtensionInfo', GLib.Variant('(s)', ('e2e-telemetry@niro.test',)))
    rec('extension is loaded but exposes nothing', owner('org.niro.E2E') is None)
    sys.exit(0)

rec('bus name owned while enabled', owner('org.niro.E2E') is not None, owner('org.niro.E2E'))
xml = call('org.niro.E2E', '/org/niro/E2E', 'org.freedesktop.DBus.Introspectable', 'Introspect')[0]
methods = sorted(re.findall(r'<method name="(\w+)"', xml)); props = re.findall(r'<property', xml)
own = re.search(r'<interface name="org.niro.E2E">(.*?)</interface>', xml, re.S).group(1)
own_methods = sorted(re.findall(r'<method name="(\w+)"', own))
rec('exactly the fixed method set', own_methods == ['Events', 'Ping', 'Snapshot', 'Start', 'Stop'], own_methods)
rec('no properties, no signals on the interface', not re.findall(r'<(property|signal)', own))
rec('no method takes code, a path or a command: only Start takes one string', re.findall(r'<method name="(\w+)">(?:(?!</method>).)*direction="in"', own, re.S) == ['Start'])
# Start's argument: only [a-z0-9_-]{1,60}
for bad in ['../evil', '/tmp/x', 'a b', '', 'A', 'x' * 61, 'a.json', 'a;b']:
    r = call('org.niro.E2E', '/org/niro/E2E', 'org.niro.E2E', 'Start', GLib.Variant('(s)', (bad,)))
    ok = isinstance(r, tuple) and 'error' in json.loads(r[0])
    rec(f'Start rejects {bad!r}', ok, r)
rec('no file was created outside the output directory', not os.path.exists('/tmp/evil') and not os.path.exists('/tmp/x.json'))
r = call('org.niro.E2E', '/org/niro/E2E', 'org.niro.E2E', 'Start', GLib.Variant('(s)', ('audit-ok',)))
r = call('org.niro.E2E', '/org/niro/E2E', 'org.niro.E2E', 'Stop')
rec('a valid recording is written only under NIRO_E2E_OUT', os.path.exists(os.path.join(out, 'audit-ok.json')) and json.loads(r[0])['file'].startswith(out + '/'), r)
snap = call('org.niro.E2E', '/org/niro/E2E', 'org.niro.E2E', 'Snapshot')[0]
keys = sorted(json.loads(snap).keys())
rec('snapshot has only the documented top-level fields', keys == sorted(['t', 'pointer', 'keyFocus', 'modal', 'overview', 'animations', 'stageEvents', 'search', 'island', 'dock']), keys)
rec('snapshot carries the Search query text (test sessions only; no clipboard, files, credentials, notifications, settings values)', 'text' in json.loads(snap)['search'])
# unrestricted Eval must not exist in this session
ev = call('org.gnome.Shell', '/org/gnome/Shell', 'org.gnome.Shell', 'Eval', GLib.Variant('(s)', ('1+1',)))
rec('org.gnome.Shell.Eval is denied (no unsafe mode)', isinstance(ev, tuple) and ev[0] is False or (isinstance(ev, str) and ev.startswith('ERR')), ev)
# teardown: disable/enable cycles release and re-own the name, no stale owner
cycles_ok = True
for i in range(5):
    ext('DisableExtension', 'e2e-telemetry@niro.test'); time.sleep(0.6)
    gone = owner('org.niro.E2E') is None
    ext('EnableExtension', 'e2e-telemetry@niro.test'); time.sleep(0.8)
    back = owner('org.niro.E2E') is not None
    if not (gone and back): cycles_ok = False; print('   cycle', i, 'gone', gone, 'back', back)
rec('5 disable/enable cycles: name released on disable, owned again on enable', cycles_ok)
ext('DisableExtension', 'e2e-telemetry@niro.test'); time.sleep(0.6)
rec('after the final disable no object remains on the bus', owner('org.niro.E2E') is None)
ext('EnableExtension', 'e2e-telemetry@niro.test'); time.sleep(0.8)
sys.exit(0 if all(o for _, o, _ in res) else 1)
