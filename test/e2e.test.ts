import { execFile, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ServerEvent, Thread, WaitResponse } from '../src/shared/types.ts';
import { startServer, type RunningServer } from '../src/server/server.ts';
import { lines, TempRepo } from './helpers.ts';

function req<T = any>(port: number, method: string, p: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; json: T }> {
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
  afterEach(async () => {
    await srv?.close();
    srv = null;
    repo?.cleanup();
  });

  async function setup(extra = {}) {
    repo = new TempRepo();
    repo.write('app.ts', lines(20));
    repo.commit();
    repo.write('app.ts', lines(20).replace('line 4\n', 'line four\n'));
    srv = await startServer({ cwd: repo.dir, webDir: null, pollMs: 100, idleMs: 0, presenceLingerMs: 0, ...extra });
    return srv.port;
  }

  it('serves health, rejects foreign hosts and origins, serves the not-built page', async () => {
    const port = await setup();
    const h = await req(port, 'GET', '/api/health');
    expect(h.json).toMatchObject({ ok: true, name: 'margin', pid: process.pid });
    expect((await req(port, 'GET', '/api/health', undefined, { host: 'evil.example:80' })).status).toBe(403);
    expect((await req(port, 'POST', '/api/reviews', { spec: { kind: 'working' } }, { origin: 'http://evil.example' })).status).toBe(403);
    expect((await req(port, 'POST', '/api/reviews', { spec: { kind: 'working' } }, { origin: `http://127.0.0.1:${port}` })).status).toBe(200);
    const info = JSON.parse(fs.readFileSync(path.join(repo.dir, '.git', 'margin', 'server.json'), 'utf8'));
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

  it('drops SSE subscribers and waiters when clients disconnect', async () => {
    const port = await setup();
    await req(port, 'POST', '/api/reviews', { spec: { kind: 'working' } });
    const streams = Array.from({ length: 20 }, () => sse(port, '/api/reviews/working/events'));
    await Promise.all(streams.map((s) => s.waitFor((e) => e.type === 'agents')));
    expect(srv!.margin.subscriberCount).toBe(20);
    const waits = Array.from({ length: 5 }, (_, i) => {
      const r = http.get({ host: '127.0.0.1', port, path: `/api/agent/wait?agent=a${i}&timeout=600` });
      r.on('error', () => {});
      return r;
    });
    const until = async (f: () => boolean) => {
      for (let i = 0; i < 100 && !f(); i++) await new Promise((r) => setTimeout(r, 20));
      return f();
    };
    expect(await until(() => srv!.margin.waiterCount === 5)).toBe(true);
    for (const s of streams) s.close();
    for (const w of waits) w.destroy();
    expect(await until(() => srv!.margin.subscriberCount === 0 && srv!.margin.waiterCount === 0)).toBe(true);
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
    srv = await startServer({ cwd: repo.dir, webDir: null, idleMs: 0 });
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
    expect(fs.existsSync(path.join(repo.dir, '.git', 'margin', 'server.json'))).toBe(false);
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
  afterEach(() => {
    spawnSync(process.execPath, [CLI, 'stop'], { cwd: repo.dir });
    repo?.cleanup();
  });

  const run = (args: string[], input?: string, env: Record<string, string> = {}) =>
    new Promise<{ code: number; out: string; err: string }>((resolve) => {
      const child = execFile(process.execPath, [CLI, ...args], { cwd: repo.dir, env: { ...process.env, CLAUDECODE: '', MARGIN_AGENT: '', ...env } }, (e, out, err) =>
        resolve({ code: e ? ((e as { code?: number }).code ?? 1) : 0, out, err }),
      );
      child.stdin?.end(input ?? '');
    });

  it('replaces a server started by an older build, on the same port', async () => {
    repo = new TempRepo();
    repo.write('a.txt', 'x\n');
    repo.commit();
    await run(['list']);
    const file = path.join(repo.dir, '.git', 'margin', 'server.json');
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
    expect(w.out).toContain('margin wait');
  }, 30_000);

  it('opens a review, comments from stdin, waits, replies', async () => {
    repo = new TempRepo();
    repo.write('src/x.ts', lines(10));
    repo.commit();
    repo.write('src/x.ts', lines(10).replace('line 2\n', 'line two\n'));
    const open = await run(['--no-open']);
    expect(open.out).toMatch(/http:\/\/127\.0\.0\.1:\d+\/r\/working/);

    const body = "Multi-line `code`\n\n```ts\nconst a = `x`;\n```\n$HOME stays literal\n";
    const c = await run(['comment', 'src/x.ts:2', '--as', 'codex'], body);
    expect(c.out).toContain('Created thread #1');
    const bad = await run(['comment', 'nope.ts:1', '-m', 'x']);
    expect(bad.code).toBe(2);
    expect(bad.err).toContain('not in the diff');

    const show = await run(['show', '1']);
    expect(show.out).toContain('const a = `x`;');
    expect(show.out).toContain('$HOME stays literal');

    // A human question, then wait.
    const port = JSON.parse(fs.readFileSync(path.join(repo.dir, '.git', 'margin', 'server.json'), 'utf8')).port;
    await req(port, 'POST', '/api/threads/1/messages', { body: 'Is this right?', author: { kind: 'human', name: 'you' } });
    const w = await run(['wait', '--timeout', '5'], undefined, { CLAUDECODE: '1' });
    expect(w.out).toContain('Thread #1');
    expect(w.out).toContain('margin reply 1 --as claude');
    const r = await run(['reply', '1'], 'Yes, it is.\n', { CLAUDECODE: '1' });
    expect(r.out).toContain('Replied to thread #1 as claude');
    const t = await run(['wait', '--timeout', '1']);
    expect(t.out).toContain('No new comments');
    const d = await run(['diff', '--stat']);
    expect(d.out).toContain('src/x.ts');
  }, 30_000);
});
