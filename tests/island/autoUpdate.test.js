// The daily update the rpm ships: a timer that is installed but off, a helper that turns it on and off through pkexec, and the polkit
// action that names exactly that helper. Settings offers the switch only where the helper is.
import assert from 'node:assert/strict';
import {readFileSync, statSync} from 'node:fs';
import {test} from 'node:test';

const read = path => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');
const executable = path => (statSync(new URL(`../../${path}`, import.meta.url)).mode & 0o111) !== 0;

test('the update script installs only niro-control, and the helper only switches the timer', () => {
    const update = read('data/auto-update/auto-update');
    assert.match(update, /dnf -y --refresh upgrade niro-control\b/);
    assert.doesNotMatch(update, /dnf[^\n]*\b(install|remove|--best|--allowerasing)\b|curl|wget/);
    const helper = read('data/auto-update/auto-update-switch');
    assert.match(helper, /systemctl enable --now niro-control-update\.timer/);
    assert.match(helper, /systemctl disable --now niro-control-update\.timer/);
    assert.ok(executable('data/auto-update/auto-update') && executable('data/auto-update/auto-update-switch'));
});

test('the timer is daily and not enabled by the package; the service runs the update script once', () => {
    assert.match(read('data/auto-update/niro-control-update.timer'), /OnCalendar=daily/);
    assert.match(read('data/auto-update/niro-control-update.service'), /Type=oneshot[\s\S]*ExecStart=\/usr\/libexec\/niro-control\/auto-update\n/);
    const spec = read('packaging/rpm/niro-control.spec');
    // The macro applies the distribution's preset (off for a package's own timer); nothing enables it by hand.
    assert.match(spec, /%systemd_post niro-control-update\.timer/);
    assert.doesNotMatch(spec, /systemctl[^\n]*enable[^\n]*niro-control-update/);
});

test('the polkit action names the switch helper and asks an administrator', () => {
    const policy = read('data/auto-update/org.niro.control.auto-update.policy');
    assert.match(policy, /<action id="org\.niro\.control\.auto-update">/);
    assert.match(policy, /exec\.path">\/usr\/libexec\/niro-control\/auto-update-switch</);
    assert.match(policy, /<allow_any>auth_admin<\/allow_any>/);
    assert.match(policy, /<allow_active>auth_admin_keep<\/allow_active>/);
    assert.doesNotMatch(policy, /<allow_[a-z_]+>yes<\/allow_[a-z_]+>/);
});

test('the rpm carries all of it, and Settings uses the helper through pkexec', () => {
    const spec = read('packaging/rpm/niro-control.spec');
    for (const path of ['niro-control-update.service', 'niro-control-update.timer', '%{_prefix}/libexec/niro-control', 'org.niro.control.auto-update.policy'])
        assert.ok(spec.includes(path), `the spec lacks ${path}`);
    const build = read('packaging/build-rpm.sh');
    for (const name of ['auto-update', 'auto-update-switch', 'org.niro.control.auto-update.policy'])
        assert.ok(build.includes(name), `build-rpm.sh does not stage ${name}`);
    const prefs = read('shell/island/prefs.ts');
    assert.match(prefs, /'pkexec', AUTO_SWITCH/);
    assert.match(prefs, /AUTO_SWITCH = '\/usr\/libexec\/niro-control\/auto-update-switch'/);
});
