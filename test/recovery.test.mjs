import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, symlink, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fixture, until, root } from './helpers.mjs';
import { encodeLaunch } from '../dist/runner.js';
import { Tmux } from '../dist/tmux.js';
import { Manager } from '../dist/manager.js';

test('interrupted pending launch resumes once; changed pending command stays pending', { timeout: 30000 }, async t => {
  const f = await fixture(t);
  const marker = join(f.dir, 'started');
  f.doc.windows[0].panes[0].startup = { mode: 'on-create', argv: [process.execPath, '-e', 'require("fs").appendFileSync(process.argv[1],"once\\n")', marker] }; await f.save();
  const desired = await f.load(); const generation = await f.manager.ensureServer();
  const launch = encodeLaunch({ socket: f.socket, session: 'demo', window: 'shell', pane: 'main', scope: 'session', spec: desired[0].windows[0].panes[0].spec, token: randomUUID(), generation });
  const pid = await f.tmux.call(['new-session', '-d', '-P', '-F', '#{pane_id}', '-s', 'Demo', '-n', 'shell', '-c', f.dir, '--', process.execPath, join(root, 'dist/runner.js'), launch]);
  await until(async () => await f.tmux.getOption(pid, '@ts-pane-owner') === 'termspaces/v1', 'pending launcher');
  f.doc.windows[0].panes[0].startup = { mode: 'manual' }; await f.save();
  const drift = await f.manager.apply(f.load);
  assert.equal(drift.completed.some(o => o.kind === 'activate'), false);
  await assert.rejects(readFile(marker));
  f.doc.windows[0].panes[0].startup = { mode: 'on-create', argv: desired[0].windows[0].panes[0].spec.argv }; await f.save();
  await f.manager.apply(f.load);
  await until(async () => { try { return await readFile(marker, 'utf8'); } catch { return false; } });
  await f.manager.apply(f.load);
  assert.equal(await readFile(marker, 'utf8'), 'once\n');
});
test('committed runner crash reports unknown and is not replayed', { timeout: 30000 }, async t => {
  const f = await fixture(t);
  const marker = join(f.dir, 'started');
  f.doc.windows[0].panes[0].startup = { mode: 'on-create', argv: [process.execPath, '-e', 'require("fs").appendFileSync(process.argv[1],"once\\n");setInterval(()=>{},1000)', marker] }; await f.save();
  await f.manager.apply(f.load);
  await until(async () => { try { return await readFile(marker, 'utf8'); } catch { return false; } });
  const pane = (await f.snapshot()).sessions[0].windows[0].panes[0];
  const runnerPid = Number(await f.tmux.call(['display-message', '-p', '-t', pane.runtimeId, '#{pane_pid}']));
  process.kill(runnerPid, 'SIGKILL');
  await until(async () => (await f.snapshot()).sessions[0].windows[0].panes[0].dead, 'dead runner');
  assert.equal((await f.snapshot()).sessions[0].windows[0].panes[0].state, 'unknown');
  assert.equal((await f.manager.apply(f.load)).completed.length, 0);
  assert.equal(await readFile(marker, 'utf8'), 'once\n');
});
test('ancestor socket aliases use one canonical identity and one writer lock', { timeout: 30000 }, async t => {
  const f = await fixture(t);
  const base = join(f.dir, 'real'); await mkdir(base, { mode: 0o700 });
  await symlink(base, join(f.dir, 'alias'));
  const a = new Tmux(join(base, 'owned/sock'));
  const b = new Tmux(join(f.dir, 'alias/owned/sock'));
  assert.equal(a.socket, b.socket);
  try {
    const [first, second] = await Promise.all([new Manager(a).apply(f.load), new Manager(b).apply(f.load)]);
    assert.equal(first.completed.length + second.completed.length, 1);
  } finally { await a.call(['kill-server'], true); }
});
