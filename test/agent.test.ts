import { afterEach, describe, expect, it } from 'vitest';
import type { Margin } from '../src/server/service.ts';
import { agent, human, lines, makeMargin, TempRepo } from './helpers.ts';

describe('agent state, wait, claims and redelivery', () => {
  let repo: TempRepo;
  let m: Margin;
  afterEach(() => {
    m?.close();
    repo?.cleanup();
  });

  async function setup(opts = {}) {
    repo = new TempRepo();
    repo.write('a.ts', lines(20));
    repo.commit();
    repo.write('a.ts', lines(20).replace('line 5\n', 'line five\n'));
    m = await makeMargin(repo, opts);
    await m.openReview({ kind: 'working' });
  }

  const ask = (body = 'Question?', extra = {}) =>
    m.createThread('working', 'all', { anchor: { path: 'a.ts', side: 'new', startLine: 5, endLine: 5 }, body, author: human, ...extra });

  it('pending -> working on wait -> idle on reply; reply does not resolve', async () => {
    await setup();
    const t = await ask();
    expect(t.agentState).toBe('pending');
    const r = await m.wait('claude', 1000, null);
    expect(r.timedOut).toBe(false);
    expect(r.threads.map((x) => x.thread.id)).toEqual([t.id]);
    expect(r.threads[0]!.thread.agentState).toBe('working');
    expect(r.threads[0]!.thread.claimedBy).toBe('claude');
    expect(r.threads[0]!.diffContext).toContain('>');
    const after = await m.addMessage(t.id, { body: 'Answer', author: agent() });
    expect(after.agentState).toBe('idle');
    expect(after.resolved).toBe(false);
    const resolved = await m.addMessage(t.id, { body: 'Done', author: agent(), resolve: true });
    expect(resolved.resolved).toBe(true);
  });

  it('a waiting agent wakes up when a comment arrives', async () => {
    await setup();
    const p = m.wait('claude', 5000, null);
    await new Promise((r) => setTimeout(r, 50));
    expect(m.agents()).toEqual([expect.objectContaining({ name: 'claude', state: 'waiting' })]);
    const t = await ask();
    const r = await p;
    expect(r.threads.map((x) => x.thread.id)).toEqual([t.id]);
    expect(m.agents()).toEqual([expect.objectContaining({ name: 'claude', state: 'working' })]);
  });

  it('times out with no threads', async () => {
    await setup();
    const r = await m.wait('claude', 100, null);
    expect(r).toEqual({ threads: [], timedOut: true });
  });

  it('does not deliver notes, resolved threads or threads where the agent spoke last', async () => {
    await setup();
    await ask('private', { noteOnly: true });
    const t2 = await ask('resolved');
    await m.updateThread(t2.id, { resolved: true });
    await m.createThread('working', 'all', { anchor: { path: 'a.ts', side: 'new', startLine: 6, endLine: 6 }, body: 'finding', author: agent() });
    expect((await m.wait('claude', 100, null)).threads).toEqual([]);
  });

  it('a claimed thread goes to one agent only, and is redelivered to it after a new human message', async () => {
    await setup();
    const t = await ask();
    expect((await m.wait('claude', 100, null)).threads).toHaveLength(1);
    expect((await m.wait('codex', 100, null)).threads).toHaveLength(0);
    expect((await m.wait('claude', 100, null)).threads).toHaveLength(0); // already delivered
    const followUp = await m.addMessage(t.id, { body: 'And also?', author: human });
    expect(followUp.agentState).toBe('working');
    expect(followUp.claimedBy).toBe('claude');
    expect((await m.wait('codex', 100, null)).threads).toHaveLength(0);
    const again = await m.wait('claude', 100, null);
    expect(again.threads).toHaveLength(1);
    expect(again.threads[0]!.thread.messages.map((x) => x.body)).toEqual(['Question?', 'And also?']);
  });

  it('gives the claim back when the waiting agent disconnects before it gets the threads', async () => {
    await setup();
    const t = await ask();
    const ac = new AbortController();
    const p = m.wait('claude', 1000, null, ac.signal);
    ac.abort(); // e.g. Ctrl-C while the response is being built
    expect(await p).toEqual({ threads: [], timedOut: true });
    expect((await m.getThread(t.id)).agentState).toBe('pending');
    expect((await m.wait('codex', 100, null)).threads.map((x) => x.thread.id)).toEqual([t.id]);
  });

  it('does not register a waiter for an already closed connection', async () => {
    await setup();
    const ac = new AbortController();
    ac.abort();
    expect(await m.wait('claude', 60_000, null, ac.signal)).toEqual({ threads: [], timedOut: true });
    expect(m.waiterCount).toBe(0);
  });

  it('release gives claimed threads back at once', async () => {
    await setup();
    const t = await ask();
    await m.wait('claude', 100, null);
    expect(m.release('claude')).toBe(1);
    expect((await m.getThread(t.id)).agentState).toBe('pending');
    expect((await m.wait('codex', 100, null)).threads).toHaveLength(1);
  });

  it('expired claims become pending again', async () => {
    await setup({ claimTimeoutMs: 600 });
    const t = await ask();
    await m.wait('claude', 100, null);
    expect((await m.getThread(t.id)).agentState).toBe('working');
    await new Promise((r) => setTimeout(r, 750));
    expect((await m.getThread(t.id)).agentState).toBe('pending');
    expect((await m.wait('codex', 100, null)).threads).toHaveLength(1);
  });

  it('filters wait by review', async () => {
    await setup();
    await ask();
    repo.git('branch', 'base', 'HEAD');
    const other = await m.openReview({ kind: 'commit', rev: 'HEAD' });
    expect((await m.wait('claude', 100, other.id)).threads).toHaveLength(0);
    expect((await m.wait('claude', 100, 'working')).threads).toHaveLength(1);
  });

  it('a human reply reopens a resolved thread', async () => {
    await setup();
    const t = await ask();
    await m.updateThread(t.id, { resolved: true });
    const after = await m.addMessage(t.id, { body: 'Wait, one more thing', author: human });
    expect(after.resolved).toBe(false);
    expect(after.agentState).toBe('pending');
  });

  it('deleting the last message deletes the thread', async () => {
    await setup();
    const t = await ask();
    const r = await m.deleteMessage(t.messages[0]!.id);
    expect(r).toEqual({ ok: true, threadDeleted: true });
    await expect(m.getThread(t.id)).rejects.toThrow(/not found/);
  });
});
