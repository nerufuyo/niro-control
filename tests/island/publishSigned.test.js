// A repository that was published signed is not published again without the key (stand-in git, gh, make: nothing leaves this machine).
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';

const script = name => fileURLToPath(new URL(`../../scripts/${name}`, import.meta.url));

function run(name, args, env = {}) {
    const dir = mkdtempSync(join(tmpdir(), 'niro-publish-'));
    // `git clone` makes a site that holds the public key; every call is logged
    const git = `case "$1" in
  rev-parse) case "$2" in --abbrev-ref) echo main;; *) echo abc;; esac;;
  clone) for last; do :; done; mkdir -p "$last"; touch "$last/niro-control.gpg";;
esac`;
    for (const [cmd, body] of Object.entries({git, gh: '[ "$2" != view ]', make: '', createrepo_c: '', rpmsign: '', gpg: 'exit 2'})) {
        writeFileSync(join(dir, cmd), `#!/bin/sh\necho "${cmd} $*" >> "${dir}/calls"\n${body}\n`);
        chmodSync(join(dir, cmd), 0o755);
    }
    const r = spawnSync('bash', [script(name), ...args], {env: {PATH: `${dir}:/usr/bin:/bin`, ...env}, encoding: 'utf8'});
    const calls = existsSync(join(dir, 'calls')) ? readFileSync(join(dir, 'calls'), 'utf8') : '';
    rmSync(dir, {recursive: true, force: true});
    return {...r, calls};
}

test('publish-rpm-repo.sh refuses a signed site without a key, before it writes anything', () => {
    const r = run('publish-rpm-repo.sh', [script('release.sh')]);
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stdout, /set NIRO_GPG_KEY/);
    assert.doesNotMatch(r.calls, /createrepo_c|push/);
});

test('release.sh refuses before there is a GitHub release', () => {
    const r = run('release.sh', []);
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stdout, /set NIRO_GPG_KEY/);
    assert.doesNotMatch(r.calls, /release create|^make/m);
});

test('release.sh stops before the GitHub release when the key cannot sign', () => {
    const r = run('release.sh', [], {NIRO_GPG_KEY: 'someone'});
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stdout, /cannot sign/);
    assert.doesNotMatch(r.calls, /release create|^make/m);
});
