import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Dashboard, HubEvent, PublishResponse, ReviewSummary, WorkspaceInfo } from '../src/shared/types.ts';
import { workspaceId } from '../src/server/hub.ts';
import { startServer, type RunningServer } from '../src/server/server.ts';
import { lines, TempRepo } from './helpers.ts';

function req<T = any>(port: number, method: string, p: string, body?: unknown): Promise<{ status: number; json: T }> {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, method, path: p, headers: { 'content-type': 'application/json' } }, (res) => {
      let text = '';
      res.on('data', (c) => (text += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, json: text ? JSON.parse(text) : null }));
    });
    r.on('error', reject);
    r.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

function hubEvents(port: number) {
  const events: HubEvent[] = [];
  let raw = '';
  const r = http.get({ host: '127.0.0.1', port, path: '/api/events' }, (res) => {
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
    async waitFor(pred: (e: HubEvent) => boolean, ms = 4000): Promise<HubEvent> {
      const end = Date.now() + ms;
      while (Date.now() < end) {
        const e = [...events].reverse().find(pred);
        if (e) return e;
        await new Promise((res) => setTimeout(res, 25));
      }
      throw new Error(`event not received; got ${JSON.stringify(events)}`);
    },
  };
}

describe('hub: one server for every worktree', () => {
  let repo: TempRepo;
  let srv: RunningServer | null = null;
  let home = '';
  const worktrees: string[] = [];
  afterEach(async () => {
    await srv?.close();
    srv = null;
    for (const w of worktrees.splice(0)) fs.rmSync(w, { recursive: true, force: true });
    repo?.cleanup();
    fs.rmSync(home, { recursive: true, force: true });
  });

  /** A repo with two linked worktrees, each with its own uncommitted change. */
  function threeWorktrees(): string[] {
    repo = new TempRepo();
    repo.write('a.ts', lines(10));
    repo.commit();
    const dirs = [repo.dir];
    for (const name of ['one', 'two']) {
      const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `rede-wt-${name}-`)));
      fs.rmSync(dir, { recursive: true });
      repo.git('worktree', 'add', '-q', '-b', name, dir);
      worktrees.push(dir);
      dirs.push(dir);
    }
    dirs.forEach((d, i) => fs.writeFileSync(path.join(d, 'a.ts'), lines(10).replace('line 2\n', `line two in ${i}\n`)));
    return dirs;
  }

  it('serves three worktrees with isolated data, publish and acknowledge', async () => {
    const dirs = threeWorktrees();
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'rede-home-'));
    srv = await startServer({ home, port: 0, webDir: null, idleMs: 0, pollMs: 100, presenceLingerMs: 0 });
    const port = srv.port;

    // Register from the CLI side, with a path inside the worktree.
    fs.mkdirSync(path.join(dirs[1]!, 'sub'));
    const ws: WorkspaceInfo[] = [];
    for (const d of [dirs[0]!, path.join(dirs[1]!, 'sub'), dirs[2]!]) ws.push((await req<WorkspaceInfo>(port, 'POST', '/api/workspaces', { root: d })).json);
    expect(ws.map((w) => w.root)).toEqual(dirs);
    expect(ws.map((w) => w.id)).toEqual(dirs.map(workspaceId));
    expect(new Set(ws.map((w) => w.repo.commonDir)).size).toBe(1);
    expect(ws[1]!.branch).toBe('one');
    // Registering again finds the same workspace.
    expect((await req<WorkspaceInfo>(port, 'POST', '/api/workspaces', { root: dirs[0] })).json.id).toBe(ws[0]!.id);
    expect((await req(port, 'POST', '/api/workspaces', { root: os.tmpdir() })).status).toBe(400);

    const events = hubEvents(port);
    await events.waitFor((e) => e.type === 'dashboard');

    // Each worktree has its own "working" review, with its own diff and threads.
    for (const [i, w] of ws.entries()) {
      await req(port, 'POST', `/api/w/${w.id}/reviews`, { spec: { kind: 'working' } });
      const r = await req(port, 'GET', `/api/w/${w.id}/reviews/working`);
      const files = await req(port, 'POST', `/api/w/${w.id}/reviews/working/hunks`, { paths: ['a.ts'] });
      expect(r.json.repo.root).toBe(dirs[i]);
      expect(JSON.stringify(files.json)).toContain(`line two in ${i}`);
    }
    await req(port, 'POST', `/api/w/${ws[1]!.id}/reviews/working/threads`, {
      anchor: { path: 'a.ts', side: 'new', startLine: 2, endLine: 2 },
      body: 'finding',
      author: { kind: 'agent', name: 'reviewer-codex' },
    });
    expect((await req(port, 'GET', `/api/w/${ws[0]!.id}/reviews/working`)).json.threads).toHaveLength(0);
    expect((await req(port, 'GET', `/api/w/${ws[1]!.id}/reviews/working`)).json.threads[0].messages[0].author).toEqual({ kind: 'agent', name: 'reviewer-codex' });
    expect(fs.existsSync(path.join(dirs[0]!, '.git', 'rede', 'rede.db'))).toBe(true);
    expect(fs.existsSync(path.join(repo.dir, '.git', 'worktrees', path.basename(dirs[1]!), 'rede', 'rede.db'))).toBe(true);

    // An agent publishes worktree two; the dashboard counts it.
    const pub = await req<PublishResponse>(port, 'POST', `/api/w/${ws[2]!.id}/reviews/working/publish`, {
      summary: 'Renames line two.',
      author: { kind: 'agent', name: 'claude' },
    });
    expect(pub.status).toBe(200);
    expect(pub.json.appUrl).toBe(`rede://open/${ws[2]!.id}/working`);
    expect(pub.json.webUrl).toBe(`http://127.0.0.1:${port}/w/${ws[2]!.id}/r/working`);
    expect(pub.json.review).toMatchObject({ summary: 'Renames line two.', publishedBy: { kind: 'agent', name: 'claude' }, awaiting: true });
    await events.waitFor((e) => e.type === 'dashboard' && e.awaiting === 1);
    const dash = (await req<Dashboard>(port, 'GET', '/api/dashboard')).json;
    expect(dash.awaiting).toBe(1);
    expect(dash.workspaces.map((w) => w.reviews.filter((r) => r.awaiting).length)).toEqual([0, 0, 1]);
    expect(dash.workspaces[1]!.reviews[0]!.unresolvedCount).toBe(1);
    expect(dash.workspaces[1]!.reviews[0]!.agentReplies).toBe(1);

    // The human opens it: acknowledged, and the badge count drops.
    const acked = await req<ReviewSummary>(port, 'POST', `/api/w/${ws[2]!.id}/reviews/working/ack`);
    expect(acked.json.awaiting).toBe(false);
    await events.waitFor((e) => e.type === 'dashboard' && e.awaiting === 0);
    // Publishing again makes it wait again.
    await new Promise((r) => setTimeout(r, 5));
    await req(port, 'POST', `/api/w/${ws[2]!.id}/reviews/working/publish`, { summary: 'Second pass.', author: { kind: 'agent', name: 'claude' } });
    await events.waitFor((e) => e.type === 'dashboard' && e.awaiting === 1);
    // ready=false keeps the summary and clears the ready state.
    const off = await req<PublishResponse>(port, 'POST', `/api/w/${ws[2]!.id}/reviews/working/publish`, { summary: 'Draft.', author: { kind: 'agent', name: 'claude' }, ready: false });
    expect(off.json.review).toMatchObject({ summary: 'Draft.', awaiting: false, readyAt: null });
    expect((await req(port, 'POST', `/api/w/${ws[2]!.id}/reviews/working/publish`, { summary: ' ', author: { kind: 'agent', name: 'x' } })).status).toBe(400);
    events.close();

    // The registry survives a restart; reviews and summaries stay.
    await srv.close();
    srv = await startServer({ home, port: 0, webDir: null, idleMs: 0 });
    const list = (await req<WorkspaceInfo[]>(srv.port, 'GET', '/api/workspaces')).json;
    expect(list.map((w) => w.id).sort()).toEqual(ws.map((w) => w.id).sort());
    const again = (await req<ReviewSummary[]>(srv.port, 'GET', `/api/w/${ws[2]!.id}/reviews`)).json;
    expect(again[0]!.summary).toBe('Draft.');
    expect((await req(srv.port, 'GET', '/api/w/nope-000000/reviews')).status).toBe(404);
  }, 30_000);

  it('marks a removed worktree missing and can forget it', async () => {
    const dirs = threeWorktrees();
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'rede-home-'));
    srv = await startServer({ home, port: 0, webDir: null, idleMs: 0, workspaces: dirs });
    repo.git('worktree', 'remove', '--force', dirs[2]!);
    const dash = (await req<Dashboard>(srv.port, 'GET', '/api/dashboard')).json;
    expect(dash.workspaces.map((w) => w.missing)).toEqual([false, false, true]);
    expect((await req(srv.port, 'DELETE', `/api/workspaces/${srv.workspaces[2]}`)).status).toBe(200);
    expect((await req<WorkspaceInfo[]>(srv.port, 'GET', '/api/workspaces')).json).toHaveLength(2);
  }, 30_000);
});
