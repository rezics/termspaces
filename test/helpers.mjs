import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Tmux, run } from '../dist/tmux.js';
import { inspect } from '../dist/state.js';
import { loadConfig } from '../dist/config.js';
import { Manager } from '../dist/manager.js';
export const root = resolve(import.meta.dirname, '..');
export async function fixture(t, manifest) {
  await mkdir(join(root, '.temp'), { recursive: true });
  const dir = await mkdtemp(join(root, '.temp/test-'));
  const socket = join(dir, 'tmux.sock');
  const tmux = new Tmux(socket);
  const file = join(dir, 'workspace.yaml');
  const doc = manifest || { version: 1, session: { id: 'demo', name: 'Demo', cwd: dir }, windows: [{ id: 'shell', panes: [{ id: 'main', shell: '/bin/bash' }] }] };
  const save = async () => writeFile(file, JSON.stringify(doc));
  await save();
  t.after(async () => { await tmux.call(['kill-server'], true).catch(() => {}); await rm(dir, { recursive: true, force: true }); });
  return { dir, socket, tmux, file, doc, save, manager: new Manager(tmux), load: () => loadConfig(file), snapshot: () => inspect(tmux), cli: (...args) => run(process.execPath, [join(root, 'dist/cli.js'), '--config', file, '--socket-path', socket, '--json', ...args], 45000) };
}
export async function until(fn, message = 'condition', timeout = 10000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const result = await fn(); if (result) return result; await delay(50); }
  throw new Error(`Timed out waiting for ${message}`);
}
