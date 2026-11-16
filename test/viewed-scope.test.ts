import { afterEach, describe, expect, it } from 'vitest';
import type { Margin } from '../src/server/service.ts';
import { human, lines, makeMargin, TempRepo } from './helpers.ts';

let repo: TempRepo;
let m: Margin;
afterEach(() => {
  m?.close();
  repo?.cleanup();
});

describe('viewed state', () => {
  async function setup() {
    repo = new TempRepo();
    repo.write('a.ts', lines(40));
    repo.write('b.ts', 'b\n');
    repo.commit();
    repo.write('a.ts', lines(40).replace('line 3\n', 'line three\n'));
    repo.write('b.ts', 'B\n');
    m = await makeMargin(repo);
    await m.openReview({ kind: 'working' });
  }
  const file = async (p: string, scope: 'all' | 'staged' | 'unstaged' = 'all') =>
    (await m.getReview('working', scope)).files.find((f) => f.path === p)!;

  it('tracks viewed, changedSinceViewed and since-viewed diffs', async () => {
    await setup();
    await m.setViewed('working', 'all', 'a.ts', true);
    expect(await file('a.ts')).toMatchObject({ viewed: true, changedSinceViewed: false });
    expect((await m.sinceViewed('working', 'all', 'a.ts')).file).toBeNull();

    repo.write('a.ts', repo.read('a.ts').replace('line 30\n', 'line thirty\n'));
    const f = await file('a.ts');
    expect(f).toMatchObject({ viewed: false, changedSinceViewed: true });
    expect(await file('b.ts')).toMatchObject({ viewed: false, changedSinceViewed: false });

    const sv = await m.sinceViewed('working', 'all', 'a.ts');
    expect(sv.file).not.toBeNull();
    const changed = sv.file!.hunks.flatMap((h) => h.lines).filter((l) => l.type !== 'context');
    expect(changed).toEqual([
      { type: 'del', oldLine: 30, text: 'line 30' },
      { type: 'add', newLine: 30, text: 'line thirty' },
    ]);
    // New-side numbers match the main diff.
    const main = f.hunks.flatMap((h) => h.lines).find((l) => l.type === 'add' && l.text === 'line thirty');
    expect(main?.newLine).toBe(30);

    await m.setViewed('working', 'all', 'a.ts', true);
    expect(await file('a.ts')).toMatchObject({ viewed: true, changedSinceViewed: false });
    await m.setViewed('working', 'all', 'a.ts', false);
    expect(await file('a.ts')).toMatchObject({ viewed: false, changedSinceViewed: false });
  });

  it('keeps viewed state per scope', async () => {
    await setup();
    await m.setViewed('working', 'all', 'a.ts', true);
    expect((await file('a.ts', 'unstaged')).viewed).toBe(false);
  });

  it('since-viewed survives a pruned snapshot object (restored from the database)', async () => {
    await setup();
    await m.setViewed('working', 'all', 'a.ts', true);
    repo.write('a.ts', repo.read('a.ts').replace('line 20\n', 'line twenty\n'));
    await file('a.ts');
    // Simulate gc: remove loose objects that nothing references.
    repo.git('reflog', 'expire', '--expire=now', '--all');
    repo.git('gc', '--prune=now', '--quiet');
    await new Promise((r) => setTimeout(r, 1100)); // let the cached state expire
    const sv = await m.sinceViewed('working', 'all', 'a.ts');
    expect(sv.file?.hunks.flatMap((h) => h.lines).some((l) => l.text === 'line twenty')).toBe(true);
  });
});

describe('staged and unstaged scopes', () => {
  async function setup() {
    repo = new TempRepo();
    repo.write('a.ts', lines(20));
    repo.write('b.ts', lines(10, 'b'));
    repo.commit();
    m = await makeMargin(repo);
    await m.openReview({ kind: 'working' });
  }

  it('shows HEAD->index, index->worktree and HEAD->worktree', async () => {
    await setup();
    repo.write('a.ts', lines(20).replace('line 2\n', 'line two\n'));
    repo.git('add', 'a.ts');
    repo.write('b.ts', lines(10, 'b').replace('b 1\n', 'b one\n'));
    repo.write('new.ts', 'untracked\n');
    const all = await m.getReview('working', 'all');
    const staged = await m.getReview('working', 'staged');
    const unstaged = await m.getReview('working', 'unstaged');
    expect(all.files.map((f) => f.path).sort()).toEqual(['a.ts', 'b.ts', 'new.ts']);
    expect(staged.files.map((f) => f.path)).toEqual(['a.ts']);
    expect(unstaged.files.map((f) => f.path).sort()).toEqual(['b.ts', 'new.ts']);
    expect(all.scopes).toEqual(['all', 'staged', 'unstaged']);
    expect(all.scopeFileCounts).toEqual({ all: 3, staged: 1, unstaged: 2 });
    expect(new Set([all.diffFingerprint, staged.diffFingerprint, unstaged.diffFingerprint]).size).toBe(3);
  });

  it('maps threads across scopes and keeps them when a file is staged', async () => {
    await setup();
    repo.write('a.ts', lines(20).replace('line 2\n', 'line two\n'));
    const t = await m.createThread('working', 'all', {
      anchor: { path: 'a.ts', side: 'new', startLine: 2, endLine: 2 },
      body: 'Worktree line',
      author: human,
    });
    expect(t).toMatchObject({ inScope: true, homeScope: 'all' });
    const inScope = async (scope: 'all' | 'staged' | 'unstaged') => (await m.getReview('working', scope)).threads.find((x) => x.id === t.id)!;

    expect(await inScope('unstaged')).toMatchObject({ inScope: true, anchor: { side: 'new', startLine: 2 }, outdated: false });
    expect(await inScope('staged')).toMatchObject({ inScope: false, anchor: { side: 'new' } });

    // Stage the file: it leaves 'unstaged', stays in 'all', thread not outdated.
    repo.git('add', 'a.ts');
    expect(await inScope('all')).toMatchObject({ inScope: true, outdated: false });
    expect(await inScope('unstaged')).toMatchObject({ inScope: false, outdated: false });
    expect(await inScope('staged')).toMatchObject({ inScope: false });
  });

  it('a thread on the staged side shows on the old side of unstaged', async () => {
    await setup();
    repo.write('a.ts', lines(20).replace('line 2\n', 'line two\n'));
    repo.git('add', 'a.ts');
    repo.write('a.ts', lines(20).replace('line 2\n', 'line two\n').replace('line 9\n', 'line nine\n'));
    const t = await m.createThread('working', 'staged', {
      anchor: { path: 'a.ts', side: 'new', startLine: 2, endLine: 2 },
      body: 'Index line',
      author: human,
    });
    expect(t).toMatchObject({ inScope: true, homeScope: 'staged' });
    const un = (await m.getReview('working', 'unstaged')).threads.find((x) => x.id === t.id)!;
    expect(un).toMatchObject({ inScope: true, anchor: { side: 'old', startLine: 2 } });
    const all = (await m.getReview('working', 'all')).threads.find((x) => x.id === t.id)!;
    expect(all).toMatchObject({ inScope: false, anchor: { side: 'new' } });
    const at = await m.agentThreadById(t.id);
    expect(at.diffContext).toContain('+line two');
  });

  it('rejects scopes other than all for non-working reviews', async () => {
    await setup();
    repo.write('a.ts', 'x\n');
    repo.commit();
    const r = await m.openReview({ kind: 'commit', rev: 'HEAD' });
    await expect(m.getReview(r.id, 'staged')).rejects.toThrow(/not available/);
    const full = await m.getReview(r.id, 'all');
    expect(full.scopes).toEqual(['all']);
  });
});
