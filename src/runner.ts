import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { Tmux, OWNER } from './tmux.js';
import type { PaneSpec } from './config.js';

export const LAUNCH_PREFIX = 'termspacesLaunch_v1_';
export type LaunchSpec = { socket: string; session: string; window: string; pane: string; scope: 'session' | 'window' | 'pane'; spec: PaneSpec; token: string; generation: string };
export const encodeLaunch = (s: LaunchSpec): string => LAUNCH_PREFIX + Buffer.from(JSON.stringify(s)).toString('base64url');

async function main(): Promise<void> {
  const encoded = process.argv[2];
  if (!encoded?.startsWith(LAUNCH_PREFIX)) throw new Error('Invalid internal launcher invocation.');
  const payload = JSON.parse(Buffer.from(encoded.slice(LAUNCH_PREFIX.length), 'base64url').toString()) as LaunchSpec;
  const pane = process.env.TMUX_PANE;
  if (!pane || !/^%\d+$/.test(pane)) throw new Error('The launcher must run inside a tmux pane.');
  const tmux = new Tmux(payload.socket);
  const generation = await tmux.call(['show-options', '-s', '-qv', '@ts-generation']);
  if (generation !== payload.generation) throw new Error('tmux server generation changed.');
  if (payload.scope === 'session') {
    await tmux.option('s', pane, '@ts-session-id', payload.session);
    await tmux.option('s', pane, '@ts-session-owner', OWNER);
  }
  if (payload.scope !== 'pane') {
    await tmux.option('w', pane, '@ts-window-id', payload.window);
    await tmux.option('w', pane, '@ts-window-owner', OWNER);
  }
  await tmux.option('p', pane, 'remain-on-exit', 'on');
  await tmux.option('p', pane, '@ts-pane-id', payload.pane);
  await tmux.option('p', pane, '@ts-spec', Buffer.from(JSON.stringify(payload.spec)).toString('base64url'));
  await tmux.option('p', pane, '@ts-token', payload.token);
  await tmux.option('p', pane, '@ts-launch-state', 'pending');
  await tmux.option('p', pane, '@ts-pane-owner', OWNER);
  while (await tmux.getOption(pane, '@ts-ready') !== payload.token) await delay(100);
  if (await tmux.call(['show-options', '-s', '-qv', '@ts-generation']) !== payload.generation) throw new Error('tmux server generation changed.');
  // This commits an attempt, not proof the child executed. Never replay it automatically.
  await tmux.option('p', pane, '@ts-launch-state', 'committed');
  let stopping = false;
  let child: ReturnType<typeof spawn> | undefined;
  for (const signal of ['SIGTERM', 'SIGHUP'] as const) process.on(signal, () => { stopping = true; child?.kill(signal); });
  // A foreground interactive shell normally owns terminal signals. Keep a stray
  // interrupt from killing the supervisor, without inheriting SIG_IGN in children.
  process.on('SIGINT', () => {});
  let first = true;
  const startupEnabled = payload.spec.argv !== null && (payload.spec.startupScope !== 'window' || payload.scope !== 'pane');
  if (payload.spec.argv && !startupEnabled) await tmux.option('p', pane, '@ts-launch-state', 'skipped');
  do {
    const startupAttempt = first && startupEnabled;
    const argv = startupAttempt ? payload.spec.argv! : [payload.spec.shell, '-l'];
    child = spawn(argv[0]!, argv.slice(1), { cwd: payload.spec.cwd, stdio: 'inherit', env: process.env, shell: false });
    let spawnError = '';
    child.once('error', error => { spawnError = error.message; });
    const result = await new Promise<{ code: number | null; signal: string | null }>(resolve => child!.once('close', (code, signal) => resolve({ code, signal })));
    if (await tmux.call(['show-options', '-s', '-qv', '@ts-generation']) !== payload.generation) return;
    await tmux.option('p', pane, startupAttempt ? '@ts-last-exit' : '@ts-shell-exit', JSON.stringify({ ...result, ...(spawnError ? { error: spawnError } : {}) }));
    if (startupAttempt) {
      await tmux.option('p', pane, '@ts-launch-state', spawnError ? 'failed' : 'exited');
      if (stopping || !payload.spec.sticky) { process.exitCode = result.code ?? 1; return; }
      first = false;
      process.stdout.write('\r\n[termspaces: startup task ended; opening an interactive shell.]\r\n');
      continue;
    }
    if (stopping || !payload.spec.sticky) { await tmux.option('p', pane, '@ts-launch-state', 'exited'); return; }
    first = false;
    process.stdout.write('\r\n[termspaces: shell exited; opening a new shell. Ctrl+B d detaches.]\r\n');
    await delay(200);
  } while (!stopping);
}
if (process.argv[2]?.startsWith(LAUNCH_PREFIX)) main().catch(error => { process.stderr.write(`[termspaces launcher] ${String(error)}\n`); process.exitCode = 1; });
