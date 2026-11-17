import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ServerEvent } from '../src/shared/types.ts';
import { discoverRepo, marginDir } from '../src/server/git.ts';
import { loadSqlite, Store } from '../src/server/store.ts';
import type { Margin } from '../src/server/service.ts';
import { agent, human, lines, makeMargin, TempRepo } from './helpers.ts';

describe('one-off comments and batched reviews', () => {
  let repo: TempRepo;
  let m: Margin;
  afterEach(() => {
    m?.close();
    repo?.cleanup();
  });

  async function setup(opts = {}) {
    repo = new TempRepo();
    repo.write('a.ts', lines(30));
    repo.commit();
    repo.write('a.ts', lines(30).replace('line 5\n', 'line five\n'));
    m = await makeMargin(repo, opts);
    await m.openReview({ kind: 'working' });
  }

  const on = (line: number, body: string, extra: Record<string, unknown> = {}) =>
    m.createThread('working', 'all', { anchor: { path: 'a.ts', side: 'new', startLine: line, endLine: line }, body, author: human, ...extra });
  const queue = (line: number, body: string) => on(line, body, { pending: true });
  const events = async () => {
    const got: ServerEvent[] = [];
    const off = await m.subscribe('working', 'all', (e) => got.push(e));
    return { got, off };
  };

  it('a one-off comment is delivered at once with mode ask', async () => {
    await setup();
    const t = await on(5, 'Why?');
    expect(t.mode).toBe('ask');
    expect(t.messages[0]).toMatchObject({ pending: false, batchId: null });
    const r = await m.wait('claude', 500, null);
    expect(r.threads.map((x) => x.thread.id)).toEqual([t.id]);
    expect(r.threads[0]!.batchId).toBeNull();
    expect(r.batches).toEqual([]);
  });

  it('pending threads are invisible to agents and idle', async () => {
    await setup();
    const t = await queue(5, 'Rename this');
    expect(t.agentState).toBe('idle');
    expect(t.messages[0]).toMatchObject({ pending: true, batchId: null });
    expect((await m.getReview('working')).pendingCount).toBe(1);
    expect((await m.wait('claude', 100, null)).threads).toEqual([]);
    expect(await m.agentThreads(null, 'all')).toEqual([]);
    await expect(m.agentThreadById(t.id)).rejects.toThrow(/not found/);
    await expect(m.addMessage(t.id, { body: 'hi', author: agent() })).rejects.toThrow(/not found/);
  });

  it('a pending reply does not reach the agent, does not make it the agent turn, and does not reopen', async () => {
    await setup();
    const t = await on(5, 'Q');
    await m.wait('claude', 100, null);
    await m.addMessage(t.id, { body: 'A', author: agent() });
    await m.updateThread(t.id, { resolved: true });
    const after = await m.addMessage(t.id, { body: 'Follow-up', author: human, pending: true });
    expect(after.resolved).toBe(true);
    expect(after.agentState).toBe('idle');
    expect((await m.wait('claude', 100, null)).threads).toEqual([]);
    const shown = await m.agentThreadById(t.id);
    expect(shown.thread.messages.map((x) => x.body)).toEqual(['Q', 'A']);
    const listed = await m.agentThreads(null, 'all');
    expect(listed[0]!.thread.messages).toHaveLength(2);
    // Submitted: reopens and becomes the agent's turn.
    await m.submitReview('working', { mode: 'discuss' });
    const t2 = await m.getThread(t.id);
    expect(t2.resolved).toBe(false);
    expect(t2.agentState).toBe('pending');
    expect(t2.mode).toBe('discuss');
  });

  it('rejects pending messages from agents and in notes', async () => {
    await setup();
    await expect(
      m.createThread('working', 'all', { anchor: { path: 'a.ts', side: 'new', startLine: 5, endLine: 5 }, body: 'x', author: agent(), pending: true }),
    ).rejects.toThrow(/Only the human/);
    await expect(on(5, 'note', { pending: true, noteOnly: true })).rejects.toThrow(/note/);
    const note = await on(6, 'note', { noteOnly: true });
    await expect(m.addMessage(note.id, { body: 'x', author: human, pending: true })).rejects.toThrow(/note/);
    const t = await on(7, 'Q');
    await expect(m.addMessage(t.id, { body: 'x', author: agent(), pending: true })).rejects.toThrow(/Only the human/);
    const p = await queue(8, 'pending');
    await expect(m.updateThread(p.id, { noteOnly: true })).rejects.toThrow(/pending/);
    await expect(m.addMessage(t.id, { body: 'x', author: human, pending: true, resolve: true })).rejects.toThrow(/resolve/);
    expect((await m.getReview('working')).pendingCount).toBe(1);
  });

  it('pending messages can be edited and deleted; events report the count', async () => {
    await setup();
    const ev = await events();
    const a = await queue(5, 'one');
    const b = await queue(6, 'two');
    expect(ev.got.filter((e) => e.type === 'pending').map((e) => (e as { pendingCount: number }).pendingCount)).toEqual([1, 2]);
    const edited = await m.editMessage(a.messages[0]!.id, 'one, edited');
    expect(edited.messages[0]).toMatchObject({ body: 'one, edited', pending: true });
    expect(await m.deleteMessage(b.messages[0]!.id)).toEqual({ ok: true, threadDeleted: true });
    expect(ev.got.some((e) => e.type === 'thread-deleted' && e.threadId === b.id)).toBe(true);
    expect(ev.got.filter((e) => e.type === 'pending').at(-1)).toEqual({ type: 'pending', pendingCount: 1 });
    ev.off();
  });

  it('submit is 400 when nothing is pending and validates the mode', async () => {
    await setup();
    expect(() => m.submitReview('working', { mode: 'discuss' })).toThrow(/Nothing to submit/);
    await queue(5, 'x');
    expect(() => m.submitReview('working', { mode: 'merge' as 'discuss' })).toThrow(/mode/);
  });

  it('submit releases every pending message of the review (all scopes) as one batch', async () => {
    await setup();
    repo.write('b.ts', 'b1\nb2\n');
    repo.git('add', 'b.ts');
    const ev = await events();
    const t1 = await queue(5, 'one');
    const t2 = await queue(9, 'two');
    const staged = await m.createThread('working', 'staged', { anchor: { path: 'b.ts', side: 'new', startLine: 1, endLine: 1 }, body: 'three', author: human, pending: true });
    const old = await on(12, 'Q');
    await m.wait('claude', 100, null);
    await m.addMessage(old.id, { body: 'A', author: agent() });
    await m.addMessage(old.id, { body: 'four (reply)', author: human, pending: true });
    expect((await m.getReview('working')).pendingCount).toBe(4);

    const batch = m.submitReview('working', { mode: 'implement', body: '  Please fix these.  ' });
    expect(batch).toMatchObject({ mode: 'implement', body: 'Please fix these.', reviewId: 'working' });
    expect(batch.threadIds.sort()).toEqual([t1.id, t2.id, staged.id, old.id].sort());
    const r = await m.getReview('working');
    expect(r.pendingCount).toBe(0);
    expect(r.batches).toEqual([batch]);
    for (const t of r.threads) {
      expect(t.mode).toBe('implement');
      expect(t.agentState).toBe('pending');
      for (const msg of t.messages) expect(msg.pending).toBe(false);
    }
    expect(r.threads.find((t) => t.id === old.id)!.messages.map((x) => x.batchId)).toEqual([null, null, batch.id]);
    const batchEv = ev.got.filter((e) => e.type === 'batch');
    expect(batchEv).toEqual([{ type: 'batch', batch, pendingCount: 0 }]);
    for (const id of batch.threadIds) expect(ev.got.some((e) => e.type === 'thread' && e.thread.id === id && e.thread.mode === 'implement')).toBe(true);

    const w = await m.wait('claude', 500, null);
    expect(w.threads.map((x) => x.thread.id).sort()).toEqual([...batch.threadIds].sort());
    expect(w.threads.every((x) => x.batchId === batch.id && x.thread.mode === 'implement')).toBe(true);
    expect(w.batches).toEqual([batch]);
    ev.off();
  });

  it('delivers a whole batch to one of two waiting agents', async () => {
    await setup();
    for (const l of [3, 5, 7, 9, 11]) await queue(l, `c${l}`);
    const a = m.wait('claude', 600, null);
    const b = m.wait('codex', 600, null);
    await new Promise((r) => setTimeout(r, 30));
    expect(m.waiterCount).toBe(2);
    const batch = m.submitReview('working', { mode: 'discuss' });
    const [ra, rb] = await Promise.all([a, b]);
    const counts = [ra.threads.length, rb.threads.length].sort();
    expect(counts).toEqual([0, 5]);
    const winner = ra.threads.length ? ra : rb;
    expect(winner.batches.map((x) => x.id)).toEqual([batch.id]);
    expect(new Set(winner.threads.map((t) => t.thread.claimedBy)).size).toBe(1);
  });

  it('keeps a batch together even when one of its threads was claimed by another agent', async () => {
    await setup();
    const t = await on(5, 'Q');
    expect((await m.wait('codex', 100, null)).threads).toHaveLength(1); // codex holds t
    await m.addMessage(t.id, { body: 'more', author: human, pending: true });
    await queue(9, 'new one');
    m.submitReview('working', { mode: 'discuss' });
    const w = await m.wait('claude', 200, null);
    expect(w.threads).toHaveLength(2);
    expect((await m.wait('codex', 100, null)).threads).toHaveLength(0);
  });

  it('one-off threads come in the same response, after the batch, with mode ask', async () => {
    await setup();
    await queue(9, 'batched');
    const b = m.submitReview('working', { mode: 'discuss' });
    const one = await on(5, 'one-off');
    const w = await m.wait('claude', 200, null);
    expect(w.threads.map((x) => [x.thread.id, x.batchId, x.thread.mode])).toEqual([
      [b.threadIds[0], b.id, 'discuss'],
      [one.id, null, 'ask'],
    ]);
    expect(w.batches.map((x) => x.id)).toEqual([b.id]);
  });

  it('a one-off follow-up on a thread of an implement batch has mode ask', async () => {
    await setup();
    const t = await queue(5, 'fix');
    m.submitReview('working', { mode: 'implement' });
    await m.wait('claude', 100, null);
    await m.addMessage(t.id, { body: 'done', author: agent() });
    const f = await m.addMessage(t.id, { body: 'why that way?', author: human });
    expect(f.mode).toBe('ask');
    const w = await m.wait('claude', 200, null);
    expect(w.threads[0]).toMatchObject({ batchId: null });
    expect(w.batches).toEqual([]);
  });

  it('discard removes pending messages and threads left empty', async () => {
    await setup();
    const keep = await on(5, 'Q');
    await m.addMessage(keep.id, { body: 'pending reply', author: human, pending: true });
    const gone = await queue(9, 'pending thread');
    const ev = await events();
    m.discardPending('working');
    const r = await m.getReview('working');
    expect(r.pendingCount).toBe(0);
    expect(r.threads.map((t) => t.id)).toEqual([keep.id]);
    expect(r.threads[0]!.messages.map((x) => x.body)).toEqual(['Q']);
    expect(ev.got).toContainEqual({ type: 'thread-deleted', threadId: gone.id });
    expect(ev.got.some((e) => e.type === 'thread' && e.thread.id === keep.id)).toBe(true);
    expect(ev.got).toContainEqual({ type: 'pending', pendingCount: 0 });
    expect(r.batches).toEqual([]);
    ev.off();
  });

  it('batches and pending messages persist across a restart', async () => {
    await setup();
    await queue(5, 'a');
    const b = m.submitReview('working', { mode: 'implement', body: 'note' });
    await queue(9, 'still pending');
    m.close();
    m = await makeMargin(repo);
    const r = await m.getReview('working');
    expect(r.batches).toEqual([b]);
    expect(r.pendingCount).toBe(1);
  });
});

describe('database migration', () => {
  let repo: TempRepo;
  afterEach(() => repo?.cleanup());

  it('upgrades a database written before batches, keeping every thread and message', async () => {
    repo = new TempRepo();
    repo.write('a.ts', lines(10));
    repo.commit();
    repo.write('a.ts', lines(10).replace('line 2\n', 'line two\n'));
    const paths = await discoverRepo(repo.dir);
    const file = path.join(marginDir(paths), 'margin.db');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const { DatabaseSync } = await loadSqlite();
    const old = new DatabaseSync(file);
    // The schema of the previous release.
    old.exec(`
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE reviews (id TEXT PRIMARY KEY, spec TEXT NOT NULL, title TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, opened_at TEXT NOT NULL);
      CREATE TABLE threads (id INTEGER PRIMARY KEY AUTOINCREMENT, review_id TEXT NOT NULL, target TEXT NOT NULL, home_scope TEXT NOT NULL, path TEXT NOT NULL, path_hint TEXT,
        start_line INTEGER, end_line INTEGER, snippet TEXT NOT NULL, ctx_before TEXT NOT NULL, ctx_after TEXT NOT NULL, outdated INTEGER NOT NULL DEFAULT 0,
        resolved INTEGER NOT NULL DEFAULT 0, note_only INTEGER NOT NULL DEFAULT 0, claimed_by TEXT, claimed_at INTEGER, delivered_upto INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE INDEX threads_review ON threads(review_id);
      CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, thread_id INTEGER NOT NULL, author_kind TEXT NOT NULL, author_name TEXT NOT NULL, body TEXT NOT NULL,
        created_at TEXT NOT NULL, edited_at TEXT);
      CREATE INDEX messages_thread ON messages(thread_id);
      CREATE TABLE viewed (review_id TEXT NOT NULL, scope TEXT NOT NULL, path TEXT NOT NULL, fingerprint TEXT NOT NULL, blob_id TEXT, viewed_at TEXT NOT NULL, PRIMARY KEY (review_id, scope, path));
      CREATE TABLE blobs (id TEXT PRIMARY KEY, content BLOB NOT NULL);
      INSERT INTO reviews VALUES ('working', '{"kind":"working"}', 'Uncommitted changes', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');
      INSERT INTO threads (review_id, target, home_scope, path, start_line, end_line, snippet, ctx_before, ctx_after, created_at, updated_at)
        VALUES ('working', 'new', 'all', 'a.ts', 2, 2, '["line two"]', '["line 1"]', '["line 3"]', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');
      INSERT INTO messages (thread_id, author_kind, author_name, body, created_at) VALUES (1, 'human', 'you', 'Old question', '2026-01-01T00:00:00Z');
      INSERT INTO messages (thread_id, author_kind, author_name, body, created_at) VALUES (1, 'agent', 'claude', 'Old answer', '2026-01-01T00:00:01Z');
      INSERT INTO messages (thread_id, author_kind, author_name, body, created_at) VALUES (1, 'human', 'you', 'Old follow-up', '2026-01-01T00:00:02Z');
    `);
    old.close();

    const store = await Store.open(file);
    expect(store.messagesOf(1).map((x) => [x.body, x.pending, x.batchId])).toEqual([
      ['Old question', false, null],
      ['Old answer', false, null],
      ['Old follow-up', false, null],
    ]);
    expect(store.getThread(1)!.mode).toBe('ask');
    expect(store.batchesOf('working')).toEqual([]);
    store.close();
    // Opening again is a no-op.
    const again = await Store.open(file);
    expect(again.messagesOf(1)).toHaveLength(3);
    again.close();

    const m = await makeMargin(repo);
    try {
      const r = await m.getReview('working');
      expect(r.pendingCount).toBe(0);
      expect(r.threads[0]).toMatchObject({ mode: 'ask', agentState: 'pending' });
      const w = await m.wait('claude', 200, null);
      expect(w.threads[0]!.thread.messages.map((x) => x.body)).toEqual(['Old question', 'Old answer', 'Old follow-up']);
      // The upgraded database takes new pending messages and batches.
      await m.addMessage(1, { body: 'queued', author: human, pending: true });
      expect(m.submitReview('working', { mode: 'discuss' }).id).toBe(1);
    } finally {
      m.close();
    }
  });
});
