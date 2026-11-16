/**
 * Scale benchmark. Builds a repository of 10,000 files with 1,500 uncommitted changed files
 * (about +13.5k/-9k lines), starts a server in-process and measures the review API.
 *
 *   node --experimental-transform-types --no-warnings test/perf/scale.ts [dir]
 *
 * Targets: warm GET review < 50 ms, GET after one change < 150 ms, cold < 1.5 s, payload < 1 MB.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../../src/server/server.ts';

const dir = process.argv[2] ?? fs.mkdtempSync(path.join(os.tmpdir(), 'margin-scale-'));
const FILES = 10_000;
const CHANGED = 1_500;
const sh = (...a: string[]) => execFileSync('git', a, { cwd: dir, encoding: 'utf8', maxBuffer: 1 << 30 });

function content(i: number, changed: boolean): string {
  const out: string[] = [];
  for (let k = 0; k < 60; k++) {
    if (changed && k >= 20 && k < 26) out.push(`  const v${k} = compute${k}(input, ${i}); // changed`);
    else out.push(`  const v${k} = compute${k}(input, ${i});`);
    if (changed && k === 40) out.push('  // added 1', '  // added 2', '  // added 3');
  }
  return `export function f${i}(input: number) {\n${out.join('\n')}\n}\n`;
}
// 10,000 files in 500 directories (20 per directory), 25 top-level packages.
const file = (i: number) => path.join(dir, `pkg${i % 25}`, `mod${Math.floor(i / 25) % 20}`, `f${i}.ts`);

fs.rmSync(dir, { recursive: true, force: true });
fs.mkdirSync(dir, { recursive: true });
sh('init', '-q', '-b', 'main');
sh('config', 'user.email', 'perf@example.com');
sh('config', 'user.name', 'perf');
for (let i = 0; i < FILES; i++) {
  fs.mkdirSync(path.dirname(file(i)), { recursive: true });
  fs.writeFileSync(file(i), content(i, false));
}
sh('add', '-A');
sh('commit', '-qm', 'base');
// Like a real checkout: the index is newer than the files, so git's stat cache is trusted.
await new Promise((r) => setTimeout(r, 1100));
sh('update-index', '-q', '--refresh');
const changedIdx = Array.from({ length: CHANGED }, (_, i) => Math.floor((i * FILES) / CHANGED));
for (const i of changedIdx) fs.writeFileSync(file(i), content(i, true));

const srv = await startServer({ cwd: dir, webDir: null, idleMs: 0, writeInfo: false });
function call(method: string, p: string, body?: unknown): Promise<{ ms: number; bytes: number; json: any }> {
  return new Promise((resolve, reject) => {
    const t = performance.now();
    const r = http.request({ host: '127.0.0.1', port: srv.port, method, path: p, headers: { 'content-type': 'application/json' } }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        resolve({ ms: performance.now() - t, bytes: buf.length, json: JSON.parse(buf.toString('utf8')) });
      });
    });
    r.on('error', reject);
    r.end(body === undefined ? undefined : JSON.stringify(body));
  });
}
const fmt = (r: { ms: number; bytes: number }) => `${r.ms.toFixed(0)} ms, ${(r.bytes / 1024).toFixed(0)} KiB`;
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;

await call('POST', '/api/reviews', { spec: { kind: 'working' } });
const cold = await call('GET', '/api/reviews/working');
const files = cold.json.files as Array<{ path: string; additions: number; deletions: number }>;
const add = files.reduce((n, f) => n + f.additions, 0);
const del = files.reduce((n, f) => n + f.deletions, 0);
console.log(`repo: ${FILES} files, ${files.length} changed, +${add} -${del}`);
console.log(`cold GET review:            ${fmt(cold)}`);
const warm: number[] = [];
for (let i = 0; i < 10; i++) warm.push((await call('GET', '/api/reviews/working')).ms);
console.log(`warm GET, no browser:       ${median(warm).toFixed(0)} ms (median of 10; full recompute)`);
const after: number[] = [];
for (let i = 0; i < 5; i++) {
  fs.appendFileSync(file(changedIdx[7]!), `// edit ${i}\n`);
  after.push((await call('GET', '/api/reviews/working')).ms);
}
console.log(`GET after one file changes: ${median(after).toFixed(0)} ms (median of 5)`);
const paths = files.slice(100, 150).map((f) => f.path);
const h1 = await call('POST', '/api/reviews/working/hunks', { paths });
const h2 = await call('POST', '/api/reviews/working/hunks', { paths });
console.log(`POST hunks, 50 paths:       cold ${fmt(h1)}, warm ${fmt(h2)}`);
const staged = await call('GET', '/api/reviews/working?scope=unstaged');
console.log(`GET review scope=unstaged:  ${fmt(staged)}`);
// With a browser open (SSE subscribed), GET review reuses a state up to 1 s old.
const sse = http.get({ host: '127.0.0.1', port: srv.port, path: '/api/reviews/working/events' });
sse.on('error', () => {});
await new Promise((r) => setTimeout(r, 300));
const live: number[] = [];
for (let i = 0; i < 10; i++) live.push((await call('GET', '/api/reviews/working')).ms);
console.log(`warm GET, browser open:     ${median(live).toFixed(0)} ms (median of 10)`);
sse.destroy();
const ticks: number[] = [];
for (let i = 0; i < 10; i++) {
  const t = performance.now();
  await srv.margin.compute('working');
  ticks.push(performance.now() - t);
}
console.log(`poll tick, nothing changed: ${median(ticks).toFixed(0)} ms (median of 10)`);
const conc = performance.now();
await Promise.all(Array.from({ length: 20 }, () => call('GET', '/api/reviews/working')));
console.log(`20 concurrent GET review:   ${(performance.now() - conc).toFixed(0)} ms total`);
console.log(`server RSS:                 ${(process.memoryUsage().rss / 1e6).toFixed(0)} MB (in-process; includes the benchmark)`);
const objs = sh('count-objects', '-v');
console.log(`repo loose objects after:   ${/^count: (\d+)/m.exec(objs)![1]} (snapshot objects go to .git/margin/objects)`);
await srv.close();
// A server restart keeps the private index (stat cache) and objects: the next "cold" GET is cheap.
const srv2 = await startServer({ cwd: dir, webDir: null, idleMs: 0, writeInfo: false });
{
  const t = performance.now();
  await srv2.margin.getReview('working');
  console.log(`GET review after restart:   ${(performance.now() - t).toFixed(0)} ms`);
}
await srv2.close();
if (!process.argv[2]) fs.rmSync(dir, { recursive: true, force: true });
