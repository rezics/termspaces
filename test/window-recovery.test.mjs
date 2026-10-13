import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fixture, until } from './helpers.mjs';

const observeWindow = `
const { execFileSync } = require('node:child_process');
const { appendFileSync } = require('node:fs');
const tmux = (...args) => execFileSync('tmux', ['-S', process.argv[1], ...args], { encoding: 'utf8' }).trim();
const rows = tmux('list-panes', '-t', process.env.TMUX_PANE, '-F', '#{pane_id}\\t#{pane_top}\\t#{pane_left}').split('\\n').map(row => row.split('\\t'));
const initialized = tmux('show-options', '-w', '-qv', '-t', process.env.TMUX_PANE, '@ts-initialized');
appendFileSync(process.argv[2], JSON.stringify({ rows, initialized }) + '\\n');
`;

async function setup(t) {
  const f = await fixture(t);
  const marker = join(f.dir, 'window-starts.jsonl');
  f.doc.windows[0].layout = 'even-horizontal';
  f.doc.windows[0].panes.push({ id: 'second', shell: '/bin/bash' }, { id: 'third', shell: '/bin/bash' });
  f.doc.windows[0].startup = { mode: 'on-create', argv: [process.execPath, '-e', observeWindow, f.socket, marker] };
  await f.save();
  return { ...f, marker };
}

async function interruptedApply(f, matches) {
  const call = f.tmux.call.bind(f.tmux);
  let interrupted = false;
  f.tmux.call = async (args, allowFailure) => {
    if (!interrupted && matches(args)) {
      interrupted = true;
      throw new Error('Injected controller interruption before tmux operation');
    }
    return call(args, allowFailure);
  };
  try {
    await assert.rejects(() => f.manager.apply(f.load), { code: 'PARTIAL_APPLY' });
    assert.equal(interrupted, true);
  } finally {
    f.tmux.call = call;
  }
}

async function observeStartup(f) {
  return until(async () => {
    try { return (await readFile(f.marker, 'utf8')).trim().split('\n').map(line => JSON.parse(line)); }
    catch { return false; }
  }, 'window startup observation');
}

function assertInitializedWindow(record) {
  assert.equal(record.initialized, '1');
  assert.equal(record.rows.length, 3);
  assert.equal(new Set(record.rows.map(row => row[1])).size, 1, 'even-horizontal panes have a shared top edge');
  assert.equal(new Set(record.rows.map(row => row[2])).size, 3, 'even-horizontal panes have distinct left edges');
}

test('partial window recovery creates missing panes and applies layout before window startup', { timeout: 45000 }, async t => {
  const f = await setup(t);
  await interruptedApply(f, args => args[0] === 'split-window');
  const partial = (await f.snapshot()).sessions[0].windows[0];
  assert.equal(partial.initialized, false);
  assert.equal(partial.panes.length, 1);
  assert.equal(partial.panes[0].state, 'pending');
  await assert.rejects(readFile(f.marker), { code: 'ENOENT' });

  const resumed = await f.manager.apply(f.load);
  assert.equal(resumed.completed.filter(op => op.kind === 'create-pane').length, 2);
  assert.ok(resumed.completed.some(op => op.kind === 'initialize-window'));
  const records = await observeStartup(f);
  assert.equal(records.length, 1);
  assertInitializedWindow(records[0]);
  assert.equal((await f.snapshot()).sessions[0].windows[0].panes.find(p => p.id === 'main').runtimeId, partial.panes[0].runtimeId);
  await f.manager.apply(f.load);
  assert.equal((await observeStartup(f)).length, 1);
});

test('recovery after window initialization but before release preserves panes and starts once', { timeout: 45000 }, async t => {
  const f = await setup(t);
  await interruptedApply(f, args => args[0] === 'set-option' && args.includes('@ts-ready'));
  const partial = (await f.snapshot()).sessions[0].windows[0];
  assert.equal(partial.initialized, true);
  assert.equal(partial.panes.length, 3);
  assert.ok(partial.panes.every(p => p.state === 'pending'));
  await assert.rejects(readFile(f.marker), { code: 'ENOENT' });

  const resumed = await f.manager.apply(f.load);
  assert.equal(resumed.completed.some(op => op.kind.startsWith('create-') || op.kind === 'initialize-window'), false);
  const records = await observeStartup(f);
  assert.equal(records.length, 1);
  assertInitializedWindow(records[0]);
  assert.deepEqual((await f.snapshot()).sessions[0].windows[0].panes.map(p => p.runtimeId), partial.panes.map(p => p.runtimeId));
  await f.manager.apply(f.load);
  assert.equal((await observeStartup(f)).length, 1);
});

test('unmanaged panes in a partially initialized window block layout and startup release', { timeout: 45000 }, async t => {
  const f = await setup(t);
  await interruptedApply(f, args => args[0] === 'select-layout');
  const partial = (await f.snapshot()).sessions[0].windows[0];
  assert.equal(partial.initialized, false);
  await f.tmux.call(['split-window', '-d', '-t', partial.runtimeId, '--', '/bin/sh', '-c', 'sleep 60']);
  await f.tmux.call(['select-layout', '-t', partial.runtimeId, 'even-vertical']);
  const layout = await f.tmux.call(['display-message', '-p', '-t', partial.runtimeId, '#{window_layout}']);

  await assert.rejects(() => f.manager.apply(f.load), { code: 'CONFLICT' });
  assert.equal(await f.tmux.call(['display-message', '-p', '-t', partial.runtimeId, '#{window_layout}']), layout);
  const retained = (await f.snapshot()).sessions[0].windows[0];
  assert.equal(retained.initialized, false);
  assert.equal(retained.panes.filter(p => !p.owned).length, 1);
  assert.ok(retained.panes.filter(p => p.owned).every(p => p.state === 'pending'));
  await assert.rejects(readFile(f.marker), { code: 'ENOENT' });
});
