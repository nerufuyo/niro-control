// The desktop UAT checklist (tests/uat/matrix.csv) must obey its own rules, so a result cannot be filed as Pass without evidence,
// and the generated matrix must be what the tool prints from the CSV.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {dirname, join} from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const run = args => spawnSync('python3', [join(root, 'tests/uat/uat-report.py'), ...args], {cwd: root, encoding: 'utf8'});

test('the UAT matrix passes its own rules', () => {
    const r = run(['--check']);
    assert.equal(r.status, 0, r.stderr);
});

test('docs/motion/uat/matrix.md is up to date with the CSV', () => {
    const r = run([]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(readFileSync(join(root, 'docs/motion/uat/matrix.md'), 'utf8').trim(), r.stdout.trim(), 'rerun: python3 tests/uat/uat-report.py --md docs/motion/uat/matrix.md');
});
