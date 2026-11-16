// The emoji picker's database: the emoji are all still there, and the two added groups (Kaomoji, Text Symbols) are filled, searchable in English and Indonesian.
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {test} from 'node:test';

const db = new DatabaseSync(new URL('../../shell/emoji/data/emojis.db', import.meta.url).pathname, {readOnly: true});
const count = group => db.prepare('SELECT COUNT(*) AS n FROM emojis WHERE emoji_group = ?').get(group).n;
const find = word => db.prepare('SELECT unicode FROM emojis WHERE description LIKE ?').all(`%${word}%`).map(r => r.unicode);

test('the emoji are untouched', () => {
    assert.equal(count('People & Body'), 2430);
    assert.equal(count('Smileys & Emotion'), 172);
    assert.equal(count('Flags'), 270);
    assert.ok(db.prepare("SELECT COUNT(*) AS n FROM emojis WHERE emoji_group NOT IN ('Kaomoji','Text Symbols')").get().n >= 3989);
});

test('kaomoji and text symbols: plenty of them, each with something to search by', () => {
    assert.ok(count('Kaomoji') >= 150, `${count('Kaomoji')} kaomoji`);
    assert.ok(count('Text Symbols') >= 1000, `${count('Text Symbols')} symbols`);
    const empty = db.prepare("SELECT unicode FROM emojis WHERE emoji_group IN ('Kaomoji','Text Symbols') AND (description IS NULL OR TRIM(description) = '')").all();
    assert.deepEqual(empty, []);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM emojis WHERE unicode IS NULL OR unicode = ''").get().n, 0);
});

test('the search finds them by name, in English and Indonesian', () => {
    assert.ok(find('shrug').includes('¯\\_(ツ)_/¯'));
    assert.ok(find('table flip').includes('(╯°□°)╯︵ ┻━┻'));
    assert.ok(find('marah').length >= 5, 'angry kaomoji by their Indonesian name');
    assert.ok(find('panah').includes('→') && find('rightwards arrow').includes('→'));
    assert.ok(find('yunani').includes('π') && find('greek').includes('Ω'));
    assert.ok(find('uang').includes('€') && find('euro').includes('€'));
    assert.ok(find('matematika').includes('≠'));
    assert.ok(find('aksen').includes('é'));
});

test('a key is one entry only (it is the primary key)', () => {
    const dup = db.prepare('SELECT unicode, COUNT(*) AS n FROM emojis GROUP BY unicode HAVING n > 1').all();
    assert.deepEqual(dup, []);
});
