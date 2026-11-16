import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { diffTrees } from '../src/server/diff.ts';
import { IndexTreeReader, WorkingSnapshotter } from '../src/server/snapshot.ts';
import { TempRepo } from './helpers.ts';

describe('working tree snapshot', () => {
  let repo: TempRepo;
  afterEach(() => repo?.cleanup());

  function setup() {
    repo = new TempRepo();
    repo.write('.gitignore', 'ignored.log\n');
    repo.write('keep.txt', 'keep\n');
    repo.write('del.txt', 'delete me\n');
    repo.write('ren.txt', 'a\nb\nc\nd\ne\n');
    repo.write('staged.txt', 'v1\n');
    const head = repo.commit();
    const dir = path.join(repo.dir, '.git', 'margin');
    return { head, snap: new WorkingSnapshotter(repo.dir, path.join(repo.dir, '.git'), dir), idx: new IndexTreeReader(repo.dir, path.join(repo.dir, '.git'), dir) };
  }

  it('includes untracked, staged, unstaged, deleted and renamed files, not ignored ones', async () => {
    const { snap } = setup();
    repo.write('untracked.txt', 'new\n');
    repo.write('ignored.log', 'noise\n');
    repo.rm('del.txt');
    repo.git('mv', 'ren.txt', 'moved.txt');
    repo.write('staged.txt', 'v2\n');
    repo.git('add', 'staged.txt');
    repo.write('staged.txt', 'v3\n');
    const tree = await snap.snapshot();
    const headTree = repo.git('rev-parse', 'HEAD^{tree}').trim();
    const files = await diffTrees(repo.dir, headTree, tree);
    const by = Object.fromEntries(files.map((f) => [f.path, f]));
    expect(Object.keys(by).sort()).toEqual(['del.txt', 'moved.txt', 'staged.txt', 'untracked.txt']);
    expect(by['moved.txt']).toMatchObject({ status: 'renamed', oldPath: 'ren.txt' });
    expect(by['del.txt']!.status).toBe('deleted');
    expect(by['staged.txt']!.hunks[0]!.lines.find((l) => l.type === 'add')!.text).toBe('v3');
  });

  it('never modifies the real index or the working tree', async () => {
    const { snap, idx } = setup();
    repo.write('untracked.txt', 'new\n');
    repo.write('staged.txt', 'v2\n');
    repo.git('add', 'staged.txt');
    repo.write('keep.txt', 'changed\n');
    const indexFile = path.join(repo.dir, '.git', 'index');
    const before = fs.readFileSync(indexFile);
    const statusBefore = repo.git('status', '--porcelain');
    await snap.snapshot();
    await snap.snapshot();
    await idx.read(repo.git('rev-parse', 'HEAD^{tree}').trim());
    expect(fs.readFileSync(indexFile).equals(before)).toBe(true);
    expect(repo.git('status', '--porcelain')).toBe(statusBefore);
    expect(repo.read('keep.txt')).toBe('changed\n');
  });

  it('returns the same tree when nothing changed and a new one after an edit', async () => {
    const { snap } = setup();
    const t1 = await snap.snapshot();
    const t2 = await snap.snapshot();
    expect(t2).toBe(t1);
    repo.write('keep.txt', 'edited\n');
    expect(await snap.snapshot()).not.toBe(t1);
  });

  it('reads the staged tree and survives unmerged index entries', async () => {
    const { idx } = setup();
    const headTree = repo.git('rev-parse', 'HEAD^{tree}').trim();
    repo.write('staged.txt', 'v2\n');
    repo.git('add', 'staged.txt');
    const staged = await idx.read(headTree);
    const files = await diffTrees(repo.dir, headTree, staged);
    expect(files.map((f) => f.path)).toEqual(['staged.txt']);

    // Produce a merge conflict.
    repo.git('commit', '-q', '-m', 'v2');
    repo.git('checkout', '-q', '-b', 'other', 'HEAD~1');
    repo.write('staged.txt', 'other\n');
    repo.commit('other');
    repo.git('checkout', '-q', 'main');
    try {
      repo.git('merge', '-q', 'other');
    } catch {
      /* conflict expected */
    }
    expect(repo.git('ls-files', '-u')).not.toBe('');
    const head2 = repo.git('rev-parse', 'HEAD^{tree}').trim();
    const t = await idx.read(head2);
    expect(t).toMatch(/^[0-9a-f]{40}$/);
    expect(repo.git('ls-files', '-u')).not.toBe(''); // real index untouched
  });

  it('measures snapshot cost on a repo with many files', async () => {
    const { snap } = setup();
    for (let i = 0; i < 3000; i++) repo.write(`many/f${i}.txt`, `file ${i}\n`);
    repo.commit('many');
    await snap.snapshot(); // first run hashes everything
    const t0 = performance.now();
    await snap.snapshot();
    const warm = performance.now() - t0;
    console.log(`warm snapshot of 3000 files: ${warm.toFixed(0)} ms`);
    expect(warm).toBeLessThan(1500);
  });
});
