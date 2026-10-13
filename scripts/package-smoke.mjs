import { mkdir, rm, writeFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';
import { run } from '../dist/tmux.js';
const root = resolve(import.meta.dirname, '..');
const prefix = join(root, '.temp/package-smoke');
await rm(prefix, { recursive: true, force: true });
await mkdir(prefix, { recursive: true });
await writeFile(join(prefix, 'package.json'), JSON.stringify({ private: true, name: 'termspaces-package-smoke', version: '0.0.0' }));
const tarball = join(root, '.temp/rezics-termspaces-0.1.0.tgz');
const install = await run('yarn', ['--cwd', prefix, 'add', '--ignore-scripts', '--non-interactive', tarball], 120000);
assert.equal(install.code, 0, install.stderr);
const cli = join(prefix, 'node_modules/.bin/termspaces');
for (const args of [['--version'], ['--help'], ['--json', 'schema'], ['--json', 'doctor']]) {
  const result = await run(cli, args); assert.equal(result.code, 0, result.stderr + result.stdout);
  if (args.includes('--json')) assert.equal(JSON.parse(result.stdout).ok, true);
}
const packageRoot = join(prefix, 'node_modules/@rezics/termspaces');
for (const file of ['dist/cli.js', 'dist/runner.js', 'assets/tmux.conf', 'schema/workspace.schema.json', 'skills/termspaces/SKILL.md', 'LICENSE']) {
  assert.ok(await (await import('node:fs/promises')).stat(join(packageRoot, file)));
}
const entries = await readdir(packageRoot);
for (const ignored of ['.temp', 'temp', 'test', 'src', '.git']) assert.ok(!entries.includes(ignored));
console.log('Published-package shape and installed CLI smoke checks passed (nothing published).');
