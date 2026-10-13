import { Tmux, OWNER } from './tmux.js';
import { LAUNCH_PREFIX } from './runner.js';
import type { PaneSpec } from './config.js';

export type ActualPane = { runtimeId: string; id: string; owned: boolean; spec: PaneSpec | null; state: string; token: string; dead: boolean; lastExit: unknown; shellExit: unknown; command: string; cwd: string; orphanLauncher: boolean };
export type ActualWindow = { runtimeId: string; id: string; owned: boolean; name: string; layout: string; initialized: boolean; panes: ActualPane[] };
export type ActualSession = { runtimeId: string; id: string; owned: boolean; name: string; profile: string; windows: ActualWindow[] };
export type Snapshot = { generation: string; sessions: ActualSession[] };
const rows = (s: string): string[][] => s ? s.split('\n').map(r => r.split('\t')) : [];
function decode(s: string): PaneSpec | null { try { return JSON.parse(Buffer.from(s, 'base64url').toString()) as PaneSpec; } catch { return null; } }
function json(s: string): unknown { try { return JSON.parse(s); } catch { return null; } }
export async function inspect(tmux: Tmux): Promise<Snapshot> {
  if (!await tmux.exists()) return { generation: '', sessions: [] };
  const generation = await tmux.call(['show-options', '-s', '-qv', '@ts-generation']);
  const sessions: ActualSession[] = [];
  for (const [runtimeId = ''] of rows(await tmux.call(['list-sessions', '-F', '#{session_id}']))) {
    const [id, owner, name, profile] = await Promise.all([
      tmux.ownOption('s', runtimeId, '@ts-session-id'), tmux.ownOption('s', runtimeId, '@ts-session-owner'),
      tmux.call(['display-message', '-p', '-t', runtimeId, '#{session_name}']), tmux.ownOption('s', runtimeId, '@ts-profile'),
    ]);
    const session: ActualSession = { runtimeId, id, owned: owner === OWNER, name, profile, windows: [] };
    for (const [wid = ''] of rows(await tmux.call(['list-windows', '-t', runtimeId, '-F', '#{window_id}']))) {
      const [logicalId, wowner, name, layout, initialized] = await Promise.all([
        tmux.ownOption('w', wid, '@ts-window-id'), tmux.ownOption('w', wid, '@ts-window-owner'),
        tmux.call(['display-message', '-p', '-t', wid, '#{window_name}']), tmux.ownOption('w', wid, '@ts-layout'),
        tmux.ownOption('w', wid, '@ts-initialized'),
      ]);
      const window: ActualWindow = { runtimeId: wid, id: logicalId, owned: wowner === OWNER, name, layout, initialized: initialized === '1', panes: [] };
      for (const [pid = ''] of rows(await tmux.call(['list-panes', '-t', wid, '-F', '#{pane_id}']))) {
        // Read the object's own options: format lookups would inherit parent tags.
        const [pLogical, pOwner, spec, state, token, dead, lastExit, shellExit, command, cwd] = await Promise.all([
          tmux.getOption(pid, '@ts-pane-id'), tmux.getOption(pid, '@ts-pane-owner'), tmux.getOption(pid, '@ts-spec'),
          tmux.getOption(pid, '@ts-launch-state'), tmux.getOption(pid, '@ts-token'),
          tmux.call(['display-message', '-p', '-t', pid, '#{pane_dead}']),
          tmux.getOption(pid, '@ts-last-exit'), tmux.getOption(pid, '@ts-shell-exit'),
          tmux.call(['display-message', '-p', '-t', pid, '#{pane_current_command}']),
          tmux.call(['display-message', '-p', '-t', pid, '#{pane_current_path}']),
        ]);
        const startCommand = await tmux.call(['display-message', '-p', '-t', pid, '#{pane_start_command}']);
        window.panes.push({ runtimeId: pid, id: pLogical, owned: pOwner === OWNER, spec: decode(spec), state: dead === '1' && state === 'committed' && !lastExit ? 'unknown' : state, token, dead: dead === '1', lastExit: json(lastExit), shellExit: json(shellExit), command, cwd, orphanLauncher: pOwner !== OWNER && startCommand.includes(LAUNCH_PREFIX) });
      }
      session.windows.push(window);
    }
    sessions.push(session);
  }
  return { generation, sessions };
}
