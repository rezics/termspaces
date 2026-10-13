import { spawn } from 'node:child_process';
import { mkdir, lstat, realpath } from 'node:fs/promises';
import { join, resolve, dirname, basename } from 'node:path';
import { realpathSync } from 'node:fs';
import { ToolError } from './config.js';

export const OWNER = 'termspaces/v1';
// tmux parses command separators even when no outer shell is involved.
export const encodeTmuxArg = (arg: string): string => arg.endsWith(';') ? arg.slice(0, -1) + '\\;' : arg;
export const literalFormat = (arg: string): string => arg.replaceAll('#', '##');
export function canonicalPath(input: string): string {
  let parent = resolve(input);
  const missing: string[] = [];
  for (;;) {
    try { return join(realpathSync(parent), ...missing.reverse()); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const next = dirname(parent);
      if (next === parent) throw error;
      missing.push(basename(parent)); parent = next;
    }
  }
}
export const renameExpandsFormats = (version: string): boolean => {
  const match = /tmux (\d+)\.(\d+)/.exec(version);
  if (!match) throw new ToolError('UNSUPPORTED_TMUX', `Unrecognized tmux version: ${version}`);
  return Number(match[1]) > 3 || (Number(match[1]) === 3 && Number(match[2]) >= 6);
};
export async function run(binary: string, args: string[], timeout = 10000): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { stdio: ['ignore', 'pipe', 'pipe'], shell: false });
    let stdout = '', stderr = '', exceeded = false;
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new ToolError('COMMAND_TIMEOUT', `${binary} timed out.`)); }, timeout);
    child.stdout.on('data', b => { stdout += b; if (stdout.length > 16 * 1024 * 1024) { exceeded = true; child.kill('SIGKILL'); } });
    child.stderr.on('data', b => { stderr += b; if (stderr.length > 1024 * 1024) { exceeded = true; child.kill('SIGKILL'); } });
    child.on('error', error => { clearTimeout(timer); reject(new ToolError('DEPENDENCY_MISSING', `${binary}: ${error.message}`)); });
    child.on('close', code => { clearTimeout(timer); if (exceeded) reject(new ToolError('OUTPUT_LIMIT', `${binary} exceeded the output limit.`)); else resolve({ stdout, stderr, code: code ?? 1 }); });
  });
}
export async function socketPath(name: string): Promise<string> {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(name)) throw new ToolError('INVALID_SOCKET', 'Socket must be a simple name (letters, digits, - or _).');
  const root = await realpath(process.env.TMUX_TMPDIR || '/tmp');
  return join(root, `tmux-${process.getuid!()}`, name);
}
export class Tmux {
  constructor(public socket: string) { this.socket = canonicalPath(socket); }
  async prepare(): Promise<void> {
    const version = await this.getVersion();
    const match = /tmux (\d+)\.(\d+)/.exec(version);
    if (!match || Number(match[1]) < 3 || (Number(match[1]) === 3 && Number(match[2]) < 3)) throw new ToolError('UNSUPPORTED_TMUX', 'tmux 3.3 or newer is required.');
    await mkdir(dirname(this.socket), { recursive: true, mode: 0o700 });
    const dir = await lstat(dirname(this.socket));
    if (!dir.isDirectory() || dir.isSymbolicLink() || dir.uid !== process.getuid!() || (dir.mode & 0o077)) throw new ToolError('UNSAFE_SOCKET_DIRECTORY', 'tmux socket directory must belong to the current user with mode 0700.');
  }
  async getVersion(): Promise<string> {
    // Commands execute in the retained server, which may predate a client upgrade.
    const server = await run('tmux', ['-S', this.socket, 'display-message', '-p', '#{version}']);
    return server.code === 0 && server.stdout.trim() ? `tmux ${server.stdout.trim()}` : (await run('tmux', ['-V'])).stdout.trim();
  }
  async renameValue(name: string): Promise<string> {
    return renameExpandsFormats(await this.getVersion()) ? literalFormat(name) : name;
  }
  async call(args: string[], allowFailure = false): Promise<string> {
    const result = await run('tmux', ['-S', this.socket, ...args.map(encodeTmuxArg)]);
    if (result.code && !allowFailure) throw new ToolError('TMUX_ERROR', result.stderr.trim() || `tmux exited ${result.code}.`);
    return result.stdout.replace(/\n$/, '');
  }
  async option(scope: 's' | 'w' | 'p', target: string, key: string, value: string): Promise<void> {
    await this.call(['set-option', ...(scope === 's' ? [] : [`-${scope}`]), '-t', target, key, value]);
  }
  async getOption(target: string, key: string): Promise<string> {
    return this.call(['show-options', '-p', '-qv', '-t', target, key]);
  }
  async ownOption(scope: 's' | 'w' | 'p', target: string, key: string): Promise<string> {
    return this.call(['show-options', ...(scope === 's' ? [] : [`-${scope}`]), '-qv', '-t', target, key]);
  }
  async exists(): Promise<boolean> {
    const r = await run('tmux', ['-S', this.socket, 'show-options', '-s', '-v', 'exit-empty']);
    if (r.code && !/no server running|error connecting|failed to connect/.test(r.stderr)) throw new ToolError('TMUX_ERROR', r.stderr.trim());
    return r.code === 0;
  }
}
