import { execFile, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ServerEvent, Thread, WaitResponse } from '../src/shared/types.ts';
import { startServer, type RunningServer } from '../src/server/server.ts';
import { lines, TempRepo } from './helpers.ts';

/** Workspace of the test repo. Per-workspace paths ("/api/reviews") are sent to /api/w/<ws>/. */
let WS = '';
const GLOBAL = /^\/api\/(health|workspaces|dashboard|events|shutdown|w\/)/;
export function wsPath(p: string): string {
  return p.startsWith('/api/') && !GLOBAL.test(p) ? `/api/w/${WS}/${p.slice(5)}` : p;
}

function req<T = any>(port: number, method: string, p: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; json: T }> {
  p = wsPath(p);
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : JSON.stringify(body);
    const r = http.request({ host: '127.0.0.1', port, method, path: p, headers: { 'content-type': 'application/json', ...headers } }, (res) => {
      let text = '';
      res.on('data', (c) => (text += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, json: text ? JSON.parse(text) : null }));
    });
    r.on('error', reject);
    r.end(data);
  });
}

function sse(port: number, p: string) {
  p = wsPath(p);
  const events: ServerEvent[] = [];
  let raw = '';
  const r = http.get({ host: '127.0.0.1', port, path: p }, (res) => {
    res.setEncoding('utf8');
    res.on('data', (c: string) => {
      raw += c;
      let i;
      while ((i = raw.indexOf('\n\n')) >= 0) {
        const block = raw.slice(0, i);
        raw = raw.slice(i + 2);
        for (const line of block.split('\n')) if (line.startsWith('data: ')) events.push(JSON.parse(line.slice(6)));
      }
    });
  });
  r.on('error', () => {});
  return {
    events,
    close: () => r.destroy(),
    async waitFor(pred: (e: ServerEvent) => boolean, ms = 4000): Promise<ServerEvent> {
      const end = Date.now() + ms;
      while (Date.now() < end) {
        const e = events.find(pred);
        if (e) return e;
        await new Promise((res) => setTimeout(res, 25));
      }
      throw new Error(`event not received; got ${JSON.stringify(events.map((e) => e.type))}`);
    },
  };
}

describe('HTTP end to end', () => {
  let repo: TempRepo;
  let srv: RunningServer | null = null;
  let home = '';
  afterEach(async () => {
    await srv?.close();
    srv = null;
    repo?.cleanup();
    if (home) fs.rmSync(home, { recursive: true, force: true });
  });

  async function setup(extra = {}) {
    repo = new TempRepo();
    repo.write('app.ts', lines(20));
    repo.commit();
    repo.write('app.ts', lines(20).replace('line 4\n', 'line four\n'));
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'rede-home-'));
    srv = await startServer({ home, workspaces: [repo.dir], port: 0, webDir: null, pollMs: 100, idleMs: 0, presenceLingerMs: 0, ...extra });
    WS = srv.workspaces[0]!;
    return srv.port;
  }

  it('serves health, rejects foreign hosts and origins, serves the not-built page', async () => {
    const port = await setup();
    const h = await req(port, 'GET', '/api/health');
    expect(h.json).toMatchObject({ ok: true, name: 'rede', pid: process.pid });
    expect((await req(port, 'GET', '/api/health', undefined, { host: 'evil.example:80' })).status).toBe(403);
    expect((await req(port, 'POST', '/api/reviews', { spec: { kind: 'working' } }, { origin: 'http://evil.example' })).status).toBe(403);
    expect((await req(port, 'POST', '/api/reviews', { spec: { kind: 'working' } }, { origin: `http://127.0.0.1:${port}` })).status).toBe(200);
    const info = JSON.parse(fs.readFileSync(path.join(home, 'server.json'), 'utf8'));
    expect(info).toMatchObject({ pid: process.pid, port });
    const page = await new Promise<string>((resolve) => http.get({ host: '127.0.0.1', port, path: '/r/working' }, (res) => {
      let t = '';
      res.on('data', (c) => (t += c));
      res.on('end', () => resolve(t));
    }));
    expect(page).toContain('not built');
    expect((await req(port, 'GET', '/api/reviews/working?scope=bogus')).status).toBe(400);
  });

  it('runs the review conversation: SSE, wait, reply, live diff refresh', async () => {
    const port = await setup();
    await req(port, 'POST', '/api/reviews', { spec: { kind: 'working' } });
    const stream = sse(port, '/api/reviews/working/events');
    await stream.waitFor((e) => e.type === 'agents');

    const waitP = req<WaitResponse>(port, 'GET', '/api/agent/wait?agent=claude&timeout=10');
    await stream.waitFor((e) => e.type === 'agents' && e.agents.some((a) => a.name === 'claude' && a.state === 'waiting'));

    const created = await req<Thread>(port, 'POST', '/api/reviews/working/threads', {
      anchor: { path: 'app.ts', side: 'new', startLine: 4, endLine: 4 },
      body: 'Why `four`?\n\n```ts\ncode()\n```',
      author: { kind: 'human', name: 'you' },
    });
    expect(created.status).toBe(200);
    const waited = await waitP;
    expect(waited.json.threads).toHaveLength(1);
    expect(waited.json.threads[0]!.diffContext).toContain('+line four');
    await stream.waitFor((e) => e.type === 'thread' && e.thread.agentState === 'working');

    const reply = await req<Thread>(port, 'POST', `/api/threads/${created.json.id}/messages`, { body: 'Because.', author: { kind: 'agent', name: 'claude' } });
    expect(reply.json.agentState).toBe('idle');
    await stream.waitFor((e) => e.type === 'thread' && e.thread.messages.length === 2);

    const before = (await req(port, 'GET', '/api/reviews/working')).json.diffFingerprint;
    repo.write('app.ts', repo.read('app.ts') + 'appended\n');
    const ev = await stream.waitFor((e) => e.type === 'diff-changed');
    expect(ev).toMatchObject({ type: 'diff-changed' });
    expect((ev as { diffFingerprint: string }).diffFingerprint).not.toBe(before);

    await req(port, 'PUT', '/api/reviews/working/viewed', { path: 'app.ts', viewed: true });
    await stream.waitFor((e) => e.type === 'viewed');
    stream.close();
  });

  it('queues a review, submits it as one batch, discards the next one', async () => {
    const port = await setup();
    await req(port, 'POST', '/api/reviews', { spec: { kind: 'working' } });
    const stream = sse(port, '/api/reviews/working/events');
    await stream.waitFor((e) => e.type === 'agents');
    const human = { kind: 'human', name: 'you' };
    const queue = (line: number) =>
      req<Thread>(port, 'POST', '/api/reviews/working/threads', { anchor: { path: 'app.ts', side: 'new', startLine: line, endLine: line }, body: `c${line}`, author: human, pending: true });
    expect((await queue(4)).json.messages[0]).toMatchObject({ pending: true });
    await queue(8);
    await stream.waitFor((e) => e.type === 'pending' && e.pendingCount === 2);
    const agentPending = await req(port, 'POST', '/api/reviews/working/threads', {
      anchor: { path: 'app.ts', side: 'new', startLine: 9, endLine: 9 },
      body: 'x',
      author: { kind: 'agent', name: 'claude' },
      pending: true,
    });
    expect(agentPending.status).toBe(400);
    expect((await req(port, 'GET', '/api/agent/threads?state=all')).json).toEqual([]);

    const sub = await req(port, 'POST', '/api/reviews/working/submit', { mode: 'implement', body: 'Go' });
    expect(sub.status).toBe(200);
    expect(sub.json).toMatchObject({ mode: 'implement', body: 'Go', threadIds: expect.any(Array) });
    await stream.waitFor((e) => e.type === 'batch' && e.batch.id === sub.json.id && e.pendingCount === 0);
    expect((await req(port, 'POST', '/api/reviews/working/submit', { mode: 'discuss' })).status).toBe(400);
    const review = (await req(port, 'GET', '/api/reviews/working')).json;
    expect(review).toMatchObject({ pendingCount: 0, batches: [sub.json] });

    const w = await req<WaitResponse>(port, 'GET', '/api/agent/wait?agent=claude&timeout=2');
    expect(w.json.threads).toHaveLength(2);
    expect(w.json.batches).toEqual([sub.json]);

    const t = await queue(12);
    expect((await req(port, 'DELETE', '/api/reviews/working/pending')).json).toEqual({ ok: true });
    await stream.waitFor((e) => e.type === 'thread-deleted' && e.threadId === t.json.id);
    await stream.waitFor((e) => e.type === 'pending' && e.pendingCount === 0);
    stream.close();
  });

  it('drops SSE subscribers and waiters when clients disconnect', async () => {
    const port = await setup();
    await req(port, 'POST', '/api/reviews', { spec: { kind: 'working' } });
    const streams = Array.from({ length: 20 }, () => sse(port, '/api/reviews/working/events'));
    await Promise.all(streams.map((s) => s.waitFor((e) => e.type === 'agents')));
    expect(srv!.hub.subscriberCount).toBe(20);
    const waits = Array.from({ length: 5 }, (_, i) => {
      const r = http.get({ host: '127.0.0.1', port, path: wsPath(`/api/agent/wait?agent=a${i}&timeout=600`) });
      r.on('error', () => {});
      return r;
    });
    const until = async (f: () => boolean) => {
      for (let i = 0; i < 100 && !f(); i++) await new Promise((r) => setTimeout(r, 20));
      return f();
    };
    expect(await until(() => srv!.hub.waiterCount === 5)).toBe(true);
    for (const s of streams) s.close();
    for (const w of waits) w.destroy();
    expect(await until(() => srv!.hub.subscriberCount === 0 && srv!.hub.waiterCount === 0)).toBe(true);
  });

  it('persists threads across a restart', async () => {
    const port = await setup();
    await req(port, 'POST', '/api/reviews', { spec: { kind: 'working' } });
    await req(port, 'POST', '/api/reviews/working/threads', {
      anchor: { path: 'app.ts', side: 'new', startLine: null, endLine: null },
      body: 'File-level note',
      author: { kind: 'human', name: 'you' },
    });
    await srv!.close();
    srv = await startServer({ home, workspaces: [repo.dir], port: 0, webDir: null, idleMs: 0 });
    const r = await req(srv.port, 'GET', '/api/reviews/working');
    expect(r.json.threads.map((t: Thread) => t.messages[0]!.body)).toEqual(['File-level note']);
    const pending = await req(srv.port, 'GET', '/api/agent/threads?state=pending');
    expect(pending.json).toHaveLength(1);
  });

  it('shuts down when idle', async () => {
    let exited = false;
    await setup({ idleMs: 300, onExit: () => (exited = true) });
    await new Promise((r) => setTimeout(r, 900));
    expect(exited).toBe(true);
    expect(fs.existsSync(path.join(repo.dir, '.git', 'rede', 'server.json'))).toBe(false);
    srv = null;
  });

  it('does not shut down while an agent waits', async () => {
    let exited = false;
    const port = await setup({ idleMs: 300, onExit: () => (exited = true) });
    const w = req(port, 'GET', '/api/agent/wait?agent=x&timeout=1');
    await new Promise((r) => setTimeout(r, 700));
    expect(exited).toBe(false);
    await w;
  });
});

const CLI = path.resolve(__dirname, '..', 'dist', 'cli.js');

describe.skipIf(!fs.existsSync(CLI))('CLI (built bundle)', () => {
  let repo: TempRepo;
  // Never the user's own hub: a private home and a random port.
  let home = '';
  const baseEnv = () => ({ ...process.env, CLAUDECODE: '', REDE_AGENT: '', REDE_HOME: home, REDE_PORT: '0', REDE_OPEN: 'browser' });
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'rede-hub-'));
  });
  afterEach(() => {
    spawnSync(process.execPath, [CLI, 'stop'], { cwd: repo.dir, env: baseEnv() });
    repo?.cleanup();
    fs.rmSync(home, { recursive: true, force: true });
  });

  const run = (args: string[], input?: string, env: Record<string, string> = {}) =>
    new Promise<{ code: number; out: string; err: string }>((resolve) => {
      const child = execFile(process.execPath, [CLI, ...args], { cwd: repo.dir, env: { ...baseEnv(), ...env } }, (e, out, err) =>
        resolve({ code: e ? ((e as { code?: number }).code ?? 1) : 0, out, err }),
      );
      child.stdin?.end(input ?? '');
    });

  it('replaces a server started by an older build, on the same port', async () => {
    repo = new TempRepo();
    repo.write('a.txt', 'x\n');
    repo.commit();
    await run(['list']);
    const file = path.join(home, 'server.json');
    const first = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(first.build).toBeGreaterThan(0);
    const waiting = run(['wait', '--timeout', '20']);
    await new Promise((r) => setTimeout(r, 800));
    fs.writeFileSync(file, JSON.stringify({ ...first, build: 1 })); // pretend an older build runs
    await run(['list']);
    const second = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(second.pid).not.toBe(first.pid);
    expect(second.port).toBe(first.port);
    const w = await waiting;
    expect(w.code).toBe(0);
    expect(w.out).toContain('rede wait');
  }, 30_000);

  const infoFile = () => path.join(home, 'server.json');
  const readInfo = () => JSON.parse(fs.readFileSync(infoFile(), 'utf8'));

  it('never replaces a server started by a newer build', async () => {
    repo = new TempRepo();
    repo.write('a.txt', 'x\n');
    repo.commit();
    await run(['list']);
    const first = readInfo();
    fs.writeFileSync(infoFile(), JSON.stringify({ ...first, build: first.build + 60_000 })); // a newer CLI started it
    for (let i = 0; i < 3; i++) expect((await run(['list'])).code).toBe(0);
    expect(readInfo().pid).toBe(first.pid);
  }, 30_000);

  it('keeps using an older server when it cannot take the start lock (sandbox)', async () => {
    repo = new TempRepo();
    repo.write('a.txt', 'x\n');
    repo.commit();
    await run(['list']);
    const first = readInfo();
    fs.writeFileSync(infoFile(), JSON.stringify({ ...first, build: 1 }));
    const dir = path.dirname(infoFile());
    fs.chmodSync(dir, 0o555);
    try {
      const r = await run(['threads']);
      expect(r.err).toBe('');
      expect(r.code).toBe(0);
    } finally {
      fs.chmodSync(dir, 0o755);
    }
    expect(readInfo().pid).toBe(first.pid);
  }, 30_000);

  it('fails fast and says why when it may not start a server', async () => {
    repo = new TempRepo();
    repo.write('a.txt', 'x\n');
    repo.commit();
    fs.chmodSync(home, 0o555);
    const t0 = Date.now();
    let r;
    try {
      r = await run(['wait', '--timeout', '5']);
    } finally {
      fs.chmodSync(home, 0o755);
    }
    expect(Date.now() - t0).toBeLessThan(4000);
    expect(r.code).toBe(1);
    expect(r.err).toContain('no Rede server runs, and this command may not start one');
    expect(r.err).toContain('(EACCES)');
    expect(r.err).not.toContain('start.lock');
  }, 30_000);

  it('removes a start lock left by a process that is gone, at once', async () => {
    repo = new TempRepo();
    repo.write('a.txt', 'x\n');
    repo.commit();
    const dead = spawnSync(process.execPath, ['-e', '0']).pid!;
    fs.writeFileSync(path.join(home, 'start.lock'), String(dead));
    const t0 = Date.now();
    const r = await run(['threads']);
    expect(r.code).toBe(0);
    expect(Date.now() - t0).toBeLessThan(10_000);
  }, 30_000);

  it('never writes the real index (no .git/index.lock while the user runs git)', async () => {
    repo = new TempRepo();
    repo.write('a.txt', 'x\n');
    repo.commit();
    // A stat change without a content change: a plain `git status` would refresh the index and
    // write it back under .git/index.lock.
    const index = path.join(repo.dir, '.git', 'index');
    const before = fs.statSync(index).mtimeMs;
    const later = new Date(Date.now() + 5000);
    fs.utimesSync(path.join(repo.dir, 'a.txt'), later, later);
    await new Promise((r) => setTimeout(r, 20));
    const r = await run(['--no-open']);
    expect(r.code).toBe(0);
    expect(fs.statSync(index).mtimeMs).toBe(before);
    // Control: git itself does write it.
    repo.git('status', '--porcelain');
    expect(fs.statSync(index).mtimeMs).not.toBe(before);
  }, 30_000);

  it('publishes a branch review with a summary and prints its URL', async () => {
    repo = new TempRepo();
    repo.write('a.txt', 'x\n');
    repo.commit();
    repo.git('checkout', '-q', '-b', 'feature');
    repo.write('a.txt', 'y\n');
    repo.commit('change');
    repo.write('b.txt', 'uncommitted\n');
    const r = await run(['publish', '--as', 'claude-impl'], 'Changes a.\n\nAdds b.\n');
    expect(r.code).toBe(0);
    expect(r.out).toContain('Published "feature → main"');
    expect(r.out).toMatch(/Review URL: http:\/\/127\.0\.0\.1:\d+\/w\/[\w.-]+\/r\/branch-feature-vs-main/);
    const app = await run(['publish', '-m', 'Second pass.', '--json'], undefined, { REDE_OPEN: 'app' });
    const j = JSON.parse(app.out);
    expect(j.review).toMatchObject({ id: 'branch-feature-vs-main', summary: 'Second pass.', awaiting: true, publishedBy: { kind: 'agent', name: 'agent' } });
    expect(j.appUrl).toMatch(/^rede:\/\/open\/[\w.-]+\/branch-feature-vs-main$/);
    const text = await run(['publish', '-m', 'Third.'], undefined, { REDE_OPEN: 'app' });
    expect(text.out).toContain(`Review URL: ${j.appUrl}`);
    expect(text.out).toContain('Browser URL: http://127.0.0.1:');
    // The branch review includes the uncommitted file.
    const d = await run(['diff', '--stat', '--review', 'branch-feature-vs-main']);
    expect(d.out).toContain('b.txt');
    expect((await run(['publish', '-m', '  '])).code).toBe(2);
  }, 30_000);

  it('opens a review, comments from stdin, waits, replies', async () => {
    repo = new TempRepo();
    repo.write('src/x.ts', lines(10));
    repo.commit();
    repo.write('src/x.ts', lines(10).replace('line 2\n', 'line two\n'));
    const open = await run(['--no-open']);
    expect(open.out).toMatch(/http:\/\/127\.0\.0\.1:\d+\/w\/[\w.-]+\/r\/working/);

    const body = "Multi-line `code`\n\n```ts\nconst a = `x`;\n```\n$HOME stays literal\n";
    const c = await run(['comment', 'src/x.ts:2', '--as', 'codex'], body);
    expect(c.out).toContain('Created thread #1');
    const bad = await run(['comment', 'nope.ts:1', '-m', 'x']);
    expect(bad.code).toBe(2);
    expect(bad.err).toContain('not in the diff');

    const show = await run(['show', '1']);
    expect(show.out).toContain('const a = `x`;');
    const inCodex = await run(['show', '1'], undefined, { CODEX_THREAD_ID: 't1', CODEX_SANDBOX: 'seatbelt' });
    expect(inCodex.out).toContain("rede reply 1 --as codex -m '");
    expect(inCodex.out).not.toContain('REDE_EOF');
    expect(show.out).toContain('$HOME stays literal');

    // A human question, then wait.
    const port = JSON.parse(fs.readFileSync(path.join(home, 'server.json'), 'utf8')).port;
    WS = /\/w\/([\w.-]+)\/r\//.exec(open.out)![1]!;
    await req(port, 'POST', '/api/threads/1/messages', { body: 'Is this right?', author: { kind: 'human', name: 'you' } });
    const w = await run(['wait', '--timeout', '5'], undefined, { CLAUDECODE: '1' });
    expect(w.out).toContain('Thread #1');
    expect(w.out).toContain('rede reply 1 --as claude');
    const r = await run(['reply', '1'], 'Yes, it is.\n', { CLAUDECODE: '1' });
    expect(r.out).toContain('Replied to thread #1 as claude');
    const t = await run(['wait', '--timeout', '1']);
    expect(t.out).toContain('No new comments');
    const d = await run(['diff', '--stat']);
    expect(d.out).toContain('src/x.ts');
  }, 30_000);
});
