import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import { mkdir, lstat, open } from 'node:fs/promises';
import { join } from 'node:path';
import { ToolError } from './config.js';

export async function withLock<T>(socket: string, fn: () => Promise<T>): Promise<T> {
  const dir = join('/tmp', `termspaces-locks-${process.getuid!()}`);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const info = await lstat(dir);
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid!() || (info.mode & 0o077)) throw new ToolError('UNSAFE_LOCK_DIRECTORY', 'Lock directory must be owned by the user with mode 0700.');
  const file = join(dir, createHash('sha256').update(socket).digest('hex') + '.lock');
  // Linux flock locks the open file description, shared across inherited FDs.
  // The helper locks FD 3, then exits; this process keeps the same description
  // open until fn completes. Kernel cleanup releases it if this process dies.
  const handle = await open(file, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn('flock', ['--exclusive', '--timeout', '30', '3'], { stdio: ['ignore', 'ignore', 'pipe', handle.fd] });
      let error = '';
      child.stderr!.on('data', b => { error += b; });
      child.once('error', e => reject(new ToolError('DEPENDENCY_MISSING', `flock: ${e.message}`)));
      child.once('close', code => code === 0 ? resolve() : reject(new ToolError('LOCK_TIMEOUT', error || 'Could not acquire the workspace lock within 30 seconds.')));
    });
    return await fn();
  } finally { await handle.close(); }
}
