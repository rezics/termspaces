#!/usr/bin/env node
import { Command } from 'commander';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { loadConfig, defaultConfig, expandPath, ToolError } from './config.js';
import { WorkspaceSchema } from './schema.js';
import { socketPath, Tmux, run } from './tmux.js';
import { Manager } from './manager.js';
import { inspect } from './state.js';
import { plan } from './planner.js';
import { autostart } from './systemd.js';

const program = new Command().name('termspaces').description('Declarative tmux workspaces for humans and coding agents').version('0.1.0')
  .option('-c, --config <path>', 'Workspace YAML file or directory', defaultConfig())
  .option('--socket <name>', 'Private tmux socket name', 'termspaces')
  .option('--socket-path <path>', 'Explicit absolute tmux socket path (for service integration)')
  .option('--json', 'Emit the versioned JSON protocol');
function options(): { config: string; socket: string; socketPath?: string; json?: boolean } { return program.opts(); }
function output(data: unknown): void {
  if (options().json) process.stdout.write(JSON.stringify({ protocolVersion: 1, ok: true, data }) + '\n');
  else if (typeof data === 'string') process.stdout.write(data + '\n');
  else process.stdout.write(JSON.stringify(data, null, 2) + '\n');
}
async function manager(): Promise<Manager> {
  if (process.platform !== 'linux') throw new ToolError('UNSUPPORTED_PLATFORM', 'Run termspaces on the remote Linux host (including WSL).');
  if (options().socket === 'default') throw new ToolError('DEFAULT_SOCKET_REFUSED', 'Use a dedicated socket rather than tmux default.');
  const path = options().socketPath;
  if (path && !path.startsWith('/')) throw new ToolError('INVALID_SOCKET', '--socket-path must be absolute.');
  return new Manager(new Tmux(path ? resolve(path) : await socketPath(options().socket)));
}
const load = () => loadConfig(options().config);
async function confirm(kind: string, id: string, yes?: boolean): Promise<void> {
  if (yes) return;
  if (!process.stdin.isTTY || !process.stdout.isTTY || options().json) throw new ToolError('CONFIRMATION_REQUIRED', `${kind} terminates tasks in ${id}; pass --yes explicitly.`);
  const input = createInterface({ input: process.stdin, output: process.stderr });
  try { if (await input.question(`${kind} ${id} and terminate its tasks? Type ${id}: `) !== id) throw new ToolError('CANCELLED', 'Operation cancelled.'); }
  finally { input.close(); }
}
program.command('init').description('Create a starter workspace without modifying shell configuration')
  .option('--profile <profile>', 'minimal or immersive', 'minimal')
  .action(async (opts: { profile: string }) => {
    if (!['minimal', 'immersive'].includes(opts.profile)) throw new ToolError('INVALID_PROFILE', 'Choose minimal or immersive.');
    const path = expandPath(options().config, process.cwd());
    const file = /\.ya?ml$/.test(path) ? path : join(path, 'default.yaml');
    await mkdir(dirname(file), { recursive: true });
    const yaml = `version: 1\nsession:\n  id: default\n  name: Default\n  cwd: ${JSON.stringify(process.cwd())}\n  autostart: false\n  profile: ${opts.profile}\nwindows:\n  - id: shell\n    name: Shell\n    panes:\n      - id: main\n        sticky: true\n`;
    try { await writeFile(file, yaml, { flag: 'wx', mode: 0o600 }); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new ToolError('CONFIG_EXISTS', `Refusing to overwrite ${file}.`); throw error; }
    output({ created: file, next: 'termspaces validate; termspaces plan; termspaces apply; termspaces attach default' });
  });
program.command('validate').description('Validate YAML, unique IDs, directories and shell paths').action(async () => output({ valid: true, sessions: (await load()).map(s => ({ id: s.id, source: s.source })) }));
program.command('schema').description('Print the workspace JSON Schema').action(() => { if (options().json) output(WorkspaceSchema); else process.stdout.write(JSON.stringify(WorkspaceSchema, null, 2) + '\n'); });
program.command('plan').description('Inspect differences without modifying tmux').action(async () => { const m = await manager(); const changes = plan(await load(), await inspect(m.tmux)); output(changes); if (changes.conflicts.length) process.exitCode = 3; });
program.command('apply').description('Create missing resources and update safe metadata')
  .option('--autostart', 'Apply only sessions with autostart: true')
  .option('--wait-server', 'Wait for the dedicated systemd server; never start one here')
  .action(async (opts: { autostart?: boolean; waitServer?: boolean }) => {
    const m = await manager();
    if (opts.waitServer) {
      const deadline = Date.now() + 10000;
      while (!await m.tmux.exists()) { if (Date.now() > deadline) throw new ToolError('SERVER_NOT_READY', 'tmux service did not become ready within 10 seconds.'); await delay(100); }
    }
    output(await m.apply(async () => (await load()).filter(s => !opts.autostart || s.autostart), opts.waitServer ?? false));
  });
program.command('list').description('List managed and unmanaged sessions on this socket').action(async () => output(await inspect((await manager()).tmux)));
program.command('status [session]').description('Inspect actual resources and exit state').action(async (id?: string) => {
  const state = await inspect((await manager()).tmux);
  if (!id) return output(state);
  const matches = state.sessions.filter(s => s.owned && s.id === id);
  if (matches.length !== 1) throw new ToolError('NOT_FOUND', `No unique managed session ${id}.`);
  output(matches[0]);
});
program.command('windows <session>').description('List windows of a managed session').action(async (id: string) => {
  const matches = (await inspect((await manager()).tmux)).sessions.filter(s => s.owned && s.id === id);
  if (matches.length !== 1) throw new ToolError('NOT_FOUND', `No unique managed session ${id}.`);
  output(matches[0]!.windows);
});
program.command('panes <window>').description('List panes by session-id/window-id').action(async (target: string) => {
  const [sid, wid, extra] = target.split('/');
  const matches = (await inspect((await manager()).tmux)).sessions.filter(s => s.owned && s.id === sid).flatMap(s => s.windows.filter(w => w.owned && w.id === wid));
  if (extra || matches.length !== 1) throw new ToolError('NOT_FOUND', `No unique managed window ${target}.`);
  output(matches[0]!.panes);
});
program.command('attach <session>').description('Attach outside tmux; switch inside the same server').option('--takeover', 'Detach other clients explicitly').action(async (id: string, opts: { takeover?: boolean }) => {
  if (options().json || !process.stdin.isTTY) throw new ToolError('TTY_REQUIRED', 'Attach requires an interactive terminal.');
  const m = await manager();
  const matches = (await inspect(m.tmux)).sessions.filter(s => s.owned && s.id === id);
  if (matches.length !== 1) throw new ToolError('NOT_FOUND', `No unique managed session ${id}.`);
  let command = 'attach-session';
  if (process.env.TMUX) {
    const current = process.env.TMUX.slice(0, process.env.TMUX.lastIndexOf(',', process.env.TMUX.lastIndexOf(',') - 1));
    if (current !== m.tmux.socket) throw new ToolError('NESTED_TMUX', 'Detach from the other tmux server before attaching.');
    if (opts.takeover) throw new ToolError('INVALID_OPTION', '--takeover applies when attaching from outside tmux.');
    command = 'switch-client';
  }
  const child = spawn('tmux', ['-S', m.tmux.socket, command, ...(opts.takeover ? ['-d'] : []), '-t', matches[0]!.runtimeId], { stdio: 'inherit' });
  await new Promise<void>((resolve, reject) => { child.on('error', reject); child.on('exit', code => { process.exitCode = code ?? 1; resolve(); }); });
});
program.command('capture <pane>').description('Capture untrusted terminal text by session/window/pane ID')
  .option('--lines <count>', 'Maximum history lines', '100')
  .action(async (target: string, opts: { lines: string }) => {
    const count = Number(opts.lines);
    if (!Number.isSafeInteger(count) || count < 1 || count > 10000) throw new ToolError('INVALID_LIMIT', '--lines must be 1..10000.');
    const [sid, wid, pid, extra] = target.split('/');
    const m = await manager();
    const matches = (await inspect(m.tmux)).sessions.filter(s => s.owned && s.id === sid).flatMap(s => s.windows.filter(w => w.owned && w.id === wid)).flatMap(w => w.panes.filter(p => p.owned && p.id === pid));
    if (extra || matches.length !== 1) throw new ToolError('NOT_FOUND', `No unique managed pane ${target}.`);
    const text = await m.tmux.call(['capture-pane', '-p', '-t', matches[0]!.runtimeId, '-S', `-${count}`]);
    output({ target, untrusted: true, text: text.split('\n').slice(-count).join('\n') });
  });
for (const kind of ['clear', 'reset'] as const) program.command(`${kind} <session>`).description(`${kind === 'clear' ? 'Destroy' : 'Recreate'} exactly one managed session; terminates its tasks`)
  .option('-y, --yes', 'Explicitly confirm destructive operation')
  .action(async (id: string, opts: { yes?: boolean }) => { await confirm(kind, id, opts.yes); output(await (await manager()).destroy(id, kind === 'reset', load)); });
program.command('layout <window>').description('Explicitly apply the declared window layout').action(async (target: string) => output(await (await manager()).layout(target, await load())));
program.command('doctor').description('Check runtime, dependencies, socket and user systemd availability').action(async () => {
  const checks: Record<string, unknown> = { platform: process.platform, node: process.version };
  let healthy = process.platform === 'linux' && Number(process.versions.node.split('.')[0]) >= 24;
  for (const binary of ['tmux', 'flock']) {
    try { const result = await run(binary, [binary === 'tmux' ? '-V' : '--version']); checks[binary] = result.stdout.trim() || result.stderr.trim(); if (result.code) healthy = false; }
    catch (error) { checks[binary] = String(error); healthy = false; }
  }
  try { const r = await run('systemctl', ['--user', 'is-system-running']); checks.systemd = r.stdout.trim() || r.stderr.trim(); } catch { checks.systemd = 'unavailable (manual apply still works)'; }
  if (process.platform === 'linux') checks.socket = (await manager()).tmux.socket;
  output({ healthy, checks }); if (!healthy) process.exitCode = 1;
});
program.command('autostart <action>').description('Write user systemd units (action: install); does not start or stop sessions')
  .option('--enable', 'Reload systemd and enable units for subsequent user-manager startup')
  .action(async (action: string, opts: { enable?: boolean }) => {
    if (action !== 'install') throw new ToolError('INVALID_ACTION', 'Supported action: autostart install.');
    await load(); const m = await manager();
    output(await autostart(options().socket, m.tmux.socket, expandPath(options().config, process.cwd()), opts.enable ?? false));
  });
program.command('_prepare-server', { hidden: true }).action(async () => { await (await manager()).tmux.prepare(); });
program.configureOutput({ writeErr: s => { if (!process.argv.includes('--json')) process.stderr.write(s); } });
program.exitOverride();
program.parseAsync().catch(error => {
  if (error.code === 'commander.helpDisplayed' || error.code === 'commander.version') return;
  const code = error instanceof ToolError ? error.code : error.code?.startsWith('commander.') ? 'INVALID_ARGUMENTS' : 'INTERNAL_ERROR';
  const message = error instanceof Error ? error.message : String(error);
  const payload = { code, message, ...(error instanceof ToolError && error.details !== undefined ? { details: error.details } : {}) };
  if (process.argv.includes('--json')) process.stdout.write(JSON.stringify({ protocolVersion: 1, ok: false, error: payload }) + '\n');
  else process.stderr.write(`${code}: ${message}\n`);
  process.exitCode = code === 'CONFLICT' ? 3 : /INVALID|CONFIG|DUPLICATE|CONFIRMATION/.test(code) ? 2 : 1;
});
