// The screen locking turns Island off and on: the stopwatch keeps going. The page runs with GNOME stubbed out.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';

import {Stopwatch} from '../../shell/island/build/src/timerRules.js';

test('a new Timer page has the stopwatch of the one before', () => {
    // Stands for any widget, namespace or helper: everything on it is itself.
    const any = new Proxy(function () {}, {
        get: (_target, key) => key === Symbol.toPrimitive ? () => 0 : any,
        set: () => true, apply: () => any, construct: () => any,
    });
    class Page {
        _init(daemon) { this.daemon = daemon; }
        add_child() {}
        insert_child_above() {}
        watch() {}
    }
    const source = readFileSync(new URL('../../shell/island/src/pages/timer.ts', import.meta.url), 'utf8')
        .replace(/^import[\s\S]*?;$/gm, '').replace('export const', 'const');
    const names = ['Clutter', 'St', 'timerColor', 'VERTICAL', 'onUiScale', 'Format', 'typedMinutes', 'stopwatchText',
        'Ring', 'icon', 'iconButton', 'label', 'setEnabled', 'PAGE_HEIGHT'];
    const TimerPage = new Function('GObject', 'Page', 'Stopwatch', ...names, `${source}\nreturn TimerPage;`)(
        {registerClass: c => c}, Page, Stopwatch, ...names.map(() => any));
    const make = () => {
        const page = new TimerPage();
        page._init({state: {}}, {height: 1});
        return page;
    };

    const first = make();
    first._watch.toggle(1000);
    first._watch.lap(3000);
    const second = make();
    assert.equal(second._watch.running, true);
    assert.equal(second._watch.elapsed(9000), 8000);
    assert.equal(second._watch.laps.length, 1);
});
