import { readdir, readFile, access } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
const root = resolve(import.meta.dirname, '..');
async function markdown(dir) {
  const result = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (['.git', '.temp', 'temp', 'node_modules', 'dist'].includes(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) result.push(...await markdown(path));
    else if (entry.name.endsWith('.md')) result.push(path);
  }
  return result;
}
let broken = 0;
for (const path of await markdown(root)) {
  const source = await readFile(path, 'utf8');
  for (const match of source.matchAll(/\]\(([^)]+)\)/g)) {
    const link = match[1].split('#')[0];
    if (!link || /^[a-z]+:/.test(link)) continue;
    try { await access(resolve(dirname(path), decodeURIComponent(link))); }
    catch { console.error(`${path}: missing ${link}`); broken++; }
  }
}
if (broken) process.exitCode = 1;
else console.log('Local Markdown file links passed.');
