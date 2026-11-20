import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DiffFileMeta, Thread } from '../src/shared/types.ts';
import { emit } from '../web/src/bus.ts';
import { S, isDirectoryHidden, isPathHidden, jumpToThread, orderedOpenThreads, setCommentedOnly, setDirectoryHidden, showAllDirectories, upsertThread, visibleFiles } from '../web/src/store.ts';
import { layout, V } from '../web/src/vlist.ts';

function files(...paths: string[]): DiffFileMeta[] {
  return paths.map((path) => ({ path, status: 'modified', binary: false, additions: 1, deletions: 1,
    tooLarge: false, fingerprint: path, viewed: false, changedSinceViewed: false, oldLineCount: 10, newLineCount: 10 }));
}

function put(id: number, path: string) {
  const t: Thread = { id, reviewId: 'working', anchor: { path, side: 'new', startLine: 2, endLine: 2 },
    inScope: true, homeScope: 'all', snippet: [], original: null, outdated: false, outdatedReason: null,
    resolved: false, archived: false, noteOnly: false, agentState: 'idle', mode: 'ask', claimedBy: null,
    messages: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  upsertThread(t, { quiet: true, reindex: true });
}

beforeEach(() => {
  vi.stubGlobal('requestAnimationFrame', () => 0);
  S.scroller = null;
  S.hiddenDirs = new Set();
  S.threads.clear();
  S.threadsByPath.clear();
  S.archivedCount = 0;
  S.toasts = [];
  S.scope = 'all';
  S.current = null;
  setCommentedOnly(false);
  S.files = files('README.md', 'src/a.ts', 'src/nested/b.ts', 'src-old/c.ts', 'test/a.ts');
  S.fileByPath = new Map(S.files.map((f) => [f.path, f]));
  emit('files', 'threads');
});

afterEach(() => vi.unstubAllGlobals());
const paths = () => visibleFiles().map((f) => f.path);

describe('hidden directories', () => {
  it('hides all descendants without hiding similarly named directories or root files', () => {
    setDirectoryHidden('src', true);
    expect(paths()).toEqual(['README.md', 'src-old/c.ts', 'test/a.ts']);
    expect(isPathHidden('src/nested/b.ts')).toBe(true);
    expect(isDirectoryHidden('src')).toBe(true);
    expect(isDirectoryHidden('src/nested')).toBe(true);
    expect(isPathHidden('src-old/c.ts')).toBe(false);
    expect(visibleFiles(true)).toEqual(S.files);
  });

  it('hides a nested directory independently and restores a whole parent', () => {
    setDirectoryHidden('src/nested', true);
    expect(paths()).toContain('src/a.ts');
    expect(paths()).not.toContain('src/nested/b.ts');
    setDirectoryHidden('src', false);
    expect(paths()).toEqual(S.files.map((f) => f.path));
    expect(S.hiddenDirs.size).toBe(0);
  });

  it('can hide and restore several directories', () => {
    setDirectoryHidden('src', true);
    setDirectoryHidden('test', true);
    expect(paths()).toEqual(['README.md', 'src-old/c.ts']);
    setDirectoryHidden('src', false);
    expect(paths()).toContain('src/nested/b.ts');
    expect(paths()).not.toContain('test/a.ts');
    showAllDirectories();
    expect(paths()).toEqual(S.files.map((f) => f.path));
  });

  it('combines hidden directories with the comment filter and thread navigation', () => {
    put(1, 'src/a.ts');
    put(2, 'test/a.ts');
    setCommentedOnly(true);
    setDirectoryHidden('src', true);
    expect(paths()).toEqual(['test/a.ts']);
    expect(visibleFiles(true).map((f) => f.path)).toEqual(['src/a.ts', 'test/a.ts']);
    expect(orderedOpenThreads().map((t) => t.id)).toEqual([2]);
    setDirectoryHidden('src', false);
    expect(orderedOpenThreads().map((t) => t.id)).toEqual([1, 2]);
  });

  it('shows a hidden directory again when a thread in it is opened, and keeps the comment filter', () => {
    put(1, 'src/a.ts');
    setCommentedOnly(true);
    setDirectoryHidden('src', true);
    jumpToThread(1);
    expect(S.commentedOnly).toBe(true);
    expect(paths()).toEqual(['src/a.ts']);
    expect(S.hiddenDirs.size).toBe(0);
    expect(S.toasts.at(-1)?.text).toBe('Showing src/ again.');
  });

  it('shows only the hidden directories around the opened thread', () => {
    put(1, 'src/nested/b.ts');
    setDirectoryHidden('src/nested', true);
    setDirectoryHidden('test', true);
    jumpToThread(1);
    expect(paths()).toContain('src/nested/b.ts');
    expect([...S.hiddenDirs]).toEqual(['test']);
    expect(paths()).not.toContain('test/a.ts');
  });

  it('opens a thread in a visible file without a message', () => {
    put(1, 'README.md');
    setDirectoryHidden('src', true);
    jumpToThread(1);
    expect([...S.hiddenDirs]).toEqual(['src']);
    expect(S.toasts).toEqual([]);
  });

  it('hides new files under a hidden directory after live updates and scope changes', () => {
    setDirectoryHidden('src', true);
    S.files = [...S.files, ...files('src/new.ts')];
    S.fileByPath = new Map(S.files.map((f) => [f.path, f]));
    expect(paths()).not.toContain('src/new.ts');
    S.scope = 'staged';
    expect(paths()).not.toContain('src/a.ts');
    expect(paths()).toContain('test/a.ts');
  });

  it('updates the virtual diff when the hidden selection changes at the same file count', () => {
    S.files = files('src/a.ts', 'test/a.ts');
    S.fileByPath = new Map(S.files.map((f) => [f.path, f]));
    setDirectoryHidden('src', true);
    layout();
    expect([...V.index.keys()]).toEqual(['test/a.ts']);
    setDirectoryHidden('src', false);
    setDirectoryHidden('test', true);
    layout();
    expect([...V.index.keys()]).toEqual(['src/a.ts']);
  });

  it('selects a visible file when the current directory is hidden, or clears it if none remain', () => {
    S.current = 'src/a.ts';
    setDirectoryHidden('src', true);
    expect(S.current).toBe('README.md');
    S.files = files('src/a.ts');
    S.fileByPath = new Map(S.files.map((f) => [f.path, f]));
    showAllDirectories();
    setDirectoryHidden('src', true);
    expect(S.current).toBeNull();
    layout();
    expect(V.index.size).toBe(0);
  });
});
