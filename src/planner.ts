import type { DesiredSession } from './config.js';
import type { Snapshot } from './state.js';

export type Operation = { kind: 'create-session' | 'create-window' | 'create-pane' | 'rename-session' | 'rename-window' | 'profile' | 'activate' | 'initialize-window'; target: string; runtimeId?: string };
export type Difference = { target: string; reason: string };
export type Plan = { operations: Operation[]; deferred: Difference[]; conflicts: Difference[] };
export function plan(desired: DesiredSession[], actual: Snapshot): Plan {
  const result: Plan = { operations: [], deferred: [], conflicts: [] };
  const conflict = (target: string, reason: string) => result.conflicts.push({ target, reason });
  const deferred = (target: string, reason: string) => result.deferred.push({ target, reason });
  // Unknown interrupted launchers must block creation rather than produce duplicates.
  for (const s of actual.sessions) for (const w of s.windows) for (const p of w.panes) if (p.orphanLauncher) conflict(`${s.name}/${w.name}/${p.runtimeId}`, 'Uninitialized internal launcher; inspect it before clearing this exact resource.');
  for (const session of desired) {
    const matches = actual.sessions.filter(s => s.owned && s.id === session.id);
    if (matches.length > 1) { conflict(session.id, 'Duplicate managed session identity.'); continue; }
    const a = matches[0];
    if (actual.sessions.some(s => s.name === session.name && s !== a)) { conflict(session.id, 'Session display name belongs to another resource.'); continue; }
    if (!a) { result.operations.push({ kind: 'create-session', target: session.id }); continue; }
    if (a.name !== session.name) result.operations.push({ kind: 'rename-session', target: session.id, runtimeId: a.runtimeId });
    if (a.profile !== session.profile) result.operations.push({ kind: 'profile', target: session.id, runtimeId: a.runtimeId });
    for (const window of session.windows) {
      const target = `${session.id}/${window.id}`;
      const matches = a.windows.filter(w => w.owned && w.id === window.id);
      if (matches.length > 1) { conflict(target, 'Duplicate managed window identity.'); continue; }
      const aw = matches[0];
      if (!aw) {
        if (a.windows.some(w => !w.owned && w.name === window.name)) conflict(target, 'Unowned window has this display name.');
        else result.operations.push({ kind: 'create-window', target });
        continue;
      }
      if (aw.name !== window.name) result.operations.push({ kind: 'rename-window', target, runtimeId: aw.runtimeId });
      if (!aw.initialized) result.operations.push({ kind: 'initialize-window', target, runtimeId: aw.runtimeId });
      else if (aw.layout !== window.layout) deferred(target, 'Layout changed; run layout explicitly.');
      for (const pane of window.panes) {
        const ptarget = `${target}/${pane.id}`;
        const matches = aw.panes.filter(p => p.owned && p.id === pane.id);
        if (matches.length > 1) { conflict(ptarget, 'Duplicate managed pane identity.'); continue; }
        const ap = matches[0];
        if (!ap) result.operations.push({ kind: 'create-pane', target: ptarget });
        else {
          const unchanged = JSON.stringify(ap.spec) === JSON.stringify(pane.spec);
          if (!unchanged) deferred(ptarget, 'Initial directory, shell, sticky setting or startup command changed; reset explicitly to recreate.');
          if (unchanged && ap.state === 'pending' && !ap.dead) result.operations.push({ kind: 'activate', target: ptarget, runtimeId: ap.runtimeId });
          if (ap.dead) deferred(ptarget, 'Pane has exited; apply does not restart commands.');
        }
      }
      for (const p of aw.panes) if (p.owned && !window.panes.some(d => d.id === p.id)) deferred(`${target}/${p.id}`, 'No longer declared; retained.');
    }
    for (const w of a.windows) if (w.owned && !session.windows.some(d => d.id === w.id)) deferred(`${session.id}/${w.id}`, 'No longer declared; retained.');
  }
  for (const s of actual.sessions) if (s.owned && !desired.some(d => d.id === s.id)) deferred(s.id, 'No longer declared; retained.');
  return result;
}
