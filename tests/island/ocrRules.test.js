import test from 'node:test';
import assert from 'node:assert/strict';
import {parseTsv, sensitiveBoxes} from '../../control/build/ocrRules.js';

// tesseract's TSV: level page block par line word left top width height conf text
const row = (text, left, line = 1, top = 10) => `5\t1\t1\t1\t${line}\t1\t${left}\t${top}\t40\t12\t90\t${text}`;
const tsv = rows => ['level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext', ...rows, '4\t1\t1\t1\t1\t0\t0\t0\t1\t1\t-1\t'].join('\n');

test('tsv: only the words, with where they are', () => {
    const w = parseTsv(tsv([row('hello', 5), row('world', 60)]));
    assert.deepEqual(w.map(x => [x.text, x.left]), [['hello', 5], ['world', 60]]);
});

test('private details: e-mail, long numbers, split card numbers, keys', () => {
    const boxes = words => sensitiveBoxes(parseTsv(tsv(words)));
    assert.equal(boxes([row('Contact:', 5), row('ani@example.com', 60)]).length, 1);
    assert.equal(boxes([row('<budi.s@kantor.co.id>,', 5)]).length, 1);
    assert.equal(boxes([row('+62 812-3456-7890', 5)]).length, 1);
    assert.equal(boxes([row('Phone:', 5), row('t62', 60), row('812-3456-7890', 100)]).length, 2);    // the country code goes with the number
    assert.equal(boxes([row('4242', 5), row('4242', 50), row('4242', 95), row('4242', 140)]).length, 4);
    assert.equal(boxes([row('Zx9Kq2Wm7Rt4Yp1Vb6Nc3Hs8Ld5Fg0Ja', 5)]).length, 1);
    // ordinary text and short numbers stay
    assert.equal(boxes([row('Total', 5), row('2026', 50), row('items', 95), row('12', 140)]).length, 0);
    assert.equal(boxes([row('1234', 5, 1), row('5678', 50, 2)]).length, 0);       // digit groups on different lines are not one number
    assert.equal(boxes([row('internationalization', 5)]).length, 0);
});

test('boxes are padded around the word', () => {
    const [b] = sensitiveBoxes(parseTsv(tsv([row('ani@example.com', 60)])), 3);
    assert.deepEqual(b, [57, 7, 103, 25]);
});
