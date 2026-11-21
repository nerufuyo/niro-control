import test from 'node:test';
import assert from 'node:assert/strict';
import {nextDue, recurrence} from '../../shell/island/build/src/reminderRules.js';

test('recurring reminders: the marker ends the text, the text is shown without it', () => {
    assert.deepEqual({...recurrence('take the pill /daily'), next: undefined}, {text: 'take the pill', period: 86400000, label: 'every day', marked: 'take the pill /daily', next: undefined});
    assert.equal(recurrence('minum obat /harian').text, 'minum obat');
    assert.equal(recurrence('rapat tim /Mingguan').period, 7 * 86400000);
    assert.equal(recurrence('standup /weekdays').label, 'every weekday');
    assert.equal(recurrence('standup /harikerja').text, 'standup');
    assert.equal(recurrence('bayar listrik /bulanan').label, 'every month');
    assert.equal(recurrence('call /daily about the bill'), null);      // only at the end
    assert.equal(recurrence('plain reminder'), null);
});

const at = (y, m, d, h = 9) => new Date(y, m - 1, d, h, 0, 0).getTime();

test('recurring reminders: the next time keeps the same local hour', () => {
    const daily = recurrence('x /daily');
    assert.equal(daily.next(at(2026, 11, 21), at(2026, 11, 21, 8)), at(2026, 11, 21));       // not due yet: unchanged
    assert.equal(daily.next(at(2026, 11, 21), at(2026, 11, 21, 10)), at(2026, 11, 22));
    assert.equal(daily.next(at(2026, 11, 21), at(2026, 11, 24, 12)), at(2026, 11, 25));      // days missed: one reminder, the next day
    const weekly = recurrence('x /weekly');
    assert.equal(weekly.next(at(2026, 11, 21), at(2026, 11, 22)), at(2026, 11, 28));
});

test('recurring reminders: weekdays skip the weekend, months keep the day (or the last one)', () => {
    const wd = recurrence('x /weekdays');
    assert.equal(new Date(at(2026, 11, 20)).getDay(), 5);                                     // a Friday
    assert.equal(wd.next(at(2026, 11, 20), at(2026, 11, 20, 10)), at(2026, 11, 23));          // Friday -> Monday
    assert.equal(wd.next(at(2026, 11, 23), at(2026, 11, 23, 10)), at(2026, 11, 24));
    const mo = recurrence('x /monthly');
    assert.equal(mo.next(at(2026, 11, 15), at(2026, 11, 16)), at(2026, 12, 15));
    assert.equal(mo.next(at(2026, 1, 31), at(2026, 2, 1)), at(2026, 2, 28));                  // February has no 31st
    assert.equal(mo.next(at(2026, 12, 20), at(2026, 12, 21)), at(2027, 1, 20));               // over the year's end
});

test('recurring reminders: fixed-period helper', () => {
    const day = 86400000, due = 1000 * day + 9 * 3600000;
    assert.equal(nextDue(due, due - 5, day), due);
    assert.equal(nextDue(due, due + 3 * day + 5, day), due + 4 * day);
});
