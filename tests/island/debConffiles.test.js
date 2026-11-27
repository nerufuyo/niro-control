// The .deb names everything it ships under /etc as a conffile, so an upgrade does not overwrite the user's edits.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';

test('the .deb declares the packaged /etc files as conffiles, before it is built', () => {
    const build = readFileSync(new URL('../../packaging/build.sh', import.meta.url), 'utf8');
    assert.match(build, /\(cd "\$P" && find etc -type f -printf '\/%p\\n'\) > "\$P\/DEBIAN\/conffiles"[\s\S]*dpkg-deb/);
});
