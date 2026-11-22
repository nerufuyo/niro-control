#!/usr/bin/env python3
"""Builds the control panel's catalog from the schemas: docs/control-panel-items.{md,csv} and control/src/catalog.ts.

Every setting the panel shows is one item here (243 in all). The schemas are the source of truth for keys, types, ranges and
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
    'tile': (next((EXT / 'tile/schemas').glob('*.gschema.xml')), 'org.gnome.shell.extensions.tile'),
    'emoji': (next((EXT / 'emoji/schemas').glob('*.gschema.xml')), 'org.gnome.shell.extensions.emoji-copy'),
}
INTERNAL = {'update-shown', 'prefs-page', 'focus-dnd-owned', 'focus-dnd-declined', 'agents-announced', 'app-usage-clear',
            'event-calendar', 'clipboard-ignored-apps', 'check-updates'}
UNITS = {'icon-size': 'px', 'dock-border-radius': 'px', 'preview-scale': 'px', 'animation-duration': 'ms', 'hover-delay': 'ms',
         'notch-depth': 'px', 'auto-hide-delay': 's', 'event-alert-minutes': 'min', 'show-threshold': 'px', 'icon-spacing': 'px', 'dock-padding': 'px',
         'magnification-falloff': 'px', 'usage-warn': '%', 'usage-critical': '%', 'dock-opacity': '%', 'glass-tint': '%',
         'top-bar-opacity': '%', 'border-width': 'px', 'opacity': '%', 'blur-strength': '%', 'magnification-framerate': 'fps'}
# Whole numbers that are really choices (the schema gives the meaning in its help text).
ENUMS = {'dock-position': ['Bottom', 'Left', 'Right', 'Top'], 'dock-workspace-mode': ['All workspaces', 'Current workspace only'],
         'running-indicator-style': ['Dots, one per window', 'Bar'], 'show-applications-button-position': ['Start', 'End']}
RANGES = {'icon-size': (16, 128), 'icon-spacing': (0, 24), 'dock-padding': (2, 40), 'dock-border-radius': (0, 40), 'animation-duration': (0, 1000), 'magnification-falloff': (40, 300),
          'magnification-framerate': (15, 144), 'icon-quality': (0, 4), 'show-threshold': (0, 200), 'preview-scale': (100, 400),
          'magnification-scale': (1.0, 3.0), 'dock-opacity': (0, 100)}
SLIDERS = {'icon-size', 'icon-spacing', 'dock-padding', 'opacity', 'blur-strength', 'dock-opacity', 'glass-tint', 'top-bar-opacity', 'usage-warn', 'usage-critical'}
ADVANCED = {'app-rules', 'legacy-global-fade', 'custom-css', 'dock-background-color', 'icon-quality', 'show-threshold', 'magnification-framerate', 'animation-duration',
            'voice-claude-model', 'voice-codex-model', 'voice-grok-model', 'voice-opencode-model', 'voice-agy-model',
            'voice-speech-model', 'voice-language', 'bot-glow', 'border-width', 'skip-libhandy-app', 'whitelist', 'blacklist',
            'notch-depth', 'hover-delay', 'auto-hide-delay'}
SHORTCUT_KEYS = re.compile(r'^(shortcut-|voice-shortcut|toggle-dock|focus-app-|search-shortcut|snip-shortcut|switcher-shortcut|emoji-keybind)')
# Look owns these: the island, the dock and the windows copy them from org.niro.control (niroSync.ts).
MANAGED = {('island', 'glass-tint'): 'niro.opacity', ('dock', 'dock-opacity'): 'niro.opacity',
           ('dock', 'dock-blur-enabled'): 'niro.blur', ('dock', 'dock-background-color'): 'niro.tint',
           ('dock', 'custom-css'): 'niro.accent'}
# What switches a setting on or off: (setting, op, value). Only the control's sensitivity follows it.
# Each rule was checked against the extension's code (2026-11): a rule stays only where the code ties the two settings together.
# Dropped as unsupported: alert-* on system-alerts (system-alerts is a pre-0.7 switch the island resets to on at start-up, each alert has its
# own switch); alert-bluetooth-battery on alert-bluetooth (bluetooth_low answers to its own switch); niro.blur-strength on niro.blur
# (the strength is applied to the blur whether or not blur is on).
UNIVERSAL = {'app-rules', 'legacy-global-fade', 'shell-surfaces', 'universal-enabled', 'preset', 'sidebar-opacity', 'content-opacity', 'elevated-opacity', 'color-scheme', 'performance-mode', 'affect-shell', 'affect-gtk', 'affect-thirdparty', 'safe-mode'}
DEPENDS = {
    'niro.adaptive-live': ('niro.adaptive-suggestions', 'on', None),
    'niro.smart-clipboard-minutes': ('niro.smart-clipboard', 'on', None), 'niro.notification-hub-apply': ('niro.notification-hub', 'on', None),
    'niro.privacy-history': ('niro.privacy-dashboard', 'on', None),
    'island.hover-delay': ('island.open-on', 'eq', 'hover'), 'island.auto-hide-delay': ('island.auto-hide', 'ne', 'off'),
    'island.event-alert-minutes': ('island.event-alerts', 'on', None),
    'island.call-preview': ('island.call-activity', 'on', None),
    'dock.preview-scale': ('dock.window-previews', 'on', None), 'dock.magnification-scale': ('dock.magnification-enabled', 'on', None),
    'dock.magnification-falloff': ('dock.magnification-enabled', 'on', None), 'dock.running-indicator-style': ('dock.running-indicators', 'on', None),
    'dock.show-applications-button-position': ('dock.show-applications-button', 'on', None), 'dock.show-threshold': ('dock.auto-hide', 'on', None),
    'blur.whitelist': ('blur.enable-all', 'off', None), 'blur.blacklist': ('blur.enable-all', 'on', None),
}
# Rules whose link is only reasoned from the wiring, not seen in code: the panel shows them as a hint and never disables the row.
UNVERIFIED = {'dock.show-threshold', 'island.call-preview', 'island.auto-hide-delay'}
for k in ('usage-claude', 'usage-codex', 'usage-grok', 'usage-opencode', 'usage-deepseek', 'usage-warn', 'usage-critical'):
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
    if re.match(r'(alert-|system-alerts|event-|world-clocks|privacy-|call-|gnome-banners|replace-osd|fullscreen-alerts|fullscreen-reveal|chimes)', k): return 'Alerts'
    if re.match(r'(island-|motion-|open-|notch-|hover-|auto-hide|top-bar|hide-top-bar|compact|glass|clock-)', k): return 'Appearance and Behavior'
    if re.match(r'(lyrics|track-peek)', k): return 'Music'
    if k.startswith('clipboard'): return 'Clipboard'
    if k.startswith('focus-'): return 'Focus'
    return 'Pages and Features'

def dock_group(k):
    if re.match(r'(magnification|animation|bounce|icon-quality|show-threshold)', k): return 'Motion'
    if re.match(r'(dock-|icon-size|icon-spacing|icon-theme|icon-style|icon-color|app-button-icon|custom-css)', k): return 'Appearance'
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
            'textarea' if name in ('custom-css', 'app-rules') else 'text'
    else:
        it['kind'] = 'text'
    if name == 'icon-theme' and source == 'dock':
        it.update(kind='select', options=[dict(value='', label='System default')], dynamic='icon-themes')
    if name in ADVANCED: it['advanced'] = True
    if (source, name) in MANAGED:
        it['managed'] = MANAGED[(source, name)]
    if it['id'] in DEPENDS:
        s, op, v = DEPENDS[it['id']]; it['depends'] = dict(id=s, op=op, **({'value': v} if v else {}), **({'unverified': True} if it['id'] in UNVERIFIED else {}))
    return it

SYSTEM_EXPERIENCE = ('smart-clipboard', 'smart-clipboard-minutes', 'notification-hub', 'notification-hub-apply', 'perf-recording', 'privacy-dashboard',
                     'privacy-history', 'audio-router', 'universal-hud', 'shelf-collections', 'widgets-in-search', 'flow-events')
items = []
# Look (and the search shortcut, which has its own menu)
for name, k in schema_keys('niro').items():
    if name in ('legacy-window-opacity', 'shell-surfaces-backup'): continue   # internal bookkeeping
    grp = 'Tone' if name in ('accent', 'tint') else 'Universal Appearance' if name in UNIVERSAL else 'Glass'
    if name == 'search-shortcut':
        items.append(build('niro', 'Search', name, 'Application Search', k)); continue
    if name.startswith('snip-'):
        items.append(build('niro', 'Search', name, 'Screenshots', k)); continue
    if name.startswith(('theme-', 'dnd-')): grp = 'Schedule'
    if name in ('adaptive-suggestions', 'adaptive-live', 'permissions-enforced', 'tools-above-apps', 'world-clock-cities', 'search-language', 'weather-days', 'kill-protected'):
        items.append(build('niro', 'Search', name, 'Search Behaviour', k)); continue
    if name in SYSTEM_EXPERIENCE:
        items.append(build('niro', 'Search', name, 'System Experience', k)); continue
    if name == 'switcher-shortcut':
        items.append(build('niro', 'Search', name, 'Window Switcher', k)); continue
    if name == 'ha-url':
        items.append(build('niro', 'Search', name, 'Home Assistant', k)); continue
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

# Tiling: every key of the tile schema, with the schema's own texts
for name, k in schema_keys('tile').items():
    if name in ('layout-map', 'window-rules'): continue   # data the panel's own pages edit
    items.append(build('tile', 'Windows', name, 'Tiling', k))
LAYOUT_LABELS = {'dwindle': 'Dwindle (BSP)', 'master-left': 'Master left', 'master-right': 'Master right', 'center-master': 'Center master', 'grid': 'Grid',
                 'three-columns': 'Three columns', 'horizontal': 'Horizontal split', 'vertical': 'Vertical split', 'scrolling': 'Scrolling', 'monocle': 'Monocle'}
for it in items:
    if it['id'] == 'tile.layout':
        for o in it['options']: o['label'] = LAYOUT_LABELS[o['value']]
    if it['source'] == 'tile' and it['key'] not in ('enabled',):
        it['depends'] = dict(id='tile.enabled', op='on')
    if it['id'] == 'tile.floating-apps': it['advanced'] = True
    if it['id'] == 'tile.master-factor': it.update(step=0.05, digits=2)
    if it['id'] == 'tile.column-width': it.update(step=0.05, digits=2)

# The emoji picker (Super+. and Super+;): its keys, with their own titles (the schema's texts are developer notes)
def emoji_item(key, title, help, **extra):
    it = build('emoji', 'Search', key, 'Emoji Picker', schema_keys('emoji')[key])
    it.update(title=title, help=help, detail=help, group='Emoji Picker')
    it.update(extra)
    return it
items += [
    emoji_item('emoji-keybind', 'Open the emoji picker', 'Super+. and Super+; by default, as on Windows. Add or change them here.'),
    emoji_item('active-keybind', 'Open with the shortcut', 'Off: the picker only opens from its icon in the top bar.'),
    emoji_item('always-show', 'Show the picker\'s icon', 'The smiley in the top bar. Off: only the shortcut opens it.'),
    emoji_item('window-location', 'Where it opens', 'Under the top bar, or next to the text cursor.', options=[dict(value='top-bar', label='Top bar'), dict(value='cursor', label='At the cursor')]),
    emoji_item('position', 'Order of the pieces', 'Search and the recent row above the emoji, or below them.', options=[dict(value='top', label='Search on top'), dict(value='bottom', label='Search at the bottom')]),
    emoji_item('nbcols', 'Emoji per row', 'How many emoji fit in a row of the picker.', min=6, max=16, unit=''),
    emoji_item('emojisize', 'Size of the emoji', 'In pixels.', min=18, max=56, unit='px'),
    emoji_item('recent-rows', 'Rows of recent emoji', 'How many rows of the emoji used last are kept above the list.'),
    emoji_item('paste-on-select', 'Paste when one is picked', 'Off: it is only copied, and you paste it yourself.'),
    emoji_item('keep-open', 'Stay open after a pick', 'Pick several in a row.'),
    emoji_item('copy-on-close', 'Copy several at once', 'Right-click or Shift+Enter collects; the whole is copied when the picker closes.'),
]

# ---- checks
ids = [i['id'] for i in items]
assert len(ids) == len(set(ids)), 'duplicate ids'
from collections import Counter; print(dict(Counter(i['menu'] for i in items)), dict(Counter((i['menu'],i['group']) for i in items if i['menu']=='Dock')))
assert len(items) == 243, f'expected 243 items, got {len(items)}'
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
md = ['# Control panel: every item\n', 'Generated by `scripts/control-panel-items.py`: one row per setting (186). The panel builds itself from',
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
