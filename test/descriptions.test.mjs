import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import { fixture, until } from './helpers.mjs';

test('description updates and removal preserve running tasks and terminal identity', { timeout: 30000 }, async t => {
  const f = await fixture(t);
  const starts = join(f.dir, 'starts');
  f.doc.windows[0].panes[0].startup = { mode: 'on-create', argv: [process.execPath, '-e', 'require("fs").appendFileSync(process.argv[1],process.pid+"\\n");setInterval(()=>{},1000)', starts] };
  await f.save(); await f.manager.apply(f.load);
  const taskPid = Number(await until(async () => { try { return (await readFile(starts, 'utf8')).trim(); } catch { return false; } }));
  const before = await f.snapshot();
  const pane = before.sessions[0].windows[0].panes[0];
  const supervisor = await f.tmux.call(['display-message', '-p', '-t', pane.runtimeId, '#{pane_pid}']);
  assert.equal(before.sessions[0].description, '');
  assert.equal(before.sessions[0].windows[0].description, '');
  const sentinel = join(f.dir, 'SHOULD_NOT_EXIST');
  f.doc.session.description = 'Project operations\n项目操作\tRead the intended purpose.\n';
  f.doc.windows[0].description = `Implementation "agent" #{pid} #(touch ${sentinel});`;
  await f.save();
  const update = await f.manager.apply(f.load);
  assert.deepEqual(update.completed.map(o => o.kind).sort(), ['session-description', 'window-description']);
  assert.equal(update.state.sessions[0].description, f.doc.session.description);
  assert.equal(update.state.sessions[0].windows[0].description, f.doc.windows[0].description);
  assert.equal(update.state.sessions[0].runtimeId, before.sessions[0].runtimeId);
  assert.equal(update.state.sessions[0].windows[0].runtimeId, before.sessions[0].windows[0].runtimeId);
  assert.equal(update.state.sessions[0].windows[0].panes[0].runtimeId, pane.runtimeId);
  assert.equal(await f.tmux.call(['display-message', '-p', '-t', pane.runtimeId, '#{pane_pid}']), supervisor);
  process.kill(taskPid, 0);
  assert.equal((await readFile(starts, 'utf8')).trim().split('\n').length, 1);
  await assert.rejects(access(sentinel));
  assert.equal((await f.manager.apply(f.load)).completed.length, 0);
  for (const args of [['list'], ['status', 'demo'], ['windows', 'demo']]) {
    const response = await f.cli(...args);
    assert.equal(response.code, 0, response.stdout + response.stderr);
    const data = JSON.parse(response.stdout).data;
    const resource = args[0] === 'list' ? data.sessions[0] : args[0] === 'windows' ? data[0] : data;
    assert.equal(resource.description, args[0] === 'windows' ? f.doc.windows[0].description : f.doc.session.description);
  }
  delete f.doc.session.description; f.doc.windows[0].description = ''; await f.save();
  const cleared = await f.manager.apply(f.load);
  assert.deepEqual(cleared.completed.map(o => o.kind).sort(), ['session-description', 'window-description']);
  assert.equal(cleared.state.sessions[0].description, '');
  assert.equal(cleared.state.sessions[0].windows[0].description, '');
  assert.equal(await f.tmux.ownOption('s', before.sessions[0].runtimeId, '@ts-session-description'), '');
  assert.equal(await f.tmux.ownOption('w', before.sessions[0].windows[0].runtimeId, '@ts-window-description'), '');
  assert.equal((await f.manager.apply(f.load)).completed.length, 0);
  process.kill(taskPid, 0);
});

test('fresh startup commands can read their session and window descriptions', { timeout: 30000 }, async t => {
  const f = await fixture(t);
  const output = join(f.dir, 'observed.json');
  f.doc.session.description = 'Project root coordination';
  f.doc.windows[0].description = 'Read metadata after the window is initialized.';
  const script = 'const {execFileSync}=require("child_process");const get=(scope,key)=>execFileSync("tmux",["-S",process.argv[2],"show-options",...scope,"-qv","-t",process.env.TMUX_PANE,key],{encoding:"utf8"}).trim();require("fs").writeFileSync(process.argv[1],JSON.stringify([get([],"@ts-session-description"),get(["-w"],"@ts-window-description")]));';
  f.doc.windows[0].startup = { mode: 'on-create', argv: [process.execPath, '-e', script, output, f.socket] };
  await f.save(); await f.manager.apply(f.load);
  const observed = await until(async () => { try { return JSON.parse(await readFile(output, 'utf8')); } catch { return false; } });
  assert.deepEqual(observed, [f.doc.session.description, f.doc.windows[0].description]);
  f.doc.windows.push({ id: 'review', description: 'Independent review terminal', panes: [{ id: 'main', shell: '/bin/bash' }] });
  await f.save();
  const added = await f.manager.apply(f.load);
  assert.equal(added.state.sessions[0].windows.find(w => w.id === 'review').description, 'Independent review terminal');
});

test('descriptions use own options and leave unmanaged resources unchanged', { timeout: 30000 }, async t => {
  const f = await fixture(t); await f.manager.apply(f.load);
  await f.tmux.call(['set-option', '-g', '@ts-session-description', 'inherited session text']);
  await f.tmux.call(['set-option', '-gw', '@ts-window-description', 'inherited window text']);
  const before = await f.snapshot();
  assert.equal(before.sessions[0].description, '');
  assert.equal(before.sessions[0].windows[0].description, '');
  await f.tmux.call(['new-session', '-d', '-s', 'Manual', '--', '/bin/sh', '-c', 'sleep 60']);
  const manual = (await f.snapshot()).sessions.find(s => !s.owned);
  await f.tmux.option('s', manual.runtimeId, '@ts-session-description', 'Owned by the user');
  f.doc.session.description = 'Managed project'; f.doc.windows[0].description = 'Managed shell'; await f.save();
  await f.manager.apply(f.load);
  const state = await f.snapshot();
  assert.equal(state.sessions.find(s => !s.owned).description, 'Owned by the user');
  assert.equal(state.sessions.find(s => s.owned).description, 'Managed project');
  assert.equal(state.sessions.find(s => s.owned).windows[0].description, 'Managed shell');
});

test('description validation permits plain multiline text and rejects controls or oversized content', async t => {
  const f = await fixture(t);
  for (const value of ['First line\nSecond line\r\nTabbed\ttext', '', 'a'.repeat(4096)]) {
    f.doc.session.description = value; f.doc.windows[0].description = value; await f.save();
    const config = await f.load(); assert.equal(config[0].description, value); assert.equal(config[0].windows[0].description, value);
  }
  for (const value of ['bad\u0000text', 'bad\u001b[31m', 'bad\u009b31m', 'a'.repeat(4097), 123]) {
    f.doc.session.description = value; await f.save(); await assert.rejects(f.load, { code: 'INVALID_CONFIG' });
  }
  delete f.doc.session.description; f.doc.windows[0].description = '\u001b'; await f.save();
  await assert.rejects(f.load, { code: 'INVALID_CONFIG' });
  assert.equal(await f.tmux.exists(), false);
});
