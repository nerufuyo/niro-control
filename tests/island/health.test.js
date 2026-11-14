import assert from 'node:assert/strict';
import {test} from 'node:test';

import {assess, overall, summary} from '../../control/build/health.js';

const ext = (name, state, installed = true) => ({name, uuid: `${name}@x`, installed, state});
const ok = () => ({extensions: [ext('Island', 1), ext('Dock', 1)], daemon: true, islandInstalled: true, profile: {id: null, name: null, missing: false, modified: 0},
    interrupted: null, stale: [], unreachableSettings: 0, configProblems: []});
const row = (f, id) => assess(f).find(r => r.id === id);

test('everything checked and fine is healthy', () => {
    const rows = assess(ok());
    assert.equal(overall(rows), 'healthy');
    assert.equal(summary(rows), 'Healthy');
});

test('extensions: errors, stopped, missing are attention; an unanswered shell is unavailable, never healthy', () => {
    assert.equal(row({...ok(), extensions: [ext('Dock', 3)]}, 'extensions').state, 'attention');
    assert.match(row({...ok(), extensions: [ext('Dock', 2)]}, 'extensions').detail, /not running/);
    assert.equal(row({...ok(), extensions: [ext('Dock', 6)]}, 'extensions').state, 'attention');
    assert.equal(row({...ok(), extensions: [ext('Dock', null, false)]}, 'extensions').state, 'attention');
    assert.equal(row({...ok(), extensions: [ext('Dock', null)]}, 'extensions').state, 'unavailable');
    assert.equal(row({...ok(), extensions: [{...ext('Dock', 3), error: 'SyntaxError'}]}, 'extensions').detail.includes('SyntaxError'), true);
});

test('service: not running is attention, unknown is unavailable, island absent is unavailable', () => {
    assert.equal(row({...ok(), daemon: false}, 'service').state, 'attention');
    assert.equal(row({...ok(), daemon: null}, 'service').state, 'unavailable');
    assert.equal(row({...ok(), islandInstalled: false, daemon: false}, 'service').state, 'unavailable');
});

test('profile: modified points to Profiles; a deleted one is attention', () => {
    const r = row({...ok(), profile: {id: 'gaming', name: 'Gaming', missing: false, modified: 3}}, 'profile');
    assert.equal(r.state, 'attention');
    assert.deepEqual(r.action, {kind: 'go', page: 'profiles', label: 'Review'});
    assert.equal(row({...ok(), profile: {id: 'gaming', name: 'Gaming', missing: true, modified: 0}}, 'profile').state, 'attention');
    assert.equal(row({...ok(), profile: {id: 'gaming', name: 'Gaming', missing: false, modified: 0}}, 'profile').state, 'healthy');
});

test('a pending recovery journal offers the restore and outranks attention', () => {
    const f = {...ok(), interrupted: {label: 'Applying Gaming'}, daemon: false};
    assert.deepEqual(row(f, 'recovery').action, {kind: 'recover', label: 'Restore backup'});
    assert.equal(overall(assess(f)), 'recovery');
    assert.match(summary(assess(f)), /1 to recover, 1 need attention/);
});

test('a pending login names the parts and offers Log out; config problems are attention', () => {
    const r = row({...ok(), stale: ['Dock', 'Island']}, 'restart');
    assert.equal(r.state, 'attention');
    assert.equal(r.action.kind, 'logout');
    assert.equal(row({...ok(), configProblems: ['x depends on y']}, 'configuration').state, 'attention');
    assert.equal(row({...ok(), unreachableSettings: 4}, 'configuration').state, 'attention');
});
