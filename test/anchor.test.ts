import { afterEach, describe, expect, it } from 'vitest';
import { capture, reanchor } from '../src/server/anchor.ts';
import type { Margin } from '../src/server/service.ts';
import { human, lines, makeMargin, TempRepo } from './helpers.ts';

describe('reanchor (pure)', () => {
  const file = ['a', 'b', 'target()', 'c', 'd', 'e', 'target()', 'f'];

  it('keeps the position when the lines still match', () => {
    expect(reanchor(file, capture(file, 3, 3), 3)).toBe(3);
  });

  it('uses context to pick between equal snippets', () => {
    const cap = capture(file, 7, 7); // context: d, e / f
    const moved = ['x', 'x', ...file];
    expect(reanchor(moved, cap, 7)).toBe(9);
  });

  it('returns null when the snippet is gone', () => {
    expect(reanchor(['a', 'b'], capture(file, 3, 3), 3)).toBeNull();
  });

  it('refuses weak snippets without matching context', () => {
    const src = ['function a() {', '  x();', '}', 'other'];
    const cap = capture(src, 3, 3); // "}"
    expect(reanchor(['zzz', 'yyy', '}', 'qqq'], cap, 1)).toBeNull();
  });
});

describe('thread re-anchoring in a review', () => {
  let repo: TempRepo;
  let m: Margin;
  afterEach(() => {
    m?.close();
    repo?.cleanup();
  });

  async function setup() {
    repo = new TempRepo();
    repo.write('src/app.ts', lines(30));
    repo.commit();
    repo.write('src/app.ts', lines(30).replace('line 10\n', 'line 10 changed\n'));
    m = await makeMargin(repo);
    await m.openReview({ kind: 'working' });
    const t = await m.createThread('working', 'all', {
      anchor: { path: 'src/app.ts', side: 'new', startLine: 10, endLine: 11 },
      body: 'Why?',
      author: human,
    });
    expect(t.snippet).toEqual(['line 10 changed', 'line 11']);
    return t.id;
  }

  const thread = async (id: number) => (await m.getReview('working')).threads.find((t) => t.id === id)!;

  it('moves the anchor when lines are inserted above', async () => {
    const id = await setup();
    repo.write('src/app.ts', 'new top 1\nnew top 2\n' + repo.read('src/app.ts'));
    const t = await thread(id);
    expect(t.anchor).toMatchObject({ startLine: 12, endLine: 13 });
    expect(t.outdated).toBe(false);
  });

  it('marks the thread outdated when the lines change, and restores it when they come back', async () => {
    const id = await setup();
    const original = repo.read('src/app.ts');
    repo.write('src/app.ts', original.replace('line 10 changed\n', 'line 10 rewritten\n'));
    let t = await thread(id);
    expect(t.outdated).toBe(true);
    expect(t.anchor.startLine).toBe(10); // last known anchor kept
    repo.write('src/app.ts', original);
    t = await thread(id);
    expect(t.outdated).toBe(false);
  });

  it('marks the thread outdated when the file leaves the diff', async () => {
    const id = await setup();
    repo.git('checkout', '--', 'src/app.ts');
    expect((await thread(id)).outdated).toBe(true);
  });

  it('follows renames', async () => {
    const id = await setup();
    repo.git('add', '-A');
    repo.git('mv', 'src/app.ts', 'src/main.ts');
    const t = await thread(id);
    expect(t.anchor.path).toBe('src/main.ts');
    expect(t.outdated).toBe(false);
    expect(t.anchor.startLine).toBe(10);
  });

  it('anchors on unchanged lines outside hunks', async () => {
    await setup();
    const t = await m.createThread('working', 'all', {
      anchor: { path: 'src/app.ts', side: 'new', startLine: 25, endLine: 25 },
      body: 'Context question',
      author: human,
    });
    repo.write('src/app.ts', 'top\n' + repo.read('src/app.ts'));
    const after = await thread(t.id);
    expect(after.anchor.startLine).toBe(26);
    const at = await m.agentThreadById(t.id);
    expect(at.diffContext).toContain('> 26  line 25');
  });
});
