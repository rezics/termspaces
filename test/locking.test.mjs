import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { fixture, root } from './helpers.mjs';
import { withLock } from '../dist/locking.js';

test('lock is held by the writer after flock helper exits and released on SIGKILL', { timeout: 10000 }, async t => {
  const f = await fixture(t);
  const module = pathToFileURL(join(root, 'dist/locking.js')).href;
  const script = `import {withLock} from ${JSON.stringify(module)}; await withLock(${JSON.stringify(f.socket)}, async()=>{process.stdout.write('locked\\n'); await new Promise(()=>setInterval(()=>{},1000));});`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => child.kill('SIGKILL'));
  await once(child.stdout, 'data');
  let acquired = false;
  const pending = withLock(f.socket, async () => { acquired = true; });
  await new Promise(resolve => setTimeout(resolve, 200));
  assert.equal(acquired, false);
  child.kill('SIGKILL'); await once(child, 'close');
  await pending; assert.equal(acquired, true);
});
