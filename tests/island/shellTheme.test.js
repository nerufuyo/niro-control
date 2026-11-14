// The Shell stylesheet: narrow, no opacity, backgrounds above the floors, readable under the shell's own white text.
import assert from 'node:assert/strict';
import {test} from 'node:test';

import {FLOORS} from '../../control/build/appearance.js';
import {contrast} from '../../control/build/appearanceTokens.js';
import {baseColor, isDarkSurface, SHELL_SELECTORS, shellStylesheet} from '../../control/build/shellTheme.js';

const allDark = {panel: true, popup: true, quick: true, overview: true};
const look = {accent: '#E8472B', tint: '#1C1C1E', sidebar: 70, content: 85, elevated: 92, dark: allDark};

test('only the allowed selectors are touched, and nothing sets a foreground colour or an opacity', () => {
    const css = shellStylesheet(look);
    const selectors = [...css.matchAll(/^([^/\n{][^{]*)\{/gm)].flatMap(m => m[1].split(',').map(s => s.trim()));
    for (const s of selectors) assert.ok(SHELL_SELECTORS.includes(s), `unexpected selector ${s}`);
    assert.ok(!/(^|[;{\s])color:/.test(css), 'a foreground colour is set');
    assert.ok(!/opacity/.test(css), 'an opacity is set');
    assert.ok(!/transition|animation/.test(css), 'motion is left to GNOME (reduced motion)');
});

test('accent and tint propagate; a light tint or nonsense falls back to the neutral base', () => {
    assert.match(shellStylesheet(look), /quick-toggle:checked[^}]*rgba\(232, 71, 43, 1\)/);
    assert.match(shellStylesheet({...look, accent: '#33AA55'}), /rgba\(51, 170, 85, 1\)/);
    assert.deepEqual(baseColor('#101820'), [16, 24, 32]);
    assert.deepEqual(baseColor('#FFFFFF'), [28, 28, 34]);
    assert.deepEqual(baseColor('nonsense'), [28, 28, 34]);
    assert.match(shellStylesheet({...look, tint: '#101820'}), /rgba\(16, 24, 32/);
    assert.match(shellStylesheet({...look, accent: 'bad'}), /rgba\(232, 71, 43, 1\)/);
});

test('solid and safe mode give opaque surfaces; values below the floors are lifted', () => {
    const solid = shellStylesheet({...look, sidebar: 100, content: 100, elevated: 100});
    assert.match(solid, /#panel \{ background-color: rgba\(28, 28, 30, 1\)/);
    assert.match(solid, /\.popup-menu-content[^}]*rgba\(36, 36, 38, 1\)/);
    assert.match(solid, /\.search-entry \{ background-color: rgba\(28, 28, 30, 1\)/);
    const low = shellStylesheet({...look, sidebar: 0, content: 0, elevated: 0});
    assert.match(low, /#panel \{ background-color: rgba\(28, 28, 30, 0\.7\)/);
    assert.match(low, /\.popup-menu-content[^}]*rgba\(36, 36, 38, 0\.8\)/);
    assert.match(low, /\.search-entry \{ background-color: rgba\(28, 28, 30, 0\.7\)/);
});

test('the shell\'s white text stays readable on every surface over black, white and mid wallpapers at the floors', () => {
    const base = baseColor('#1C1C1E');
    const over = (c, a, below) => c.map((v, i) => Math.round(v * a + below[i] * (1 - a)));
    for (const wall of [[0, 0, 0], [255, 255, 255], [128, 128, 128], [220, 40, 40]]) {
        for (const [name, c, a] of [['panel', base, 0.70], ['content', base, FLOORS.content / 100], ['popup', base.map(v => Math.min(255, v + 8)), FLOORS.elevated / 100]]) {
            const bg = over(c, a, wall);
            assert.ok(contrast([255, 255, 255], bg) >= 4.5, `${name} over ${wall}: ${contrast([255, 255, 255], bg).toFixed(2)}`);
        }
    }
});

test('the surface follows the shell theme\'s own text colour: light text gets dark glass, dark text gets light glass', () => {
    assert.equal(isDarkSurface({r: 1, g: 1, b: 1}), true);
    assert.equal(isDarkSurface({r: 0.93, g: 0.93, b: 0.93}), true);
    assert.equal(isDarkSurface({r: 0, g: 0, b: 0}), false);
    assert.equal(isDarkSurface({r: 0.18, g: 0.2, b: 0.21}), false);      // Yaru light's text
    const light = shellStylesheet({...look, dark: {panel: true, popup: false, quick: false, overview: false}});
    assert.match(light, /#panel \{ background-color: rgba\(28, 28, 30, 0\.7\)/);                 // the top bar keeps its dark glass
    assert.match(light, /\.popup-menu-content[^}]*rgba\(255, 255, 255, 0\.92\)/);
    assert.match(light, /\.quick-settings[^}]*rgba\(255, 255, 255, 0\.92\)/);
    assert.match(light, /\.search-entry \{ background-color: rgba\(250, 250, 252, 0\.85\)/);
    // a mixed shell: dark quick settings, light popups
    const mixed = shellStylesheet({...look, dark: {panel: true, popup: false, quick: true, overview: true}});
    assert.match(mixed, /\.quick-settings[^}]*rgba\(36, 36, 38/);
    assert.match(mixed, /\.popup-menu-content[^}]*rgba\(255, 255, 255/);
});

test('dark text on the light surfaces reaches AA over every wallpaper at the floors', () => {
    const over = (c, a, below) => c.map((v, i) => Math.round(v * a + below[i] * (1 - a)));
    const text = [0, 0, 0];                                              // the darkest text a light shell theme uses
    for (const wall of [[0, 0, 0], [255, 255, 255], [128, 128, 128], [220, 40, 40]]) {
        for (const [name, c, a] of [['content', [250, 250, 252], FLOORS.content / 100], ['popup', [255, 255, 255], FLOORS.elevated / 100]]) {
            const bg = over(c, a, wall);
            assert.ok(contrast([...text], bg) >= 4.5, `${name} over ${wall}: ${contrast(text, bg).toFixed(2)}`);
        }
    }
});

import {readFileSync} from 'node:fs';
import {EDGE} from '../../control/build/appearanceTokens.js';
test('one edge treatment: the Search palette and the shell surfaces share radius, border and shadow', () => {
    const search = readFileSync(new URL('../../shell/search/stylesheet.css', import.meta.url), 'utf8');
    const palette = search.match(/\.niro-search \{([^}]*)\}/)[1];
    assert.match(palette, new RegExp(`border-radius: ${EDGE.radiusSheet}px`));
    assert.ok(palette.includes(EDGE.borderDark), 'border');
    assert.ok(palette.includes(EDGE.shadowDark), 'shadow');
    const shell = shellStylesheet(look);
    assert.match(shell, new RegExp(`\\.quick-settings[^}]*border-radius: ${EDGE.radiusSheet}px`));
    assert.match(shell, new RegExp(`\\.popup-menu-content[^}]*border-radius: ${EDGE.radiusPopup}px`));
    assert.ok(shell.includes(EDGE.shadowDark) && shell.includes(EDGE.borderDark));
});
