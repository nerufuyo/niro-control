import test from 'node:test';
import assert from 'node:assert/strict';
import {nextDue, recurrence} from '../../shell/island/build/src/reminderRules.js';

test('recurring reminders: the marker ends the text, the text is shown without it', () => {
    assert.deepEqual(recurrence('take the pill /daily'), {text: 'take the pill', period: 86400000, label: 'every day', marked: 'take the pill /daily'});
    assert.equal(recurrence('minum obat /harian').text, 'minum obat');
    assert.equal(recurrence('rapat tim /Mingguan').period, 7 * 86400000);
    assert.equal(recurrence('call /daily about the bill'), null);      // only at the end
    assert.equal(recurrence('plain reminder'), null);
});

test('recurring reminders: the next time is in the future, on the same hour', () => {
    const day = 86400000, due = 1000 * day + 9 * 3600000;
    assert.equal(nextDue(due, due - 5, day), due);                    // not due yet: unchanged
    assert.equal(nextDue(due, due + 1000, day), due + day);
    assert.equal(nextDue(due, due + 3 * day + 5, day), due + 4 * day); // three days missed: one reminder, the next day
});
