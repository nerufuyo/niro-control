#!/usr/bin/env python3
"""Starts island-daemon on a private session bus and checks that every D-Bus interface the island's code expects
(shell/island/src/daemon.ts) exists with the same methods, signals, properties and signatures. Exit 1 on any difference.
Usage: scripts/check-dbus-interfaces.py [path to island-daemon]"""
import os, re, subprocess, sys, tempfile, xml.etree.ElementTree as ET

root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
daemon = sys.argv[1] if len(sys.argv) > 1 else os.path.join(root, 'target/release/island-daemon')
inner = f'''{daemon} >/dev/null 2>&1 & P=$!; sleep 3
busctl --user introspect --xml-interface org.niro.island.Daemon /org/niro/island/Daemon; kill $P'''
with tempfile.TemporaryDirectory() as home:
    env = {**os.environ, 'XDG_DATA_HOME': home, 'XDG_CONFIG_HOME': home, 'XDG_CACHE_HOME': home, 'XDG_STATE_HOME': home}
    real = subprocess.run(['dbus-run-session', '--', 'bash', '-c', inner], capture_output=True, text=True, env=env, timeout=60).stdout
real = re.sub(r'<!--.*?-->', '', real, flags=re.S)
real = re.sub(r'<!DOCTYPE[^>]*>', '', real)

def sigs(interface):
    out = {}
    for e in interface:
        if e.tag == 'property':
            out[('property', e.get('name'))] = e.get('type')
        elif e.tag == 'method':
            out[('method', e.get('name'))] = ''.join(a.get('type') for a in e.findall('arg') if a.get('direction', 'in') == 'in')
        elif e.tag == 'signal':
            out[('signal', e.get('name'))] = ''.join(a.get('type') for a in e.findall('arg'))
    return out

daemon_side = {i.get('name'): sigs(i) for i in ET.fromstring(real).iter('interface') if i.get('name', '').startswith('org.niro.island.')}
source = open(os.path.join(root, 'shell/island/src/daemon.ts')).read()
problems, seen = 0, set()
for name, body in re.findall(r"node\('([A-Za-z0-9]+)',\s*`(.*?)`\)", source, re.S):
    full = 'org.niro.island.' + name
    seen.add(full)
    expected = sigs(ET.fromstring('<i>' + re.sub(r'<!--.*?-->', '', body, flags=re.S) + '</i>'))
    if full not in daemon_side:
        print('missing interface', full); problems += 1; continue
    for key, signature in expected.items():
        if key not in daemon_side[full]:
            print('the island expects, the daemon lacks:', full, key); problems += 1
        elif daemon_side[full][key] != signature:
            print('signature differs:', full, key, signature, daemon_side[full][key]); problems += 1
print(f'{len(seen)} interfaces the island uses, {len(daemon_side)} in the daemon, {problems} problem(s)')
sys.exit(1 if problems or not seen else 0)
