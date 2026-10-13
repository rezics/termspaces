import { mkdir, rm, writeFile, readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';
import { run } from '../dist/tmux.js';
const root = resolve(import.meta.dirname, '..');
const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const prefix = join(root, '.temp/package-smoke');
await rm(prefix, { recursive: true, force: true });
await mkdir(prefix, { recursive: true });
await writeFile(join(prefix, 'package.json'), JSON.stringify({ private: true, name: 'termspaces-package-smoke', version: '0.0.0' }));
const tarball = join(root, '.temp', `${manifest.name.replace(/^@/, '').replaceAll('/', '-')}-${manifest.version}.tgz`);
// Repacked unpublished versions must not reuse a prior file: package from Yarn's cache.
const install = await run('yarn', ['--cwd', prefix, '--cache-folder', join(prefix, 'cache'), 'add', '--ignore-scripts', '--non-interactive', tarball], 120000);
assert.equal(install.code, 0, install.stderr);
const cli = join(prefix, 'node_modules/.bin/termspaces');
for (const args of [['--version'], ['--help'], ['--json', 'schema'], ['--json', 'doctor']]) {
  const result = await run(cli, args); assert.equal(result.code, 0, result.stderr + result.stdout);
  if (args.includes('--version')) assert.equal(result.stdout.trim(), manifest.version);
  if (args.includes('--json')) assert.equal(JSON.parse(result.stdout).ok, true);
}
const packageRoot = join(prefix, 'node_modules/@rezics/termspaces');
for (const file of ['dist/cli.js', 'dist/runner.js', 'assets/tmux.conf', 'schema/workspace.schema.json', 'skills/termspaces/SKILL.md', 'docs/releasing.md', 'docs/research.md', 'LICENSE']) {
  assert.ok(await (await import('node:fs/promises')).stat(join(packageRoot, file)));
}
const entries = await readdir(packageRoot);
for (const ignored of ['.temp', 'temp', 'test', 'src', '.git']) assert.ok(!entries.includes(ignored));
const runtime = join(prefix, 'runtime');
await mkdir(runtime, { mode: 0o700 });
const config = join(runtime, 'workspace.yaml'), socket = join(runtime, 'tmux.sock'), marker = join(runtime, 'started');
await writeFile(config, JSON.stringify({ version: 1, session: { id: 'packed', cwd: runtime, description: 'Installed package workspace' }, windows: [{ id: 'shell', description: 'Verify the packaged command and terminal lifecycle', startup: { mode: 'on-create', argv: [process.execPath, '-e', 'require("fs").writeFileSync(process.argv[1],"started")', marker] }, panes: [{ id: 'main', shell: '/bin/sh' }] }] }));
const invoke = async (...args) => {
  const r = await run(cli, ['--config', config, '--socket-path', socket, '--json', ...args], 30000);
  assert.equal(r.code, 0, r.stdout + r.stderr); return JSON.parse(r.stdout).data;
};
try {
  await invoke('apply');
  const deadline = Date.now() + 10000;
  for (;;) {
    try { assert.equal(await readFile(marker, 'utf8'), 'started'); break; }
    catch (error) { if (Date.now() > deadline) throw error; await new Promise(resolve => setTimeout(resolve, 50)); }
  }
  assert.equal((await invoke('apply')).completed.length, 0);
  const state = await invoke('status', 'packed');
  assert.equal(state.windows[0].panes[0].id, 'main');
  assert.equal(state.description, 'Installed package workspace');
  assert.equal(state.windows[0].description, 'Verify the packaged command and terminal lifecycle');
  await invoke('clear', 'packed', '--yes');
} finally { await run('tmux', ['-S', socket, 'kill-server']); }
console.log('Installed package creates, runs, reuses and clears an isolated workspace (nothing published).');
