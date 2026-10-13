import { readFile, readdir, stat, access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { homedir, userInfo } from 'node:os';
import { Ajv } from 'ajv';
import { parseDocument } from 'yaml';
import { WorkspaceSchema, type Workspace } from './schema.js';

export class ToolError extends Error {
  constructor(public code: string, message: string, public details?: unknown) { super(message); }
}
const validate = new Ajv({ allErrors: true, strict: false }).compile<Workspace>(WorkspaceSchema);
export type PaneSpec = { cwd: string; shell: string; sticky: boolean; argv: string[] | null; startupScope: 'pane' | 'window' };
export type DesiredPane = { id: string; spec: PaneSpec };
export type DesiredWindow = { id: string; name: string; layout: string; panes: DesiredPane[] };
export type DesiredSession = { id: string; name: string; profile: 'minimal' | 'immersive'; autostart: boolean; windows: DesiredWindow[]; source: string };
export const configHome = () => join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'termspaces');
export const stateHome = () => join(process.env.XDG_STATE_HOME || join(homedir(), '.local/state'), 'termspaces');
export const defaultConfig = () => join(configHome(), 'workspaces');
export function expandPath(value: string, base: string): string {
  if (value === '~') return homedir();
  if (value.startsWith('~/')) return resolve(homedir(), value.slice(2));
  if (value.startsWith('~')) throw new ToolError('INVALID_PATH', 'Only ~ and ~/ home expansion are supported.');
  return isAbsolute(value) ? resolve(value) : resolve(base, value);
}
function unique(ids: string[], scope: string): void {
  if (new Set(ids).size !== ids.length) throw new ToolError('DUPLICATE_ID', `Duplicate IDs in ${scope}.`);
}
export async function loadConfig(path = defaultConfig(), checkPaths = true): Promise<DesiredSession[]> {
  const full = expandPath(path, process.cwd());
  let files: string[];
  try {
    files = (await stat(full)).isDirectory()
      ? (await readdir(full)).filter(f => /\.ya?ml$/.test(f)).sort().map(f => join(full, f)) : [full];
  } catch { throw new ToolError('CONFIG_NOT_FOUND', `Configuration not found: ${full}. Run termspaces init first.`); }
  if (!files.length) throw new ToolError('EMPTY_CONFIG', `No YAML workspaces in ${full}.`);
  const sessions: DesiredSession[] = [];
  for (const file of files) {
    const doc = parseDocument(await readFile(file, 'utf8'), { uniqueKeys: true });
    if (doc.errors.length) throw new ToolError('INVALID_YAML', `${file}: ${doc.errors.map(e => e.message).join('; ')}`);
    let value: unknown;
    try { value = doc.toJS({ maxAliasCount: 50 }); } catch { throw new ToolError('INVALID_YAML', `${file}: excessive YAML aliases.`); }
    if (!validate(value)) throw new ToolError('INVALID_CONFIG', `${file}: schema validation failed.`, validate.errors);
    const base = expandPath(value.session.cwd, dirname(file));
    unique(value.windows.map(w => w.id), `${value.session.id}/windows`);
    const windows: DesiredWindow[] = [];
    for (const w of value.windows) {
      unique(w.panes.map(p => p.id), `${value.session.id}/${w.id}/panes`);
      const cwd = w.cwd ? expandPath(w.cwd, base) : base;
      const panes: DesiredPane[] = [];
      for (const p of w.panes) {
        const windowStartup = p === w.panes[0] && w.startup?.mode === 'on-create';
        if (windowStartup && p.startup) throw new ToolError('AMBIGUOUS_STARTUP', `Use either window startup or first-pane startup in ${value.session.id}/${w.id}, not both.`);
        const startup = windowStartup ? w.startup : p.startup;
        const paneCwd = p.cwd ? expandPath(p.cwd, cwd) : cwd;
        const shell = p.shell || userInfo().shell || '/bin/sh';
        if (!isAbsolute(shell)) throw new ToolError('INVALID_SHELL', `Shell must be an absolute executable path: ${shell}`);
        if (startup?.mode === 'on-create' && !startup.argv[0]) throw new ToolError('INVALID_COMMAND', 'Startup executable must not be empty.');
        if (checkPaths) {
          try {
            if (!(await stat(paneCwd)).isDirectory()) throw new Error();
            await access(shell, constants.X_OK);
          } catch { throw new ToolError('INVALID_PATH', `Directory or shell unavailable for ${value.session.id}/${w.id}/${p.id}: ${paneCwd}, ${shell}`); }
        }
        panes.push({ id: p.id, spec: { cwd: paneCwd, shell, sticky: p.sticky ?? true, argv: startup?.mode === 'on-create' ? startup.argv : null, startupScope: windowStartup ? 'window' : 'pane' } });
      }
      windows.push({ id: w.id, name: w.name || w.id, layout: w.layout || 'tiled', panes });
    }
    sessions.push({ id: value.session.id, name: value.session.name || value.session.id, profile: value.session.profile || 'minimal', autostart: value.session.autostart ?? false, windows, source: file });
  }
  unique(sessions.map(s => s.id), 'sessions');
  unique(sessions.map(s => s.name), 'session names');
  return sessions;
}
