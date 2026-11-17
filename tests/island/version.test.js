// One version, kept in three places (the package's VERSION, the Rust workspace, the extension's metadata.json) and the update check
// pointed at this project: the island's "a newer version is out" compares the latest release's tag with what is installed.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';

const read = path => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');

test('VERSION, the Rust workspace and the extension say the same version', () => {
    const version = read('VERSION').trim();
    assert.match(version, /^\d+\.\d+\.\d+$/);
    assert.equal(/^version = "([^"]+)"/m.exec(read('Cargo.toml'))[1], version);
    assert.equal(JSON.parse(read('shell/island/metadata.json'))['version-name'], version);
});

test('the update check looks at this project\'s releases, and nothing is ever downloaded and run', () => {
    assert.match(read('crates/island-daemon/src/updates.rs'), /repos\/nerufuyo\/niro-control\/releases\/latest/);
    for (const file of ['shell/island/prefs.ts', 'shell/island/src/alerts.ts', 'shell/island/src/controller.ts']) {
        const text = read(file);
        assert.doesNotMatch(text, /zickrian\/isle/, `${file} points at another project`);
        assert.doesNotMatch(text, /curl[^\n]*\|\s*(ba)?sh|\| *bash/, `${file} pipes a download into a shell`);
    }
});
