import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fixture, until } from './helpers.mjs';

test('window startup runs once after panes/layout; missing first pane does not rerun it', { timeout: 30000 }, async t => {
  const f = await fixture(t);
  const marker = join(f.dir, 'starts');
  f.doc.windows[0].layout = 'even-horizontal';
  f.doc.windows[0].panes.push({ id: 'second', shell: '/bin/bash' });
  f.doc.windows[0].startup = { mode: 'on-create', argv: [process.execPath, '-e', 'const {execFileSync}=require("child_process");const result=execFileSync("tmux",["-S",process.argv[1],"list-panes","-t",process.env.TMUX_PANE,"-F","#{pane_id}"],{encoding:"utf8"});require("fs").appendFileSync(process.argv[2],result.trim().split("\\n").length+"\\n")', f.socket, marker] };
  await f.save(); await f.manager.apply(f.load);
  await until(async () => { try { return await readFile(marker, 'utf8'); } catch { return false; } });
  assert.equal(await readFile(marker, 'utf8'), '2\n');
  await f.manager.apply(f.load); assert.equal(await readFile(marker, 'utf8'), '2\n');
  const pane = (await f.snapshot()).sessions[0].windows[0].panes[0];
  await f.tmux.call(['kill-pane', '-t', pane.runtimeId]);
  await f.manager.apply(f.load);
  await until(async () => (await f.snapshot()).sessions[0].windows[0].panes.some(p => p.id === 'main' && p.state === 'skipped'), 'skipped window startup');
  assert.equal(await readFile(marker, 'utf8'), '2\n');
  await f.manager.destroy('demo', true, f.load);
  await until(async () => (await readFile(marker, 'utf8')).split('\n').length === 3, 'reset window startup');
  assert.equal(await readFile(marker, 'utf8'), '2\n2\n');
});
test('window and first-pane startup conflict is rejected before mutation', async t => {
  const f = await fixture(t);
  f.doc.windows[0].startup = { mode: 'on-create', argv: ['/bin/true'] };
  f.doc.windows[0].panes[0].startup = { mode: 'manual' }; await f.save();
  await assert.rejects(f.load, { code: 'AMBIGUOUS_STARTUP' });
  assert.equal(await f.tmux.exists(), false);
});
