import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { Tmux, OWNER, literalFormat } from './tmux.js';
import { ToolError, type DesiredSession, type DesiredWindow, type DesiredPane } from './config.js';
import { inspect, type Snapshot, type ActualPane } from './state.js';
import { plan, type Plan, type Operation } from './planner.js';
import { encodeLaunch } from './runner.js';
import { withLock } from './locking.js';

export const tmuxConfigPath = fileURLToPath(new URL('../assets/tmux.conf', import.meta.url));
const runnerPath = fileURLToPath(new URL('./runner.js', import.meta.url));
export class Manager {
  constructor(public tmux: Tmux) {}
  async ensureServer(requireExisting = false): Promise<string> {
    await this.tmux.prepare();
    if (!await this.tmux.exists()) {
      if (requireExisting) throw new ToolError('SERVER_NOT_READY', 'The dedicated tmux service is not running.');
      await this.tmux.call(['-f', tmuxConfigPath, 'start-server']);
    }
    let generation = await this.tmux.call(['show-options', '-s', '-qv', '@ts-generation']);
    if (!generation) {
      generation = randomUUID();
      await this.tmux.call(['set-option', '-s', '@ts-generation', generation]);
    }
    return generation;
  }
  async activate(pane: ActualPane): Promise<void> {
    if (pane.dead || pane.state !== 'pending' || !pane.token) throw new ToolError('LAUNCH_STATE_CHANGED', 'Pane cannot be activated from its current state.');
    await this.tmux.option('p', pane.runtimeId, '@ts-ready', pane.token);
  }
  private async setDescription(scope: 's' | 'w', target: string, description: string): Promise<void> {
    const key = scope === 's' ? '@ts-session-description' : '@ts-window-description';
    if (description) await this.tmux.option(scope, target, key, description);
    else await this.tmux.call(['set-option', ...(scope === 's' ? [] : ['-w']), '-qu', '-t', target, key]);
  }
  private async createPane(session: DesiredSession, window: DesiredWindow, pane: DesiredPane, scope: 'session' | 'window' | 'pane', target: string, generation: string, activate = true): Promise<string> {
    const launch = encodeLaunch({ socket: this.tmux.socket, session: session.id, window: window.id, pane: pane.id, scope, spec: pane.spec, token: randomUUID(), generation });
    const common = ['-d', '-P', '-F', '#{pane_id}', '-c', literalFormat(pane.spec.cwd)];
    const args = scope === 'session'
      ? ['new-session', ...common, '-s', literalFormat(session.name), '-n', literalFormat(window.name), '-x', '120', '-y', '40']
      : scope === 'window' ? ['new-window', ...common, '-t', target, '-n', literalFormat(window.name)]
        : ['split-window', ...common, '-t', target];
    const runtimeId = await this.tmux.call([...args, '--', process.execPath, runnerPath, launch]);
    const deadline = Date.now() + 10000;
    while (await this.tmux.getOption(runtimeId, '@ts-pane-owner') !== OWNER) {
      if (Date.now() > deadline) throw new ToolError('LAUNCHER_TIMEOUT', `Launcher did not initialize ${session.id}/${window.id}/${pane.id}; resource retained for inspection.`);
      await delay(50);
    }
    if (activate) await this.tmux.option('p', runtimeId, '@ts-ready', await this.tmux.getOption(runtimeId, '@ts-token'));
    return runtimeId;
  }
  private async createWindow(session: DesiredSession, window: DesiredWindow, scope: 'session' | 'window', target: string, generation: string): Promise<void> {
    const first = await this.createPane(session, window, window.panes[0]!, scope, target, generation, false);
    const pending = [first];
    const wid = await this.tmux.call(['display-message', '-p', '-t', first, '#{window_id}']);
    if (scope === 'session') {
      const sid = await this.tmux.call(['display-message', '-p', '-t', first, '#{session_id}']);
      await this.setDescription('s', sid, session.description ?? '');
    }
    for (const pane of window.panes.slice(1)) pending.push(await this.createPane(session, window, pane, 'pane', wid, generation, false));
    await this.tmux.call(['select-layout', '-t', wid, window.layout]);
    await this.tmux.option('w', wid, '@ts-layout', window.layout);
    await this.setDescription('w', wid, window.description ?? '');
    await this.tmux.option('w', wid, '@ts-initialized', '1');
    for (const pid of pending) await this.tmux.option('p', pid, '@ts-ready', await this.tmux.getOption(pid, '@ts-token'));
  }
  private async execute(op: Operation, desired: DesiredSession[], generation: string): Promise<void> {
    const [sid, wid, pid] = op.target.split('/');
    const session = desired.find(s => s.id === sid)!;
    const window = session.windows.find(w => w.id === wid);
    const current = await inspect(this.tmux);
    const a = current.sessions.find(s => s.owned && s.id === sid);
    const w = a?.windows.find(w => w.owned && w.id === wid);
    switch (op.kind) {
      case 'create-session': {
        await this.createWindow(session, session.windows[0]!, 'session', '', generation);
        const created = (await inspect(this.tmux)).sessions.find(s => s.owned && s.id === sid)!;
        await this.tmux.option('s', created.runtimeId, 'status', session.profile === 'immersive' ? 'off' : 'on');
        await this.tmux.option('s', created.runtimeId, '@ts-profile', session.profile);
        for (const window of session.windows.slice(1)) await this.createWindow(session, window, 'window', created.runtimeId, generation);
        break;
      }
      case 'create-window': await this.createWindow(session, window!, 'window', a!.runtimeId, generation); break;
      case 'create-pane': await this.createPane(session, window!, window!.panes.find(p => p.id === pid)!, 'pane', w!.runtimeId, generation, w!.initialized); break;
      case 'rename-session': await this.tmux.call(['rename-session', '-t', a!.runtimeId, await this.tmux.renameValue(session.name)]); break;
      case 'rename-window': await this.tmux.call(['rename-window', '-t', w!.runtimeId, await this.tmux.renameValue(window!.name)]); break;
      case 'session-description': await this.setDescription('s', a!.runtimeId, session.description ?? ''); break;
      case 'window-description': await this.setDescription('w', w!.runtimeId, window!.description ?? ''); break;
      case 'profile':
        await this.tmux.option('s', a!.runtimeId, 'status', session.profile === 'immersive' ? 'off' : 'on');
        await this.tmux.option('s', a!.runtimeId, '@ts-profile', session.profile); break;
      case 'activate': {
        const pane = w!.panes.find(p => p.owned && p.id === pid)!;
        if (pane.state === 'pending' && !pane.dead) await this.activate(pane);
        break;
      }
      case 'initialize-window':
        await this.tmux.call(['select-layout', '-t', w!.runtimeId, window!.layout]);
        await this.tmux.option('w', w!.runtimeId, '@ts-layout', window!.layout);
        await this.tmux.option('w', w!.runtimeId, '@ts-initialized', '1');
        for (const pane of w!.panes) {
          const desiredPane = window!.panes.find(p => p.id === pane.id);
          if (pane.owned && pane.state === 'pending' && !pane.dead && desiredPane && JSON.stringify(pane.spec) === JSON.stringify(desiredPane.spec)) await this.activate(pane);
        }
        break;
    }
  }
  async apply(load: () => Promise<DesiredSession[]>, requireExisting = false): Promise<{ plan: Plan; completed: Operation[]; state: Snapshot }> {
    return withLock(this.tmux.socket, async () => {
      const desired = await load();
      const changes = plan(desired, await inspect(this.tmux));
      if (changes.conflicts.length) throw new ToolError('CONFLICT', 'Resolve workspace conflicts before applying.', changes);
      if (!changes.operations.length) return { plan: changes, completed: [], state: await inspect(this.tmux) };
      const generation = await this.ensureServer(requireExisting);
      const completed: Operation[] = [];
      try {
        // Finish structure/layout before releasing pending startup commands.
        const order = (op: Operation): number => op.kind === 'activate' ? 2 : op.kind === 'initialize-window' ? 1 : 0;
        for (const op of [...changes.operations].sort((a, b) => order(a) - order(b))) { await this.execute(op, desired, generation); completed.push(op); }
      } catch (error) {
        throw new ToolError('PARTIAL_APPLY', error instanceof Error ? error.message : String(error), { completed, next: 'Inspect status and plan; existing resources were retained.' });
      }
      const state = await inspect(this.tmux);
      const remaining = plan(desired, state);
      if (remaining.conflicts.length || remaining.operations.some(o => o.kind !== 'activate')) throw new ToolError('VERIFY_FAILED', 'Runtime state changed during apply.', remaining);
      return { plan: changes, completed, state };
    });
  }
  async destroy(id: string, reset: boolean, load: () => Promise<DesiredSession[]>): Promise<unknown> {
    return withLock(this.tmux.socket, async () => {
      // Validate reset before destroying anything.
      const desired = reset ? (await load()).filter(s => s.id === id) : [];
      if (reset && desired.length !== 1) throw new ToolError('NOT_FOUND', `No unique declared session ${id}.`);
      const matches = (await inspect(this.tmux)).sessions.filter(s => s.owned && s.id === id);
      if (matches.length > 1) throw new ToolError('CONFLICT', `Duplicate session identity: ${id}.`);
      const session = matches[0];
      if (session) {
        // Destroying a session also destroys its unmanaged descendants. Refuse.
        if (session.windows.some(w => !w.owned || w.panes.some(p => !p.owned))) throw new ToolError('UNOWNED_DESCENDANTS', 'Session contains unmanaged windows or panes; move them out before clearing.');
        await this.tmux.call(['kill-session', '-t', session.runtimeId]);
      }
      if (reset) await this.execute({ kind: 'create-session', target: id }, desired, await this.ensureServer());
      return { target: id, destroyed: Boolean(session), recreated: reset };
    });
  }
  async layout(target: string, desired: DesiredSession[]): Promise<unknown> {
    return withLock(this.tmux.socket, async () => {
      const [sid, wid, extra] = target.split('/');
      const spec = desired.find(s => s.id === sid)?.windows.find(w => w.id === wid);
      const windows = (await inspect(this.tmux)).sessions.filter(s => s.owned && s.id === sid).flatMap(s => s.windows.filter(w => w.owned && w.id === wid));
      if (extra || !spec || windows.length !== 1) throw new ToolError('NOT_FOUND', `No unique declared window ${target}.`);
      await this.tmux.call(['select-layout', '-t', windows[0]!.runtimeId, spec.layout]);
      await this.tmux.option('w', windows[0]!.runtimeId, '@ts-layout', spec.layout);
      return { target, layout: spec.layout };
    });
  }
}
