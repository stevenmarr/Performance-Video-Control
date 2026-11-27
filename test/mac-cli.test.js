'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const CC = path.join(ROOT, 'tools', 'cc');
const PLIST = path.join(ROOT, 'tools', 'launchd', 'com.performancevideo.controlcenter.plist.template');

function run(args, env = {}, opts = {}) {
  const r = spawnSync(CC, args, {
    encoding: 'utf8',
    env: { ...process.env, ...env },
    cwd: opts.cwd || ROOT,
    timeout: opts.timeout || 15000,
  });
  return r;
}

function out(r) { return `${r.stdout || ''}${r.stderr || ''}`; }

describe('tools/cc', () => {
  it('is an executable bash script', () => {
    const st = fs.statSync(CC);
    assert.ok((st.mode & 0o111) !== 0, 'tools/cc should be executable');
    const text = fs.readFileSync(CC, 'utf8');
    assert.match(text, /^#!\/usr\/bin\/env bash/);
    assert.match(text, /set -euo pipefail/);
  });

  it('prints help with every subcommand', () => {
    const r = run(['help']);
    assert.equal(r.status, 0, out(r));
    const s = out(r);
    for (const cmd of ['up', 'update', 'launch', 'stop', 'status', 'logs', 'install', 'uninstall', 'install-service']) {
      assert.match(s, new RegExp(`cc ${cmd}`), `help should mention cc ${cmd}`);
    }
    assert.match(s, /--dry-run/);
  });

  it('rejects an unknown argument', () => {
    const r = run(['frobnicate']);
    assert.notEqual(r.status, 0);
    assert.match(out(r), /unknown argument/);
  });

  it('dry-run status against this checkout does not mutate git', () => {
    const before = spawnSync('git', ['-C', ROOT, 'status', '--porcelain'], { encoding: 'utf8' });
    const r = run(['--dry-run', 'status', '--dir', ROOT]);
    assert.equal(r.status, 0, out(r));
    const s = out(r);
    assert.match(s, /Control Center/);
    assert.match(s, /performance-video-control|feat\/mac-cli/);
    assert.match(s, /8080/);
    const after = spawnSync('git', ['-C', ROOT, 'status', '--porcelain'], { encoding: 'utf8' });
    assert.equal(after.stdout, before.stdout);
  });

  it('dry-run update refuses a dirty Control Center tree', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-cli-dirty-'));
    try {
      const init = spawnSync('git', ['init', '-b', 'performance-video-control', tmp], { encoding: 'utf8' });
      assert.equal(init.status, 0, init.stderr);
      fs.writeFileSync(path.join(tmp, 'server.js'), 'console.log("cc")\n');
      fs.writeFileSync(path.join(tmp, 'package.json'), JSON.stringify({
        name: 'rs6-presets', version: '0.0.0', description: 'Performance Video Control Center test fixture',
      }, null, 2) + '\n');
      fs.writeFileSync(path.join(tmp, 'package-lock.json'), '{}\n');
      spawnSync('git', ['-C', tmp, 'config', 'user.email', 'test@example.com']);
      spawnSync('git', ['-C', tmp, 'config', 'user.name', 'Test']);
      const add = spawnSync('git', ['-C', tmp, 'add', 'server.js', 'package.json', 'package-lock.json'], { encoding: 'utf8' });
      assert.equal(add.status, 0, add.stderr);
      const commit = spawnSync('git', ['-C', tmp, 'commit', '-m', 'init'], { encoding: 'utf8' });
      assert.equal(commit.status, 0, commit.stderr);
      fs.appendFileSync(path.join(tmp, 'server.js'), '// dirty\n');
      const r = run(['--dry-run', 'update', '--dir', tmp, '--no-companion', '--no-module']);
      assert.notEqual(r.status, 0, out(r));
      assert.match(out(r), /uncommitted changes|dirty tree/i);
      const still = fs.readFileSync(path.join(tmp, 'server.js'), 'utf8');
      assert.match(still, /dirty/, 'dry-run must not revert local edits');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('dry-run update / launch / stop / logs / install against a clean fixture prints commands and changes nothing', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-cli-clean-'));
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-cli-home-'));
    try {
      spawnSync('git', ['init', '-b', 'performance-video-control', tmp], { encoding: 'utf8' });
      fs.writeFileSync(path.join(tmp, 'server.js'), 'console.log("cc")\n');
      fs.writeFileSync(path.join(tmp, 'package.json'), JSON.stringify({
        name: 'rs6-presets', version: '0.0.0', description: 'Performance Video Control Center test fixture',
      }, null, 2) + '\n');
      fs.writeFileSync(path.join(tmp, 'package-lock.json'), '{}\n');
      spawnSync('git', ['-C', tmp, 'config', 'user.email', 'test@example.com']);
      spawnSync('git', ['-C', tmp, 'config', 'user.name', 'Test']);
      spawnSync('git', ['-C', tmp, 'add', 'server.js', 'package.json', 'package-lock.json']);
      spawnSync('git', ['-C', tmp, 'commit', '-m', 'init']);
      // No upstream: update should explain that instead of trying to fetch.
      const upd = run(['--dry-run', 'update', '--dir', tmp, '--no-companion', '--no-module'], { HOME: home });
      assert.notEqual(upd.status, 0, out(upd));
      assert.match(out(upd), /no upstream/i);

      const launch = run(['--dry-run', 'launch', '--dir', tmp, '--no-open', '--port', '18080'], { HOME: home });
      assert.equal(launch.status, 0, out(launch));
      const ls = out(launch);
      assert.match(ls, /server\.js|--port 18080|wait for http:\/\/127\.0\.0\.1:18080\/api\/health/);
      assert.ok(!fs.existsSync(path.join(home, 'Library', 'Logs', 'Control Center', 'control-center.pid')), 'dry-run launch must not write a pid file');

      const stop = run(['--dry-run', 'stop', '--dir', tmp], { HOME: home });
      assert.equal(stop.status, 0, out(stop));

      const logs = run(['--dry-run', 'logs', '--no-follow', '-n', '20', '--dir', tmp], { HOME: home });
      assert.notEqual(logs.status, 0);
      assert.match(out(logs), /No log file yet/);

      const inst = run(['--dry-run', 'install', '--dir', tmp], { HOME: home, CC_BIN_DIR: path.join(home, 'bin') });
      assert.equal(inst.status, 0, out(inst));
      assert.match(out(inst), /ln -sfn/);
      assert.ok(!fs.existsSync(path.join(home, 'bin', 'cc')), 'dry-run install must not create the symlink');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('launchd template uses the Mac label, port placeholder, and log folder', () => {
    const xml = fs.readFileSync(PLIST, 'utf8');
    assert.match(xml, /<string>com\.performancevideo\.controlcenter<\/string>/);
    assert.match(xml, /__APP_DIR__\/server\.js/);
    assert.match(xml, /<string>__PORT__<\/string>/);
    assert.match(xml, /__HOME__\/Library\/Logs\/Control Center\/control-center\.out\.log/);
    assert.match(xml, /<key>KeepAlive<\/key>/);
    assert.doesNotMatch(xml, /8088/, 'Mac template must not use the Pi port');
  });

  it('README Mac section documents cc up and the assumed paths', () => {
    const md = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
    assert.match(md, /### One command: update and launch \(`cc`\)/);
    assert.match(md, /cc up/);
    assert.match(md, /~\/control-center/);
    assert.match(md, /~\/companion/);
    assert.match(md, /performance-video-control/);
    assert.match(md, /uncommitted changes/);
  });
});
