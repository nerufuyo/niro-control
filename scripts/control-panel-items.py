#!/usr/bin/env python3
"""Lists every setting the control panel can show (from the schemas) as docs/control-panel-items.{md,csv}."""
import csv, re, xml.etree.ElementTree as ET
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
INTERNAL = {'update-shown', 'prefs-page', 'focus-dnd-owned', 'focus-dnd-declined', 'agents-announced', 'app-usage-clear',
            'event-calendar', 'clipboard-ignored-apps', 'check-updates'}

def clean(t):
    t = re.sub(r'&(apos|quot|amp|lt|gt);', lambda m: {'apos': "'", 'quot': '"', 'amp': '&', 'lt': '<', 'gt': '>'}[m[1]], t or '')
    return re.sub(r'\s+', ' ', t).strip()

def keys(path, schema_id):
    for s in ET.parse(path).getroot().iter('schema'):
        if s.get('id') != schema_id:
            continue
        for k in s.iter('key'):
            name = k.get('name'); typ = k.get('type')
            default = clean(k.findtext('default'))
            choices = [c.get('value') for c in k.iter('choice')]
            rng = k.find('range')
            kind = ('switch' if typ == 'b' else 'choice' if choices else 'number' if typ in ('i', 'u', 'x', 'd')
                    else 'list' if typ.startswith('a') else 'text')
            opts = ' / '.join(choices) if choices else (f"{rng.get('min')}–{rng.get('max')}" if rng is not None else '')
            if name in ENUMS: kind, opts = 'choice', ENUMS[name]
            elif kind == 'number' and not opts:
                m = re.search(r'\((\d+)\s*[-–]\s*(\d+)\)', clean(k.findtext('description')))
                if m: opts = f'{m[1]}–{m[2]}'
            yield dict(key=name, type=kind, options=opts, default=default,
                       title=clean(k.findtext('summary')) or name, help=clean(k.findtext('description')))

ENUMS = {  # whole numbers that are really choices
    'dock-position': 'bottom / left / right / top', 'dock-workspace-mode': 'all workspaces / current workspace only',
    'running-indicator-style': 'dots (one per window) / bar', 'show-applications-button-position': 'start / end'}

def isle_group(k):
    if re.match(r'(shortcut-|voice-shortcut|super-v)', k): return 'Shortcuts'
    if re.match(r'(voice-|bot-)', k): return 'Voice assistant'
    if re.match(r'usage-', k): return 'AI usage'
    if re.match(r'agent-alerts', k): return 'AI agents'
    if re.match(r'(alert-|system-alerts|event-|world-clocks|privacy-|call-|gnome-banners|replace-osd|alerts-over-fullscreen|chimes)', k): return 'Alerts'
    if re.match(r'(island-|open-|notch-|hover-|auto-hide|top-bar|compact|glass|clock-)', k): return 'Island look and behaviour'
    if re.match(r'(lyrics|track-peek)', k): return 'Music'
    if re.match(r'(clipboard)', k): return 'Clipboard'
    if re.match(r'(focus-)', k): return 'Focus'
    return 'Pages and features'

def dock_group(k):
    if re.match(r'(magnification|animation|bounce|icon-quality|show-threshold)', k): return 'Motion'
    if re.match(r'(dock-|icon-size|custom-css)', k): return 'Appearance'
    if re.match(r'(toggle-dock|focus-app|enable-keyboard)', k): return 'Shortcuts'
    if re.match(r'(window-previews|preview-scale|media-)', k): return 'Windows and media'
    return 'Apps and indicators'

EXT = ROOT / 'shell'
menus = [  # menu, schema file, schema id, grouping, note
    ('Look', ROOT / 'control/org.niro.control.gschema.xml', 'org.niro.control', lambda k: 'Tone' if k in ('accent', 'tint') else 'Glass' if k in ('opacity', 'blur', 'blur-strength') else 'Search', ''),
    ('Island', next((EXT / 'island/schemas').glob('*.gschema.xml')), 'org.gnome.shell.extensions.island', isle_group, ''),
    ('Dock', next((EXT / 'dock/schemas').glob('*.gschema.xml')), 'org.gnome.shell.extensions.dock', dock_group, ''),
    ('Windows', next((EXT / 'blur/schemas').glob('*.gschema.xml')), 'org.gnome.shell.extensions.blur-my-shell.applications', lambda k: 'Window blur', ''),
    ('Windows', next((EXT / 'corners/schemas').glob('*.gschema.xml')), 'org.gnome.shell.extensions.rounded-window-corners-reborn', lambda k: 'Rounded corners', ''),
]
# The Windows menu is written by hand: the schemas' own texts for it are developer notes, not labels.
WINDOWS = [
    ('Window blur', 'Blur windows', 'switch', '', 'on', 'Frosted glass behind application windows', 'blur'),
    ('Window blur', 'Blur every app by default', 'switch', '', 'on', 'Off: only the apps in "Only blur these"', 'enable-all'),
    ('Window blur', 'Only blur these apps', 'list', 'app names', '[]', 'Used when "every app" is off', 'whitelist'),
    ('Window blur', 'Never blur these apps', 'list', 'app names', 'Plank, Conky, vlc, mpv, OBS…', 'Video players and the like', 'blacklist'),
    ('Window blur', 'Window opacity over the blur', 'number', '0–255', '225', 'Also set by Look > Opacity', 'opacity'),
    ('Window blur', 'Keep the focused window opaque', 'switch', '', 'off', '', 'dynamic-opacity'),
    ('Window blur', 'Unblur full-screen apps', 'switch', '', 'on', '', 'unblur-when-fullscreen'),
    ('Window blur', 'Blur application menus (popovers)', 'switch', '', 'off', '', 'blur-menus'),
    ('Window blur', 'Blur apps in the overview', 'switch', '', 'off', '', 'blur-on-overview'),
    ('Window blur', 'Blur strength', 'number', '0–100', '30', 'Set in Look > Blur strength', 'pipelines (blur radius)'),
    ('Rounded corners', 'Round window corners', 'switch', '', 'on', '', 'global-rounded-corner-settings.enabled'),
    ('Rounded corners', 'Corner radius', 'number', 'px', '12', '', 'global-rounded-corner-settings.borderRadius'),
    ('Rounded corners', 'Keep corners on maximized windows', 'switch', '', 'on', '', 'global-rounded-corner-settings.keepRoundedCorners.maximized'),
    ('Rounded corners', 'Keep corners on full-screen windows', 'switch', '', 'on', '', 'global-rounded-corner-settings.keepRoundedCorners.fullscreen'),
    ('Rounded corners', 'Skip GTK 4 (libadwaita) apps', 'switch', '', 'on', 'They round their own corners', 'skip-libadwaita-app'),
    ('Rounded corners', 'Skip libhandy apps', 'switch', '', 'off', '', 'skip-libhandy-app'),
    ('Rounded corners', 'Border width', 'number', '-40–40 px', '0', '', 'border-width'),
    ('Rounded corners', 'Never round these apps', 'list', 'app names', '[]', '', 'blacklist'),
    ('Rounded corners', 'Window shadow (focused / unfocused)', 'group', 'offset, blur, spread, opacity', '', 'Two sets of four numbers', 'focused-shadow / unfocused-shadow'),
]
rows = []
for g, title, typ, opts, default, hlp, key in WINDOWS:
    rows.append(dict(menu='Windows', group=g, key=key, type=typ, options=opts, default=default, title=title, help=hlp))
for menu, path, sid, group, _ in menus:
    if menu == 'Windows': continue
    for it in keys(path, sid):
        if it['key'] in INTERNAL or re.search(r'^\s*(Internal|Deprecated)', it['help'] + ' ' + it['title']):
            continue
        if re.match(r'focus-app-(\d+)$', it['key']):
            if it['key'] != 'focus-app-1': continue
            it.update(title='Focus app 1 to 10 shortcuts', help='Super+1 … Super+0 by default: focus the Nth app in the dock')
        rows.append(dict(menu=menu, group=group(it['key']), **it))

order = ['Look', 'Island', 'Dock', 'Windows']
IA = '''## Suggested menus

Sidebar, in this order: **Look** · **Island** · **Dock** · **Windows** · **Search** · About. Inside Island a second level
(Look and behaviour · Alerts · Music · Focus · Clipboard · Voice assistant · AI usage · Shortcuts · Pages) so that no page
is longer than one screen. Items the person changes rarely (shortcuts, colours as hex, CSS) sit under "Advanced".

Notes for the design:
- Titles and help below are the schemas' own texts; some arrive with HTML entities (`&quot;`) that must be decoded.
- "Choice" items are drop-downs or segmented controls; "number" items are steppers or sliders (range given); "list" items
  are keyboard shortcuts (a record-a-key control, not a text box).
- Opacity and Blur are set once in Look and copied to the dock and the windows; the same keys also exist in Dock and
  Windows, where they should be hidden or marked as managed by Look.
'''
md = ['# Control panel: every item\n', IA,
      'Generated by `scripts/control-panel-items.py` from the schemas. One row per setting: what the person sees (title, help),',
      'what kind of control it needs, its choices or range, its default, and the key behind it.\n']
for m in order:
    md.append(f'\n## {m}\n')
    groups = []
    for r in rows:
        if r['menu'] == m and r['group'] not in groups:
            groups.append(r['group'])
    for g in groups:
        md.append(f'\n### {g}\n\n| Item | Control | Choices / range | Default | Help |\n|---|---|---|---|---|')
        for r in rows:
            if r['menu'] == m and r['group'] == g:
                md.append(f"| {r['title']} | {r['type']} | {r['options']} | {r['default']} | {r['help'][:140].replace('|', '/')} |")
md.append('\n## Not settings, but actions\n\n- Look: preset tones (Ember, Ocean, Mint, Violet, Amber, Mono)\n- Island: open the full Island settings window\n- Search: shortcut\n')
(ROOT / 'docs/control-panel-items.md').write_text('\n'.join(md) + '\n')
with open(ROOT / 'docs/control-panel-items.csv', 'w', newline='') as f:
    w = csv.writer(f); w.writerow(['menu', 'group', 'item', 'control', 'choices_or_range', 'default', 'help', 'key'])
    for r in rows: w.writerow([r['menu'], r['group'], r['title'], r['type'], r['options'], r['default'], r['help'], r['key']])
from collections import Counter
print(Counter((r['menu'], r['group']) for r in rows))
print(len(rows), 'items')
