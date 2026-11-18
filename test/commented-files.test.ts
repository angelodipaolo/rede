import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DiffFileMeta, Thread } from '../src/shared/types.ts';
import { emit } from '../web/src/bus.ts';
import { S, orderedOpenThreads, setCommentedOnly, upsertThread, visibleFiles } from '../web/src/store.ts';
import { layout, V } from '../web/src/vlist.ts';

function file(path: string): DiffFileMeta {
  return { path, status: 'modified', binary: false, additions: 1, deletions: 1, tooLarge: false,
    fingerprint: path, viewed: false, changedSinceViewed: false, oldLineCount: 20, newLineCount: 20 };
}

function thread(id: number, path: string, patch: Partial<Thread> = {}): Thread {
  return { id, reviewId: 'working', anchor: { path, side: 'new', startLine: 4, endLine: 4 },
    inScope: true, homeScope: 'all', snippet: [], original: null, outdated: false, outdatedReason: null,
    resolved: false, archived: false, noteOnly: false, agentState: 'idle', mode: 'ask', claimedBy: null,
    messages: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), ...patch };
}

function put(t: Thread) {
  upsertThread(t, { quiet: true, reindex: true });
}

beforeEach(() => {
  vi.stubGlobal('requestAnimationFrame', () => 0);
  S.scroller = null;
  setCommentedOnly(false);
  S.files = ['a.ts', 'b.ts', 'c.ts'].map(file);
  S.fileByPath = new Map(S.files.map((f) => [f.path, f]));
  S.threads.clear();
  S.threadsByPath.clear();
  S.archivedCount = 0;
  S.scope = 'all';
  S.current = null;
  S.filter = '';
  emit('files', 'threads');
});

afterEach(() => vi.unstubAllGlobals());

describe('files with comments', () => {
  it('includes resolved and outdated comments but excludes threads from another scope', () => {
    put(thread(1, 'a.ts', { resolved: true }));
    put(thread(2, 'b.ts', { inScope: false, homeScope: 'staged' }));
    put(thread(3, 'c.ts', { outdated: true, outdatedReason: 'changed' }));
    setCommentedOnly(true);
    expect(visibleFiles().map((f) => f.path)).toEqual(['a.ts', 'c.ts']);
    expect(S.files).toHaveLength(3);
    setCommentedOnly(false);
    expect(visibleFiles()).toEqual(S.files);
  });

  it('keeps files visible after reading, resolving, and archiving a comment', () => {
    const t = thread(1, 'b.ts', { outdated: true, outdatedReason: 'changed' });
    put(t);
    setCommentedOnly(true);
    expect(visibleFiles().map((f) => f.path)).toEqual(['b.ts']);
    put({ ...t, resolved: true, archived: true });
    expect(visibleFiles().map((f) => f.path)).toEqual(['b.ts']);
    expect(S.archivedCount).toBe(1);
    setCommentedOnly(false);
    setCommentedOnly(true);
    expect(visibleFiles()).toEqual([]);
  });

  it('updates when a new comment arrives and preserves diff order', () => {
    put(thread(3, 'c.ts'));
    setCommentedOnly(true);
    expect(visibleFiles().map((f) => f.path)).toEqual(['c.ts']);
    put(thread(1, 'a.ts'));
    expect(visibleFiles().map((f) => f.path)).toEqual(['a.ts', 'c.ts']);
    S.filter = 'b';
    expect(visibleFiles().map((f) => f.path)).toEqual(['a.ts', 'c.ts']);
  });

  it('updates virtual file indexes when filtered membership changes at the same count', () => {
    put(thread(1, 'a.ts'));
    setCommentedOnly(true);
    layout();
    expect([...V.index.keys()]).toEqual(['a.ts']);
    setCommentedOnly(false);
    S.threads.clear();
    S.threadsByPath.clear();
    put(thread(2, 'c.ts'));
    setCommentedOnly(true);
    layout();
    expect([...V.index.keys()]).toEqual(['c.ts']);
    expect(V.tops).toHaveLength(2);
  });

  it('includes resolved threads in navigation only while the filter is active', () => {
    put(thread(1, 'a.ts', { resolved: true }));
    put(thread(2, 'c.ts'));
    expect(orderedOpenThreads().map((t) => t.id)).toEqual([2]);
    setCommentedOnly(true);
    expect(orderedOpenThreads().map((t) => t.id)).toEqual([1, 2]);
  });

  it('clears sticky membership when the scope changes', () => {
    put(thread(1, 'a.ts'));
    setCommentedOnly(true);
    expect(visibleFiles().map((f) => f.path)).toEqual(['a.ts']);
    S.scope = 'staged';
    put(thread(1, 'a.ts', { inScope: false }));
    put(thread(2, 'b.ts', { homeScope: 'staged' }));
    expect(visibleFiles().map((f) => f.path)).toEqual(['b.ts']);
  });

  it('does not retain previous-scope comments during an uncached scope load', () => {
    put(thread(1, 'a.ts'));
    setCommentedOnly(true);
    expect(visibleFiles().map((f) => f.path)).toEqual(['a.ts']);
    S.scope = 'staged';
    S.files = [];
    S.fileByPath = new Map();
    // The old thread index remains until the new scope response arrives.
    expect(visibleFiles()).toEqual([]);
    S.files = ['a.ts', 'b.ts'].map(file);
    S.fileByPath = new Map(S.files.map((f) => [f.path, f]));
    put(thread(1, 'a.ts', { inScope: false }));
    put(thread(2, 'b.ts', { homeScope: 'staged' }));
    expect(visibleFiles().map((f) => f.path)).toEqual(['b.ts']);
  });

  it('removes files that leave the diff while retaining their outdated threads', () => {
    put(thread(1, 'a.ts'));
    setCommentedOnly(true);
    expect(visibleFiles().map((f) => f.path)).toEqual(['a.ts']);
    S.files = S.files.filter((f) => f.path !== 'a.ts');
    S.fileByPath.delete('a.ts');
    put(thread(1, 'a.ts', { outdated: true, outdatedReason: 'file-gone' }));
    expect(visibleFiles()).toEqual([]);
    expect(S.threads.get(1)?.outdatedReason).toBe('file-gone');
    expect(orderedOpenThreads()).toEqual([]);
    layout();
    expect(V.index.size).toBe(0);
  });
});
