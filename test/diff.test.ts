import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { diffTrees, parseChunk, parseNumstatZ, parseRawZ, splitPatch } from '../src/server/diff.ts';
import { lines, TempRepo } from './helpers.ts';

describe('parseChunk', () => {
  it('parses hunks, line numbers and "no newline" markers', () => {
    const p = [
      'diff --git a/f b/f',
      'index 1..2 100644',
      '--- a/f',
      '+++ b/f',
      '@@ -1,3 +1,4 @@ function x() {',
      ' a',
      '-b',
      '+B',
      ' c',
      '+d',
      '\\ No newline at end of file',
      '',
    ].join('\n');
    const r = parseChunk(p);
    expect(r.hunks).toHaveLength(1);
    const h = r.hunks[0]!;
    expect(h.section).toBe('function x() {');
    expect(h.lines.map((l) => [l.type, l.oldLine, l.newLine, l.text])).toEqual([
      ['context', 1, 1, 'a'],
      ['del', 2, undefined, 'b'],
      ['add', undefined, 2, 'B'],
      ['context', 3, 3, 'c'],
      ['add', undefined, 4, 'd'],
    ]);
    expect(r.additions).toBe(2);
    expect(r.deletions).toBe(1);
  });

  it('handles single-line hunk headers without counts and the no-newline marker mid-hunk', () => {
    const p = ['@@ -1 +1 @@', '-x', '\\ No newline at end of file', '+y', '\\ No newline at end of file'].join('\n');
    const r = parseChunk(p);
    expect(r.hunks[0]!.lines.map((l) => l.type)).toEqual(['del', 'add']);
  });

  it('detects binary patches', () => {
    expect(parseChunk('diff --git a/x b/x\nindex 1..2\nBinary files a/x and b/x differ\n').binary).toBe(true);
  });

  it('strips CR from CRLF lines', () => {
    const r = parseChunk('@@ -1 +1 @@\r\n-a\r\n+b\r\n');
    expect(r.hunks[0]!.lines.map((l) => l.text)).toEqual(['a', 'b']);
  });

  it('splits multi-file patches only at line starts', () => {
    const chunks = splitPatch('diff --git a/a b/a\n@@ -1 +1 @@\n-diff --git x\n+y\ndiff --git a/b b/b\n');
    expect(chunks).toHaveLength(2);
  });

  it('parses raw and numstat -z output including renames', () => {
    const raw = ':100644 100644 aaa bbb R090\0old name\0new name\0:000000 100644 000 ccc A\0x y\0';
    expect(parseRawZ(raw).map((e) => [e.status, e.oldPath, e.newPath])).toEqual([
      ['R', 'old name', 'new name'],
      ['A', 'x y', 'x y'],
    ]);
    expect(parseNumstatZ('1\t2\t\0old\0new\0-\t-\tbin\0')).toEqual([[1, 2], null]);
  });
});

describe('diffTrees', () => {
  let repo: TempRepo;
  afterEach(() => repo?.cleanup());

  async function trees(setup: (r: TempRepo) => void) {
    repo = new TempRepo();
    const a = repo.git('write-tree').trim();
    setup(repo);
    repo.git('add', '-A');
    const b = repo.git('write-tree').trim();
    return diffTrees(repo.dir, a, b);
  }

  it('covers renames, binary, mode-only, empty, deleted, unicode and space paths', async () => {
    repo = new TempRepo();
    repo.write('f.txt', 'a\nb\nc\nd\ne\nf\n');
    repo.write('sp ace é.txt', 'x\n');
    repo.write('bin.dat', Buffer.from([0, 1, 2, 3]));
    repo.write('empty', '');
    repo.write('script.sh', 'echo\n');
    repo.commit();
    const a = repo.git('rev-parse', 'HEAD^{tree}').trim();
    repo.git('mv', 'f.txt', 'g.txt');
    repo.write('g.txt', 'a\nB\nc\nd\ne\nf');
    repo.rm('sp ace é.txt');
    repo.write('bin.dat', Buffer.from([0, 9, 9, 9]));
    fs.chmodSync(path.join(repo.dir, 'script.sh'), 0o755);
    repo.write('new empty', '');
    repo.write('ünï/cødé.ts', 'const x = 1;\n');
    repo.git('add', '-A');
    const b = repo.git('write-tree').trim();
    const files = await diffTrees(repo.dir, a, b);
    const by = Object.fromEntries(files.map((f) => [f.path, f]));

    expect(by['g.txt']).toMatchObject({ status: 'renamed', oldPath: 'f.txt', additions: 2, deletions: 2, oldLineCount: 6, newLineCount: 6 });
    expect(by['g.txt']!.hunks[0]!.lines.some((l) => l.type === 'add' && l.text === 'f')).toBe(true);
    expect(by['sp ace é.txt']).toMatchObject({ status: 'deleted', newLineCount: 0, oldLineCount: 1 });
    expect(by['bin.dat']).toMatchObject({ status: 'modified', binary: true, hunks: [] });
    expect(by['script.sh']).toMatchObject({ status: 'modified', additions: 0, deletions: 0, hunks: [] });
    expect(by['new empty']).toMatchObject({ status: 'added', hunks: [], newLineCount: 0 });
    expect(by['ünï/cødé.ts']).toMatchObject({ status: 'added', additions: 1, newLineCount: 1 });
    for (const f of files) expect(f.fingerprint).toMatch(/^[0-9a-f]{16}$/);
  });

  it('marks huge files as tooLarge and omits hunks', async () => {
    const files = await trees((r) => r.write('big.txt', lines(25_000)));
    expect(files[0]).toMatchObject({ tooLarge: true, hunks: [], additions: 25_000, newLineCount: 25_000 });
  });

  it('gives the same fingerprint for the same change and a new one when it changes', async () => {
    repo = new TempRepo();
    repo.write('a.txt', 'one\n');
    repo.commit();
    const base = repo.git('rev-parse', 'HEAD^{tree}').trim();
    repo.write('a.txt', 'two\n');
    repo.git('add', '-A');
    const t1 = repo.git('write-tree').trim();
    repo.write('a.txt', 'three\n');
    repo.git('add', '-A');
    const t2 = repo.git('write-tree').trim();
    const [f1] = await diffTrees(repo.dir, base, t1);
    const [f1b] = await diffTrees(repo.dir, base, t1);
    const [f2] = await diffTrees(repo.dir, base, t2);
    expect(f1!.fingerprint).toBe(f1b!.fingerprint);
    expect(f1!.fingerprint).not.toBe(f2!.fingerprint);
  });
});
