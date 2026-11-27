// A note or task inside a plan keeps the text as typed.
import assert from 'node:assert/strict';
import {test} from 'node:test';

import {localParse} from '../../shell/shared/commandPlanner.js';

test('note.add and todo.add keep case and accents, and still split into steps', () => {
    const text = {name: 'text', type: 'string', required: true};
    const cat = [{id: 'note.add', params: [text], permission: 'none'}, {id: 'todo.add', params: [text], permission: 'none'},
        {id: 'system.mute.toggle', params: [], permission: 'none'}];
    assert.deepEqual(localParse('Note Call Dr. José then add a task Beli Crème then mute', cat).steps, [
        {action: 'note.add', args: {text: 'Call Dr. José'}},
        {action: 'todo.add', args: {text: 'Beli Crème'}},
        {action: 'system.mute.toggle', args: {}},
    ]);
});
