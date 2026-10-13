import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fixture } from './helpers.mjs';
import { expandPath, loadConfig } from '../dist/config.js';
import { encodeTmuxArg, literalFormat } from '../dist/tmux.js';
import { plan } from '../dist/planner.js';
import { unitArg } from '../dist/systemd.js';

test('configuration rejects duplicate IDs, unknown properties, bad commands and YAML duplicate keys', async t => {
  const f = await fixture(t);
  f.doc.windows.push(structuredClone(f.doc.windows[0])); await f.save();
  await assert.rejects(f.load, { code: 'DUPLICATE_ID' });
  f.doc.windows.pop(); f.doc.extra = true; await f.save();
  await assert.rejects(f.load, { code: 'INVALID_CONFIG' });
  delete f.doc.extra; f.doc.windows[0].panes[0].startup = { mode: 'on-create', argv: [''] }; await f.save();
  await assert.rejects(f.load, { code: 'INVALID_COMMAND' });
  await writeFile(f.file, 'version: 1\nversion: 1\n');
  await assert.rejects(f.load, { code: 'INVALID_YAML' });
});
test('relative directories are resolved by manifest hierarchy, not current shell cwd', async t => {
  const f = await fixture(t);
  await mkdir(join(f.dir, 'project/sub/child'), { recursive: true });
  f.doc.session.cwd = './project'; f.doc.windows[0].cwd = 'sub'; f.doc.windows[0].panes[0].cwd = 'child'; await f.save();
  assert.equal((await f.load())[0].windows[0].panes[0].spec.cwd, join(f.dir, 'project/sub/child'));
  assert.throws(() => expandPath('~other/project', f.dir), { code: 'INVALID_PATH' });
});
test('tmux and systemd encoding boundaries are explicit', () => {
  assert.equal(encodeTmuxArg('semi;'), 'semi\\;');
  assert.equal(encodeTmuxArg('backslash\\;'), 'backslash\\\\;');
  assert.equal(literalFormat('#{pid} #(echo x)'), '##{pid} ##(echo x)');
  assert.equal(unitArg('a %b $c "d"'), '"a %%b $$c \\"d\\""');
});
test('pending startup with drift is retained, never activated; duplicates conflict', async t => {
  const f = await fixture(t);
  const desired = await f.load();
  const pane = { runtimeId: '%0', id: 'main', owned: true, spec: { ...desired[0].windows[0].panes[0].spec, argv: ['/bin/echo', 'old'] }, state: 'pending', dead: false };
  const actual = { generation: 'a', sessions: [{ runtimeId: '$0', id: 'demo', owned: true, name: 'Demo', profile: 'minimal', windows: [{ runtimeId: '@0', id: 'shell', owned: true, name: 'shell', layout: 'tiled', panes: [pane] }] }] };
  const changes = plan(desired, actual);
  assert.equal(changes.operations.filter(o => o.kind === 'activate').length, 0);
  assert.ok(changes.deferred.some(d => d.target === 'demo/shell/main'));
  actual.sessions.push(structuredClone(actual.sessions[0]));
  assert.ok(plan(desired, actual).conflicts.some(c => /Duplicate/.test(c.reason)));
});
test('JSON CLI errors are parseable and invalid configuration creates no server', async t => {
  const f = await fixture(t);
  f.doc.windows = []; await f.save();
  const result = await f.cli('apply');
  assert.equal(result.code, 2);
  const error = JSON.parse(result.stdout);
  assert.equal(error.ok, false); assert.equal(error.error.code, 'INVALID_CONFIG');
  assert.equal(await f.tmux.exists(), false);
  const bad = await f.cli('not-a-command');
  assert.equal(JSON.parse(bad.stdout).error.code, 'INVALID_ARGUMENTS');
});
