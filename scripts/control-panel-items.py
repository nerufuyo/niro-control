#!/usr/bin/env python3
"""Builds the control panel's catalog from the schemas: docs/control-panel-items.{md,csv} and control/src/catalog.ts.

Every setting the panel shows is one item here (132 in all). The schemas are the source of truth for keys, types, ranges and
defaults; this script adds what a person sees (title, help, group), the control to use, and a few UI-only hints
(advanced, managed by Look, depends on). Run it again after a schema changes (`make catalog`)."""
import csv, json, re, xml.etree.ElementTree as ET
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
EXT = ROOT / 'shell'
SCHEMAS = {
    'niro': (ROOT / 'control/org.niro.control.gschema.xml', 'org.niro.control'),
    'island': (next((EXT / 'island/schemas').glob('*.gschema.xml')), 'org.gnome.shell.extensions.island'),
    'dock': (next((EXT / 'dock/schemas').glob('*.gschema.xml')), 'org.gnome.shell.extensions.dock'),
    'blur': (next((EXT / 'blur/schemas').glob('*.gschema.xml')), 'org.gnome.shell.extensions.blur-my-shell.applications'),
    'corners': (next((EXT / 'corners/schemas').glob('*.gschema.xml')), 'org.gnome.shell.extensions.rounded-window-corners-reborn'),
}
INTERNAL = {'update-shown', 'prefs-page', 'focus-dnd-owned', 'focus-dnd-declined', 'agents-announced', 'app-usage-clear',
            'event-calendar', 'clipboard-ignored-apps', 'check-updates'}
UNITS = {'icon-size': 'px', 'dock-border-radius': 'px', 'preview-scale': 'px', 'animation-duration': 'ms', 'hover-delay': 'ms',
         'notch-depth': 'px', 'auto-hide-delay': 's', 'event-alert-minutes': 'min', 'show-threshold': 'px',
         'magnification-falloff': 'px', 'usage-warn': '%', 'usage-critical': '%', 'dock-opacity': '%', 'glass-tint': '%',
         'top-bar-opacity': '%', 'border-width': 'px', 'opacity': '%', 'blur-strength': '%', 'magnification-framerate': 'fps'}
# Whole numbers that are really choices (the schema gives the meaning in its help text).
ENUMS = {'dock-position': ['Bottom', 'Left', 'Right', 'Top'], 'dock-workspace-mode': ['All workspaces', 'Current workspace only'],
         'running-indicator-style': ['Dots, one per window', 'Bar'], 'show-applications-button-position': ['Start', 'End']}
RANGES = {'icon-size': (16, 128), 'dock-border-radius': (0, 40), 'animation-duration': (0, 1000), 'magnification-falloff': (40, 300),
          'magnification-framerate': (15, 144), 'icon-quality': (0, 4), 'show-threshold': (0, 200), 'preview-scale': (100, 400),
          'magnification-scale': (1.0, 3.0), 'dock-opacity': (0, 100)}
SLIDERS = {'opacity', 'blur-strength', 'dock-opacity', 'glass-tint', 'top-bar-opacity', 'usage-warn', 'usage-critical'}
ADVANCED = {'custom-css', 'dock-background-color', 'icon-quality', 'show-threshold', 'magnification-framerate', 'animation-duration',
            'voice-claude-model', 'voice-codex-model', 'voice-grok-model', 'voice-opencode-model', 'voice-agy-model',
            'voice-speech-model', 'voice-language', 'bot-glow', 'border-width', 'skip-libhandy-app', 'whitelist', 'blacklist',
            'notch-depth', 'hover-delay', 'auto-hide-delay'}
SHORTCUT_KEYS = re.compile(r'^(shortcut-|voice-shortcut|toggle-dock|focus-app-|search-shortcut)')
# Look owns these: the island, the dock and the windows copy them from org.niro.control (niroSync.ts).
MANAGED = {('island', 'glass-tint'): 'niro.opacity', ('dock', 'dock-opacity'): 'niro.opacity',
           ('dock', 'dock-blur-enabled'): 'niro.blur', ('dock', 'dock-background-color'): 'niro.tint',
           ('dock', 'custom-css'): 'niro.accent'}
# What switches a setting on or off: (setting, op, value). Only the control's sensitivity follows it.
DEPENDS = {
    'island.hover-delay': ('island.open-on', 'eq', 'hover'), 'island.auto-hide-delay': ('island.auto-hide', 'ne', 'off'),
    'island.event-alert-minutes': ('island.event-alerts', 'on', None),
    'island.alert-power': ('island.system-alerts', 'on', None), 'island.alert-network': ('island.system-alerts', 'on', None),
    'island.alert-bluetooth': ('island.system-alerts', 'on', None), 'island.alert-caps-lock': ('island.system-alerts', 'on', None),
    'island.alert-bluetooth-battery': ('island.alert-bluetooth', 'on', None), 'island.call-preview': ('island.call-activity', 'on', None),
    'dock.preview-scale': ('dock.window-previews', 'on', None), 'dock.magnification-scale': ('dock.magnification-enabled', 'on', None),
    'dock.magnification-falloff': ('dock.magnification-enabled', 'on', None), 'dock.running-indicator-style': ('dock.running-indicators', 'on', None),
    'dock.show-applications-button-position': ('dock.show-applications-button', 'on', None), 'dock.show-threshold': ('dock.auto-hide', 'on', None),
    'blur.whitelist': ('blur.enable-all', 'off', None), 'blur.blacklist': ('blur.enable-all', 'on', None),
    'niro.blur-strength': ('niro.blur', 'on', None),
}
for k in ('usage-claude', 'usage-codex', 'usage-grok', 'usage-warn', 'usage-critical'):
    DEPENDS[f'island.{k}'] = ('island.usage-enabled', 'on', None)

def clean(t):
    t = re.sub(r'&(apos|quot|amp|lt|gt);', lambda m: {'apos': "'", 'quot': '"', 'amp': '&', 'lt': '<', 'gt': '>'}[m[1]], t or '')
    return re.sub(r'\s+', ' ', t).strip()

def first_sentence(t, limit=150):
    s = re.split(r'(?<!e\.g\.)(?<!i\.e\.)(?<=[.!?])\s', t, maxsplit=1)[0]
    return s if len(s) <= limit else s[:limit].rsplit(' ', 1)[0] + '…'

def label(v):
    return v.replace('-', ' ').replace('_', ' ').capitalize()

def schema_keys(source):
    path, sid = SCHEMAS[source]
    for s in ET.parse(path).getroot().iter('schema'):
        if s.get('id') == sid:
            return {k.get('name'): k for k in s.iter('key')}

def island_group(k):
    if re.match(r'(shortcut-|voice-shortcut|super-v)', k): return 'Shortcuts'
    if re.match(r'(voice-|bot-)', k): return 'Voice Assistant'
    if re.match(r'usage-', k): return 'AI Usage'
    if re.match(r'agent-alerts', k): return 'AI Agents'
    if re.match(r'(alert-|system-alerts|event-|world-clocks|privacy-|call-|gnome-banners|replace-osd|alerts-over-fullscreen|chimes)', k): return 'Alerts'
    if re.match(r'(island-|open-|notch-|hover-|auto-hide|top-bar|compact|glass|clock-)', k): return 'Appearance and Behavior'
    if re.match(r'(lyrics|track-peek)', k): return 'Music'
    if k.startswith('clipboard'): return 'Clipboard'
    if k.startswith('focus-'): return 'Focus'
    return 'Pages and Features'

def dock_group(k):
    if re.match(r'(magnification|animation|bounce|icon-quality|show-threshold)', k): return 'Motion'
    if re.match(r'(dock-|icon-size|custom-css)', k): return 'Appearance'
    if re.match(r'(toggle-dock|focus-app|enable-keyboard)', k): return 'Shortcuts'
    if re.match(r'(window-previews|preview-scale|media-)', k): return 'Windows and Media'
    return 'Applications and Indicators'

def build(source, menu, name, group, k):
    typ = k.get('type')
    default = clean(k.findtext('default'))
    rng = k.find('range'); choices = [c.get('value') for c in k.iter('choice')]
    full = clean(k.findtext('description'))
    it = dict(id=f'{source}.{name}', menu=menu, group=group, title=clean(k.findtext('summary')) or label(name), help=first_sentence(full),
              detail=full, source=source, key=name, type=typ, default=default.strip("'\""), unit=UNITS.get(name, ''))
    if name in ENUMS:
        it.update(kind='select', options=[dict(value=i, label=l) for i, l in enumerate(ENUMS[name])])
    elif choices:
        it.update(kind='select', options=[dict(value=c, label=label(c)) for c in choices])
    elif typ == 'b':
        it['kind'] = 'switch'
    elif typ in ('i', 'u', 'x', 'd'):
        lo = hi = None
        if rng is not None: lo, hi = float(rng.get('min')), float(rng.get('max'))
        elif name in RANGES: lo, hi = RANGES[name]
        else:
            m = re.search(r'\((-?\d+)\s*[-–]\s*(\d+)\)', full)
            if m: lo, hi = float(m[1]), float(m[2])
        d = typ == 'd'
        it.update(kind='slider' if name in SLIDERS and lo is not None else 'stepper', digits=2 if d else 0,
                  step=0.05 if d else 1, min=lo if lo is not None else (0 if d else -2147483648),
                  max=hi if hi is not None else (100 if d else 2147483647))
    elif typ == 'as':
        it['kind'] = 'shortcut' if SHORTCUT_KEYS.match(name) else 'list'
    elif typ == 's':
        it['kind'] = 'color' if (name in ('accent', 'tint') or (name.endswith('color') and default.strip("'\"").startswith('#'))) else \
            'textarea' if name == 'custom-css' else 'text'
    else:
        it['kind'] = 'text'
    if name in ADVANCED: it['advanced'] = True
    if (source, name) in MANAGED:
        it['managed'] = MANAGED[(source, name)]
    if it['id'] in DEPENDS:
        s, op, v = DEPENDS[it['id']]; it['depends'] = dict(id=s, op=op, **({'value': v} if v else {}))
    return it

items = []
# Look (and the search shortcut, which has its own menu)
for name, k in schema_keys('niro').items():
    grp = 'Tone' if name in ('accent', 'tint') else 'Glass'
    if name == 'search-shortcut':
        items.append(build('niro', 'Search', name, 'Application Search', k)); continue
    items.append(build('niro', 'Look', name, grp, k))
# Island
for name, k in schema_keys('island').items():
    if name in INTERNAL or re.match(r'(Internal|Deprecated)', clean(k.findtext('summary'))): continue
    items.append(build('island', 'Island', name, island_group(name), k))
# Dock: Focus app 1 to 10 is one item (ten shortcuts)
for name, k in schema_keys('dock').items():
    if re.match(r'focus-app-(\d+)$', name):
        if name != 'focus-app-1': continue
        it = build('dock', 'Dock', name, 'Shortcuts', k)
        it.update(id='dock.focus-app', key='focus-app', title='Focus app 1 to 10', kind='shortcuts', count=10,
                  help='Focus the Nth app in the dock: Super+1 to Super+0 by default', detail='')
        items.append(it); continue
    items.append(build('dock', 'Dock', name, dock_group(name), k))

# Windows: written by hand, over the real keys (the schemas' own texts for them are developer notes)
def win(source, key, title, help='', group='Window Blur', path=None, kind=None, **extra):
    k = schema_keys(source)[key]
    it = build(source, 'Windows', key, group, k)
    it.update(title=title, help=help, detail=help, group=group)
    if path: it.update(id=f'{source}.{key}.{".".join(path)}', path=path)
    if kind: it['kind'] = kind
    it.update(extra)
    if (source, key) in MANAGED: it.pop('managed', None)
    return it

def managed(niro_key, title, help):
    k = schema_keys('niro')[niro_key]
    it = build('niro', 'Windows', niro_key, 'Window Blur', k)
    it.update(id=f'windows.{niro_key}', title=title, help=help, detail=help, managed=f'niro.{niro_key}', group='Window Blur')
    it.pop('depends', None)
    return it

items += [
    managed('blur', 'Blur windows', 'Frosted glass behind application windows. Set in Look.'),
    win('blur', 'enable-all', 'Blur every app by default', 'Off: only the apps listed under "Only blur these".'),
    win('blur', 'whitelist', 'Only blur these apps', 'Window classes, used when "every app" is off.', advanced=True),
    win('blur', 'blacklist', 'Never blur these apps', 'Window classes: video players and the like.', advanced=True),
    managed('opacity', 'Window opacity over the blur', 'How see-through the windows are. Set in Look.'),
    win('blur', 'dynamic-opacity', 'Keep the focused window opaque'),
    win('blur', 'unblur-when-fullscreen', 'Unblur full-screen apps'),
    win('blur', 'blur-menus', 'Blur application menus', 'GTK popovers and the like.'),
    win('blur', 'blur-on-overview', 'Blur apps in the overview'),
    managed('blur-strength', 'Blur strength', 'How strong the blur is: the blur radius of the default pipeline. Set in Look.'),
]
G = 'global-rounded-corner-settings'
def corner(path, title, kind, typ, default, **extra):
    k = schema_keys('corners')[G]
    it = build('corners', 'Windows', G, 'Rounded Corners', k)
    it.update(id=f'corners.{G}.{".".join(path)}', path=path, title=title, help='', detail='', kind=kind, type=typ, default=default,
              group='Rounded Corners')
    it['unit'] = ''
    it.update(extra)
    it.pop('depends', None)
    if kind == 'switch': it.pop('options', None)
    return it
cr = []
cr.append(corner(['enabled'], 'Round window corners', 'switch', 'b', 'true'))
cr.append(corner(['borderRadius'], 'Corner radius', 'stepper', 'u', '12', min=0, max=40, step=1, digits=0, unit='px'))
cr.append(corner(['keepRoundedCorners', 'maximized'], 'Keep corners on maximized windows', 'switch', 'b', 'false'))
cr.append(corner(['keepRoundedCorners', 'fullscreen'], 'Keep corners on full-screen windows', 'switch', 'b', 'false'))
for it in cr[1:]:
    it['depends'] = dict(id=f'corners.{G}.enabled', op='on')
items += cr
items += [
    win('corners', 'skip-libadwaita-app', 'Skip GTK 4 (libadwaita) apps', 'They round their own corners.', group='Rounded Corners'),
    win('corners', 'skip-libhandy-app', 'Skip libhandy apps', group='Rounded Corners', advanced=True),
    win('corners', 'border-width', 'Border width', group='Rounded Corners', advanced=True, kind='stepper', unit='px'),
    win('corners', 'blacklist', 'Never round these apps', 'Window classes.', group='Rounded Corners', advanced=True),
]
sh = build('corners', 'Windows', 'focused-shadow', 'Rounded Corners', schema_keys('corners')['focused-shadow'])
sh.update(id='corners.shadows', key='focused-shadow', title='Window shadow', help='Focused and unfocused windows: offset, blur, spread and opacity.',
          detail='', kind='dict', advanced=True, fields=['horizontalOffset', 'verticalOffset', 'blurOffset', 'spreadRadius', 'opacity'],
          keys=['focused-shadow', 'unfocused-shadow'], default='', unit='')
items.append(sh)

# ---- checks
ids = [i['id'] for i in items]
assert len(ids) == len(set(ids)), 'duplicate ids'
from collections import Counter; print(dict(Counter(i['menu'] for i in items)), dict(Counter((i['menu'],i['group']) for i in items if i['menu']=='Dock')))
assert len(items) == 132, f'expected 132 items, got {len(items)}'
for i in items:
    assert '&' not in re.sub(r'&\s', '', i['title'] + i['help']) or '&apos;' not in i['title'], i

# ---- outputs
(ROOT / 'control/src/catalog.ts').write_text(
    '// Generated by scripts/control-panel-items.py from the schemas: do not edit. `make catalog` writes it again.\n'
    "import type {Item} from './types.js';\n\nexport const CATALOG: Item[] = " + json.dumps(items, indent=1, ensure_ascii=False) + ';\n')

# the search finds settings by their titles: the same list, trimmed, for the shell extension
idx = [dict(id=i['id'], menu=i['menu'], group=i['group'], title=i['title'], help=i['help'], key=i['key'], kind=i['kind'], managed=bool(i.get('managed')))
       for i in items]
(ROOT / 'shell/search/settings-index.ts').write_text(
    '// Generated by scripts/control-panel-items.py: do not edit. `make catalog` writes it again.\n'
    "import type {Item} from './types.js';\n\nexport const INDEX = " + json.dumps(idx, indent=1, ensure_ascii=False) + ' as unknown as Item[];\n')

with open(ROOT / 'docs/control-panel-items.csv', 'w', newline='') as f:
    w = csv.writer(f); w.writerow(['menu', 'group', 'item', 'control', 'choices_or_range', 'default', 'help', 'key', 'id'])
    for i in items:
        opts = ' / '.join(str(o['label']) for o in i.get('options', [])) or (f"{i['min']:g}–{i['max']:g}" if 'min' in i and i['min'] > -2147483648 and i['max'] < 2147483647 else '')
        w.writerow([i['menu'], i['group'], i['title'], i['kind'], opts, i['default'], i['help'], i['key'], i['id']])

order = ['Look', 'Island', 'Dock', 'Windows', 'Search']
md = ['# Control panel: every item\n', 'Generated by `scripts/control-panel-items.py`: one row per setting (132). The panel builds itself from',
      '`control/src/catalog.ts`, which the same script writes, so this list and the UI cannot drift apart.\n']
for m in order:
    md.append(f'\n## {m}\n')
    groups = []
    for i in items:
        if i['menu'] == m and i['group'] not in groups: groups.append(i['group'])
    for g in groups:
        md.append(f'\n### {g}\n\n| Item | Control | Choices / range | Default | Notes |\n|---|---|---|---|---|')
        for i in items:
            if i['menu'] == m and i['group'] == g:
                opts = ' / '.join(str(o['label']) for o in i.get('options', [])) or (f"{i['min']:g}–{i['max']:g}" if 'min' in i and i['min'] > -2147483648 and i['max'] < 2147483647 else '')
                notes = ', '.join(x for x in [('managed in Look' if i.get('managed') else ''), ('advanced' if i.get('advanced') else ''),
                                              (f"needs {i['depends']['id']}" if i.get('depends') else '')] if x)
                md.append(f"| {i['title']} | {i['kind']} | {opts} | {i['default']} | {notes} |")
(ROOT / 'docs/control-panel-items.md').write_text('\n'.join(md) + '\n')
from collections import Counter
print(len(items), 'items;', dict(Counter(i['menu'] for i in items)))
