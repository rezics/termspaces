import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdir, readFile } from 'node:fs/promises';
import { fixture, until } from './helpers.mjs';
import { autostart } from '../dist/systemd.js';
import { run, Tmux } from '../dist/tmux.js';
import { inspect } from '../dist/state.js';
import { Manager } from '../dist/manager.js';

test('generated systemd units prepare a cold socket and apply restart preserves tmux PID', { skip: process.env.TERMSPACES_SYSTEMD_TEST !== '1', timeout: 45000 }, async t => {
  const name = `ts-test-${process.pid}-${Date.now()}`;
  const server = `termspaces-server-${name}.service`, apply = `termspaces-apply-${name}.service`;
  // Registered before fixture removal: stop services before removing source files.
  t.after(async () => {
    await run('systemctl', ['--user', 'stop', apply, server]);
    await run('systemctl', ['--user', 'disable', apply, server]);
    await run('systemctl', ['--user', 'reset-failed', apply, server]);
    await run('systemctl', ['--user', 'daemon-reload']);
  });
  const f = await fixture(t);
  f.doc.session.autostart = true; await f.save();
  const socket = join(f.dir, 'cold-owned/sock'); const tmux = new Tmux(socket);
  const old = process.env.XDG_CONFIG_HOME;
  let units;
  try { process.env.XDG_CONFIG_HOME = join(f.dir, 'config'); units = await autostart(name, socket, f.file, false); }
  finally { if (old === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = old; }
  for (const args of [['--user', 'link', ...units.files], ['--user', 'daemon-reload'], ['--user', 'start', apply]]) {
    const r = await run('systemctl', args, 20000); assert.equal(r.code, 0, r.stderr);
  }
  let state = await inspect(tmux); assert.equal(state.sessions[0].id, 'demo');
  const pid = await tmux.call(['display-message', '-p', '#{pid}']);
  const runner = state.sessions[0].windows[0].panes[0].runtimeId;
  const restart = await run('systemctl', ['--user', 'restart', apply], 20000); assert.equal(restart.code, 0, restart.stderr);
  assert.equal(await tmux.call(['display-message', '-p', '#{pid}']), pid);
  state = await inspect(tmux); assert.equal(state.sessions[0].windows[0].panes[0].runtimeId, runner);
  await new Manager(tmux).apply(f.load);
  assert.equal(await tmux.call(['display-message', '-p', '#{pid}']), pid);
});
