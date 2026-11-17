import { execFile, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ServerEvent } from '../src/shared/types.ts';
import { entryMarkdown, historyMarkdown } from '../src/shared/history-md.ts';
import { formatAgentThread } from '../src/cli/format.ts';
import { codexRules, setup as setupFiles } from '../src/cli/guide.ts';
import { sandboxAdvice } from '../src/cli/client.ts';
import type { Margin } from '../src/server/service.ts';
import { agent, human, lines, makeMargin, TempRepo } from './helpers.ts';

describe('inbox: wait with timeout 0', () => {
  let repo: TempRepo;
  let m: Margin;
  afterEach(() => {
    m?.close();
    repo?.cleanup();
  });

  async function start() {
    repo = new TempRepo();
    repo.write('a.ts', lines(30));
    repo.commit();
    repo.write('a.ts', lines(30).replace('line 5\n', 'line five\n'));
    m = await makeMargin(repo, { presenceLingerMs: 5000 });
    await m.openReview({ kind: 'working' });
  }

  it('returns at once when nothing waits, and does not show the agent as waiting', async () => {
    await start();
    const t0 = Date.now();
    const r = await m.wait('claude', 0, null);
    expect(Date.now() - t0).toBeLessThan(200);
    expect(r).toEqual({ threads: [], batches: [], timedOut: true });
    expect(m.agents()).toEqual([]);
    expect(m.waiterCount).toBe(0);
  });

  it('claims like wait: the threads go to this agent and not to the next one', async () => {
    await start();
    await m.createThread('working', 'all', { anchor: { path: 'a.ts', side: 'new', startLine: 5, endLine: 5 }, body: 'q1', author: human, pending: true });
    await m.createThread('working', 'all', { anchor: { path: 'a.ts', side: 'new', startLine: 9, endLine: 9 }, body: 'q2', author: human, pending: true });
    const b = m.submitReview('working', { mode: 'implement', body: 'fix both' });
    const r = await m.wait('claude', 0, null);
    expect(r.threads.map((t) => t.thread.id)).toEqual([1, 2]);
    expect(r.batches.map((x) => x.id)).toEqual([b.id]);
    expect(r.threads.every((t) => t.thread.agentState === 'working' && t.thread.claimedBy === 'claude')).toBe(true);
    // Claimed: another inbox (or wait) gets nothing.
    expect((await m.wait('codex', 0, null)).threads).toEqual([]);
    expect((await m.wait('claude', 0, null)).threads).toEqual([]);
    // After a reply, a follow-up from the human is delivered again.
    await m.addMessage(1, { body: 'done', author: agent() });
    await m.addMessage(1, { body: 'thanks, one more', author: human });
    expect((await m.wait('claude', 0, null)).threads.map((t) => t.thread.id)).toEqual([1]);
  });
});

describe('code snapshot, outdated reasons and the live-view rule', () => {
  let repo: TempRepo;
  let m: Margin;
  afterEach(() => {
    m?.close();
    repo?.cleanup();
  });

  async function start() {
    repo = new TempRepo();
    repo.write('a.ts', lines(40));
    repo.write('b.ts', lines(10, 'b'));
    repo.commit();
    repo.git('checkout', '-q', '-b', 'feature');
    repo.write('a.ts', lines(40).replace('line 20\n', 'line twenty\nline twenty-b\n'));
    repo.write('b.ts', lines(10, 'b').replace('b 3\n', 'b three\n'));
    m = await makeMargin(repo);
    await m.openReview({ kind: 'working' });
  }

  it('stores the hunk lines around the anchor with line numbers, HEAD and branch', async () => {
    await start();
    const head = repo.git('rev-parse', 'HEAD').trim();
    const t = await m.createThread('working', 'all', { anchor: { path: 'a.ts', side: 'new', startLine: 20, endLine: 21 }, body: 'why two?', author: human });
    const o = t.original!;
    expect(o).toMatchObject({ side: 'new', head, branch: 'feature', truncated: false });
    const anchored = o.lines.filter((l) => l.anchored);
    expect(anchored.map((l) => [l.type, l.newLine, l.text])).toEqual([
      ['add', 20, 'line twenty'],
      ['add', 21, 'line twenty-b'],
    ]);
    // The deleted line and context with both line numbers are part of the snapshot.
    expect(o.lines.some((l) => l.type === 'del' && l.oldLine === 20 && l.text === 'line 20')).toBe(true);
    expect(o.lines.find((l) => l.type === 'context' && l.text === 'line 19')).toMatchObject({ oldLine: 19, newLine: 19 });
    expect(o.lines.length).toBeLessThanOrEqual(2 + 1 + 12);
    // Returned by every endpoint, also after a restart.
    expect((await m.getThread(t.id)).original).toEqual(o);
    expect((await m.history()).entries[0]).toMatchObject({ kind: 'thread', thread: { id: t.id, original: o } });
  });

  it('snapshots unchanged code outside the hunks as context lines of the anchored side', async () => {
    await start();
    const t = await m.createThread('working', 'all', { anchor: { path: 'a.ts', side: 'new', startLine: 35, endLine: 35 }, body: 'q', author: human });
    const o = t.original!;
    expect(o.lines.map((l) => l.newLine)).toEqual([29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40, 41]);
    expect(o.lines.filter((l) => l.anchored).map((l) => l.text)).toEqual(['line 34']);
  });

  it('tells "code changed" from "file no longer in this diff"', async () => {
    await start();
    const a = await m.createThread('working', 'all', { anchor: { path: 'a.ts', side: 'new', startLine: 20, endLine: 20 }, body: 'qa', author: human });
    const b = await m.createThread('working', 'all', { anchor: { path: 'b.ts', side: 'new', startLine: 3, endLine: 3 }, body: 'qb', author: human });
    repo.write('a.ts', lines(40).replace('line 20\n', 'line 20 rewritten\n'));
    repo.git('add', 'b.ts');
    repo.git('commit', '-q', '-m', 'b only');
    const r = await m.getReview('working');
    const byId = new Map(r.threads.map((t) => [t.id, t]));
    expect(byId.get(a.id)).toMatchObject({ outdated: true, outdatedReason: 'changed', archived: false });
    expect(byId.get(b.id)).toMatchObject({ outdated: true, outdatedReason: 'file-gone', archived: false });
    // The original code stays as it was.
    expect(byId.get(a.id)!.original!.lines.find((l) => l.anchored)!.text).toBe('line twenty');
  });

  it('the diff view leaves out threads that are resolved and outdated; History keeps them; nothing is deleted', async () => {
    await start();
    const a = await m.createThread('working', 'all', { anchor: { path: 'a.ts', side: 'new', startLine: 20, endLine: 20 }, body: 'qa', author: human });
    const keep = await m.createThread('working', 'all', { anchor: { path: 'a.ts', side: 'new', startLine: 5, endLine: 5 }, body: 'still here', author: human });
    await m.updateThread(keep.id, { resolved: true }); // resolved, not outdated: stays
    repo.write('a.ts', lines(40).replace('line 20\n', 'changed\n'));
    let r = await m.getReview('working');
    expect(r.threads.map((t) => t.id).sort()).toEqual([a.id, keep.id]); // outdated but unresolved: stays
    expect(r.archivedCount).toBe(0);

    const got: ServerEvent[] = [];
    const off = await m.subscribe('working', 'all', (e) => got.push(e));
    const resolved = await m.updateThread(a.id, { resolved: true });
    expect(resolved).toMatchObject({ resolved: true, outdated: true, archived: true });
    expect(got.some((e) => e.type === 'thread' && e.thread.id === a.id && e.thread.archived)).toBe(true);
    off();

    r = await m.getReview('working');
    expect(r.threads.map((t) => t.id)).toEqual([keep.id]);
    expect(r.archivedCount).toBe(1);
    expect(r.threadCount).toBe(2); // still counted and stored
    const h = await m.history({ state: 'resolved' });
    expect(h.entries.map((e) => (e.kind === 'thread' ? e.thread.id : -1)).sort()).toEqual([a.id, keep.id]);
    expect((await m.agentThreads(null, 'all')).map((t) => t.thread.id)).toContain(a.id);

    // A new message reopens it: back in the diff view.
    await m.addMessage(a.id, { body: 'wait, one more thing', author: human });
    r = await m.getReview('working');
    expect(r.threads.map((t) => t.id)).toContain(a.id);
    expect(r.archivedCount).toBe(0);
  });

  it('a pending reply keeps a resolved outdated thread in the diff view', async () => {
    await start();
    const a = await m.createThread('working', 'all', { anchor: { path: 'a.ts', side: 'new', startLine: 20, endLine: 20 }, body: 'qa', author: human });
    await m.updateThread(a.id, { resolved: true });
    await m.addMessage(a.id, { body: 'queued', author: human, pending: true });
    repo.write('a.ts', lines(40).replace('line 20\n', 'changed\n'));
    const r = await m.getReview('working');
    expect(r.threads.map((t) => t.id)).toEqual([a.id]);
  });

  it('an outdated thread shows its original code to the agent (`margin show`)', async () => {
    await start();
    const a = await m.createThread('working', 'all', { anchor: { path: 'a.ts', side: 'new', startLine: 20, endLine: 20 }, body: 'qa', author: human });
    repo.write('a.ts', lines(40).replace('line 20\n', 'changed\n'));
    await m.getReview('working');
    const at = await m.agentThreadById(a.id);
    expect(at.diffContext).toBeNull();
    const text = formatAgentThread(at, 'claude', { replyHint: true });
    expect(text).toContain('OUTDATED: the commented code changed');
    expect(text).toContain('Original code when the thread started (commit');
    expect(text).toMatch(/> +20 \+line twenty/);
  });

  it('records HEAD and branch on submitted batches', async () => {
    await start();
    await m.createThread('working', 'all', { anchor: { path: 'a.ts', side: 'new', startLine: 20, endLine: 20 }, body: 'q', author: human, pending: true });
    const b = m.submitReview('working', { mode: 'discuss' });
    expect(b).toMatchObject({ head: repo.git('rev-parse', 'HEAD').trim(), branch: 'feature' });
    expect((await m.getReview('working')).batches[0]).toMatchObject({ head: b.head, branch: 'feature' });
  });
});

describe('history endpoint', () => {
  let repo: TempRepo;
  let m: Margin;
  afterEach(() => {
    m?.close();
    repo?.cleanup();
  });

  async function start() {
    repo = new TempRepo();
    repo.write('src/a.ts', lines(50));
    repo.write('docs/b.md', lines(50, 'doc'));
    repo.commit();
    repo.write('src/a.ts', lines(50).replace('line 10\n', 'line ten\n'));
    repo.write('docs/b.md', lines(50, 'doc').replace('doc 10\n', 'doc ten\n'));
    m = await makeMargin(repo);
    await m.openReview({ kind: 'working' });
  }
  const on = (p: string, line: number, body: string, extra: Record<string, unknown> = {}) =>
    m.createThread('working', 'all', { anchor: { path: p, side: 'new', startLine: line, endLine: line }, body, author: human, ...extra });

  it('lists reviews and one-off threads newest first, with counts, and filters them', async () => {
    await start();
    const one = await on('src/a.ts', 3, 'A one-off question about caching');
    await on('src/a.ts', 10, 'Rename this', { pending: true });
    await on('docs/b.md', 10, 'Typo here', { pending: true });
    const b1 = m.submitReview('working', { mode: 'implement', body: 'Overall: tidy up' });
    await m.addMessage(2, { body: 'Renamed.', author: agent() });
    await m.updateThread(2, { resolved: true });
    await on('docs/b.md', 20, 'Why this section?', { pending: true });
    const b2 = m.submitReview('working', { mode: 'discuss' });
    await on('src/a.ts', 30, 'in progress', { pending: true }); // review in progress: not history

    const all = m.history();
    expect(all.total).toBe(3);
    expect(all.entries.map((e) => (e.kind === 'batch' ? `b${e.batch.id}` : `t${e.thread.id}`))).toEqual([`b${b2.id}`, `b${b1.id}`, `t${one.id}`]);
    const e1 = all.entries[1]!;
    expect(e1.kind === 'batch' && e1.counts).toEqual({ threads: 2, answered: 1, resolved: 1 });
    expect(e1.kind === 'batch' && e1.threads.map((t) => t.messages.length)).toEqual([2, 1]);

    expect(m.history({ mode: 'ask' }).entries.map((e) => e.kind)).toEqual(['thread']);
    expect(m.history({ mode: 'discuss' }).entries.map((e) => e.kind === 'batch' && e.batch.id)).toEqual([b2.id]);
    // Text: file paths and message bodies; a batch keeps only the matching threads.
    const typo = m.history({ q: 'TYPO' });
    expect(typo.total).toBe(1);
    expect(typo.entries[0]!.kind === 'batch' && typo.entries[0]!.threads.map((t) => t.id)).toEqual([3]);
    expect(m.history({ q: 'docs/' }).total).toBe(2);
    expect(m.history({ q: 'renamed.' }).total).toBe(1); // agent replies are searched too
    // The batch note matches: the whole batch.
    const note = m.history({ q: 'tidy' });
    expect(note.entries[0]!.kind === 'batch' && note.entries[0]!.threads.length).toBe(2);
    // State: open/resolved threads; entries without matching threads drop out.
    const resolved = m.history({ state: 'resolved' });
    expect(resolved.entries.map((e) => (e.kind === 'batch' ? e.threads.map((t) => t.id) : [e.thread.id]))).toEqual([[2]]);
    expect(m.history({ state: 'open' }).total).toBe(3);
    expect(m.history({ review: 'other' }).total).toBe(0);
    expect(m.history({ since: '2999-01-01' }).total).toBe(0);
    expect(() => m.history({ state: 'x' as 'open' })).toThrow(/state/);
    expect(() => m.history({ since: 'yesterday-ish' })).toThrow(/Invalid date/);
  });

  it('pages with a stable cursor and stays fast with 2,000 threads', async () => {
    await start();
    // Fast bulk insert through the store (createThread reads blobs for each thread).
    const now = Date.now();
    m.store.transaction(() => {
      for (let i = 0; i < 2000; i++) {
        const at = new Date(now - (2000 - i) * 60_000).toISOString();
        const id = m.store.insertThread({
          reviewId: 'working', target: 'new', homeScope: 'all', path: `src/f${i % 40}.ts`, pathHint: null, startLine: 1, endLine: 1,
          snippet: ['x'], ctxBefore: [], ctxAfter: [], noteOnly: false, original: null, createdAt: at, updatedAt: at,
        });
        m.store.insertMessage(id, 'human', 'you', `question ${i}`, at);
        if (i % 2) m.store.insertMessage(id, 'agent', 'claude', `answer ${i}`, at);
      }
    });
    const t0 = performance.now();
    const first = m.history({ limit: 50 });
    const ms = performance.now() - t0;
    expect(first.total).toBe(2000);
    expect(first.entries).toHaveLength(50);
    expect(ms).toBeLessThan(500);
    const seen = new Set<number>();
    let before: string | null = null;
    let pages = 0;
    do {
      const p = m.history({ limit: 300, before: before ?? undefined });
      for (const e of p.entries) if (e.kind === 'thread') seen.add(e.thread.id);
      before = p.next;
      pages++;
    } while (before);
    expect(seen.size).toBe(2000);
    expect(pages).toBe(7);
    // Newest first.
    expect(first.entries[0]!.kind === 'thread' && first.entries[0]!.thread.messages[0]!.body).toBe('question 1999');
    expect(m.history({ q: 'answer 1999' }).total).toBe(1);
  });

  it('exports readable Markdown: reviews, threads with file:line, original code and the conversation', async () => {
    await start();
    await on('src/a.ts', 10, 'Rename `x` here', { pending: true });
    const b = m.submitReview('working', { mode: 'implement', body: 'Please tidy' });
    await m.addMessage(1, { body: 'Renamed to `count`.', author: agent() });
    await on('docs/b.md', 3, 'A one-off');
    const h = m.history();
    const md = historyMarkdown(h.entries, { repo: 'demo', exportedAt: '2026-11-16T10:00:00Z' });
    expect(md).toContain('# Margin review history · demo');
    expect(md).toContain('1 review · 1 one-off thread');
    expect(md).toContain(`## Review #${b.id} · Implement ·`);
    expect(md).toContain('> Please tidy');
    expect(md).toContain('### Thread #1 · src/a.ts:10 · open');
    expect(md).toMatch(/```diff\n[\s\S]*> +10 \+line ten[\s\S]*```/);
    expect(md).toContain('**You** (reviewer)');
    expect(md).toContain('**claude** (agent)');
    expect(md).toContain('Renamed to `count`.');
    // Oldest first in the file.
    expect(md.indexOf('## Review #')).toBeLessThan(md.indexOf('## Comment'));
    expect(entryMarkdown(h.entries[0]!)).toContain('### Thread #2 · docs/b.md:3');
  });
});

describe('setup upgrades the Codex rule', () => {
  it('rewrites a rule from an older margin so it lists inbox; then it is unchanged', () => {
    const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'margin-home-')));
    try {
      const env = { PATH: '/nonexistent', CODEX_HOME: path.join(home, 'codex') };
      const file = path.join(home, 'codex', 'rules', 'margin.rules');
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const old = codexRules([]).replace('"inbox", ', '');
      expect(old).not.toContain('"inbox"');
      fs.writeFileSync(file, old);
      // An old rule: the sandbox advice says to run setup again.
      expect(sandboxAdvice({ CODEX_SANDBOX: 'seatbelt', CODEX_HOME: env.CODEX_HOME }, 'inbox')).toContain('from an older Margin');
      const r = setupFiles(home, env);
      expect(r[2]!.status).toBe('updated');
      expect(fs.readFileSync(file, 'utf8')).toContain('pattern = ["margin", ["inbox", "wait", "reply"');
      expect(setupFiles(home, env).map((x) => x.status)).toEqual(['unchanged', 'unchanged', 'unchanged']);
      expect(sandboxAdvice({ CODEX_SANDBOX: 'seatbelt', CODEX_HOME: env.CODEX_HOME }, 'inbox')).toContain('did not match the margin rule');
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

const CLI = path.resolve(__dirname, '..', 'dist', 'cli.js');

describe.skipIf(!fs.existsSync(CLI))('inbox and export (built CLI)', () => {
  let repo: TempRepo;
  afterEach(() => {
    spawnSync(process.execPath, [CLI, 'stop'], { cwd: repo.dir });
    repo?.cleanup();
  });
  const run = (args: string[], input?: string) =>
    new Promise<{ code: number; out: string; err: string; ms: number }>((resolve) => {
      const t0 = Date.now();
      const child = execFile(process.execPath, [CLI, ...args], { cwd: repo.dir, env: { ...process.env, CLAUDECODE: '', MARGIN_AGENT: '' } }, (e, out, err) =>
        resolve({ code: e ? ((e as { code?: number }).code ?? 1) : 0, out, err, ms: Date.now() - t0 }),
      );
      child.stdin?.end(input ?? '');
    });

  it('inbox prints one line when empty, else the threads with a one-pass hint; export writes Markdown', async () => {
    repo = new TempRepo();
    repo.write('a.ts', lines(10));
    repo.commit();
    repo.write('a.ts', lines(10).replace('line 3\n', 'line three\n'));
    const empty = await run(['inbox']);
    expect(empty).toMatchObject({ code: 0, out: 'No feedback is waiting.\n' });
    expect((await run(['comment', 'a.ts:3', '-m', 'agent finding'])).code).toBe(0);
    // An agent's own thread is not feedback for it.
    expect((await run(['inbox'])).out).toBe('No feedback is waiting.\n');
    // The human comments in the browser (HTTP).
    const port = JSON.parse(fs.readFileSync(path.join(repo.dir, '.git', 'margin', 'server.json'), 'utf8')).port as number;
    const res = await fetch(`http://127.0.0.1:${port}/api/reviews/working/threads`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ anchor: { path: 'a.ts', side: 'new', startLine: 3, endLine: 3 }, body: 'Why three?', author: { kind: 'human', name: 'you' } }),
    });
    expect(res.status).toBe(200);
    const got = await run(['inbox']);
    expect(got.code).toBe(0);
    expect(got.ms).toBeLessThan(5000);
    expect(got.out).toContain('## Thread #2');
    expect(got.out).toContain('Why three?');
    expect(got.out).toContain('run `margin inbox` once more');
    expect(got.out).not.toContain('run `margin wait`');
    // Claimed by the first inbox.
    expect((await run(['inbox'])).out).toBe('No feedback is waiting.\n');
    const reply = await run(['reply', '2', '-m', 'Because.']);
    expect(reply.code).toBe(0);
    expect(reply.out).not.toContain('margin wait');
    const exp = path.join(repo.dir, 'history.md');
    const e = await run(['export', '-o', exp]);
    expect(e.code).toBe(0);
    const md = fs.readFileSync(exp, 'utf8');
    expect(md).toContain('### Thread #1 · a.ts:3');
    expect(md).toContain('agent finding');
  }, 30_000);
});

describe('migration to review history', () => {
  let repo: TempRepo;
  afterEach(() => repo?.cleanup());

  it('adds the snapshot and batch columns in place, keeping every row; old threads fall back to the snippet', async () => {
    const { discoverRepo, marginDir } = await import('../src/server/git.ts');
    const { loadSqlite, Store } = await import('../src/server/store.ts');
    repo = new TempRepo();
    repo.write('a.ts', lines(10));
    repo.commit();
    repo.write('a.ts', lines(10).replace('line 2\n', 'line two\n'));
    const file = path.join(marginDir(await discoverRepo(repo.dir)), 'margin.db');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const { DatabaseSync } = await loadSqlite();
    const old = new DatabaseSync(file);
    // The schema of the release before review history (batches, no snapshots).
    old.exec(`
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE reviews (id TEXT PRIMARY KEY, spec TEXT NOT NULL, title TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, opened_at TEXT NOT NULL);
      CREATE TABLE threads (id INTEGER PRIMARY KEY AUTOINCREMENT, review_id TEXT NOT NULL, target TEXT NOT NULL, home_scope TEXT NOT NULL, path TEXT NOT NULL, path_hint TEXT,
        start_line INTEGER, end_line INTEGER, snippet TEXT NOT NULL, ctx_before TEXT NOT NULL, ctx_after TEXT NOT NULL, outdated INTEGER NOT NULL DEFAULT 0,
        resolved INTEGER NOT NULL DEFAULT 0, note_only INTEGER NOT NULL DEFAULT 0, mode TEXT NOT NULL DEFAULT 'ask', claimed_by TEXT, claimed_at INTEGER,
        delivered_upto INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, thread_id INTEGER NOT NULL, author_kind TEXT NOT NULL, author_name TEXT NOT NULL, body TEXT NOT NULL,
        created_at TEXT NOT NULL, edited_at TEXT, pending INTEGER NOT NULL DEFAULT 0, batch_id INTEGER);
      CREATE TABLE batches (id INTEGER PRIMARY KEY AUTOINCREMENT, review_id TEXT NOT NULL, mode TEXT NOT NULL, body TEXT NOT NULL, submitted_at TEXT NOT NULL, thread_ids TEXT NOT NULL);
      CREATE TABLE viewed (review_id TEXT NOT NULL, scope TEXT NOT NULL, path TEXT NOT NULL, fingerprint TEXT NOT NULL, blob_id TEXT, viewed_at TEXT NOT NULL, PRIMARY KEY (review_id, scope, path));
      CREATE TABLE blobs (id TEXT PRIMARY KEY, content BLOB NOT NULL);
      INSERT INTO reviews VALUES ('working', '{"kind":"working"}', 'Uncommitted changes', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');
      INSERT INTO threads (review_id, target, home_scope, path, start_line, end_line, snippet, ctx_before, ctx_after, outdated, resolved, mode, created_at, updated_at)
        VALUES ('working', 'new', 'all', 'a.ts', 2, 2, '["line two"]', '["line 1"]', '["line 3"]', 0, 0, 'implement', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');
      INSERT INTO threads (review_id, target, home_scope, path, start_line, end_line, snippet, ctx_before, ctx_after, outdated, resolved, created_at, updated_at)
        VALUES ('working', 'new', 'all', 'gone.ts', 1, 1, '["bye"]', '[]', '[]', 1, 1, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');
      INSERT INTO batches (review_id, mode, body, submitted_at, thread_ids) VALUES ('working', 'implement', 'old note', '2026-01-01T00:00:05Z', '[1]');
      INSERT INTO messages (thread_id, author_kind, author_name, body, created_at, batch_id) VALUES (1, 'human', 'you', 'Old question', '2026-01-01T00:00:05Z', 1);
      INSERT INTO messages (thread_id, author_kind, author_name, body, created_at) VALUES (1, 'agent', 'claude', 'Old answer', '2026-01-01T00:00:06Z');
      INSERT INTO messages (thread_id, author_kind, author_name, body, created_at) VALUES (2, 'human', 'you', 'About a file that is gone', '2026-01-01T00:00:00Z');
    `);
    old.close();

    const store = await Store.open(file);
    expect(store.getThread(1)).toMatchObject({ original: null, outdated: false, outdatedReason: null, mode: 'implement', snippet: ['line two'] });
    expect(store.getThread(2)).toMatchObject({ original: null, outdated: true, resolved: true });
    expect(store.batchesOf('working')).toEqual([
      { id: 1, reviewId: 'working', mode: 'implement', body: 'old note', submittedAt: '2026-01-01T00:00:05Z', threadIds: [1], head: null, branch: null },
    ]);
    expect(store.messagesOf(1).map((x) => x.body)).toEqual(['Old question', 'Old answer']);
    store.close();
    (await Store.open(file)).close(); // a second open is a no-op

    const m = await makeMargin(repo);
    try {
      const r = await m.getReview('working');
      expect(r.threads.map((t) => [t.id, t.original, t.snippet])).toEqual([[1, null, ['line two']]]);
      expect(r.archivedCount).toBe(1); // the resolved thread on a file that left the diff
      const h = m.history();
      expect(h.entries.map((e) => e.kind)).toEqual(['batch', 'thread']);
      const t2 = h.entries[1]!.kind === 'thread' ? h.entries[1]!.thread : null;
      expect(t2).toMatchObject({ id: 2, outdatedReason: 'file-gone', archived: true, original: null });
      expect(historyMarkdown(h.entries, { repo: 'r', exportedAt: '2026-11-16T00:00:00Z' })).toContain('Commented lines when the thread started');
      // New threads in the upgraded database get a snapshot.
      const t = await m.createThread('working', 'all', { anchor: { path: 'a.ts', side: 'new', startLine: 2, endLine: 2 }, body: 'new', author: human });
      expect(t.original?.lines.some((l) => l.anchored && l.text === 'line two')).toBe(true);
    } finally {
      m.close();
    }
  });
});
