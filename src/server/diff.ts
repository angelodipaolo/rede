import { createHash } from 'node:crypto';
import type { DiffFile, DiffLine, FileStatus, Hunk } from '../shared/types.ts';
import { catFileBatch, git, gitBuffer } from './git.ts';

export const MAX_FILE_LINES = 20_000;
export const MAX_FILE_BYTES = 1_500_000;
const NULL_ID = /^0+$/;

/** One entry of `git diff-tree --raw`. */
export interface RawEntry {
  oldMode: string;
  newMode: string;
  oldId: string;
  newId: string;
  /** First letter of the status: A, D, M, T, R, C, U. */
  status: string;
  oldPath: string;
  newPath: string;
}

/** A diff file plus the object ids the server needs internally. */
export interface FileDiff extends DiffFile {
  oldId: string | null;
  newId: string | null;
  oldMode: string;
  newMode: string;
  /** Path of the old side (equals path unless renamed). */
  oldSidePath: string;
}

export function sha1(text: string): string {
  return createHash('sha1').update(text).digest('hex');
}

/** Parses `git diff-tree -r -z --raw` output. */
export function parseRawZ(out: string): RawEntry[] {
  const parts = out.split('\0');
  const entries: RawEntry[] = [];
  let i = 0;
  while (i < parts.length) {
    const head = parts[i];
    if (!head || !head.startsWith(':')) {
      i++;
      continue;
    }
    const [oldMode, newMode, oldId, newId, statusRaw] = head.slice(1).split(' ');
    const status = (statusRaw ?? 'M').charAt(0);
    if (status === 'R' || status === 'C') {
      entries.push({ oldMode: oldMode!, newMode: newMode!, oldId: oldId!, newId: newId!, status, oldPath: parts[i + 1]!, newPath: parts[i + 2]! });
      i += 3;
    } else {
      const p = parts[i + 1]!;
      entries.push({ oldMode: oldMode!, newMode: newMode!, oldId: oldId!, newId: newId!, status, oldPath: p, newPath: p });
      i += 2;
    }
  }
  return entries;
}

/** Parses `git diff-tree -r -z --numstat` output into [additions, deletions] (null for binary). */
export function parseNumstatZ(out: string): Array<[number, number] | null> {
  const parts = out.split('\0');
  const res: Array<[number, number] | null> = [];
  let i = 0;
  while (i < parts.length) {
    const p = parts[i]!;
    if (!p) {
      i++;
      continue;
    }
    const m = /^(-|\d+)\t(-|\d+)\t(.*)$/s.exec(p);
    if (!m) {
      i++;
      continue;
    }
    res.push(m[1] === '-' ? null : [Number(m[1]), Number(m[2])]);
    // Renames: "a\td\t" followed by two path fields.
    i += m[3] === '' ? 3 : 1;
  }
  return res;
}

/** Splits a multi-file patch into one chunk per "diff --git" header. */
export function splitPatch(patch: string): string[] {
  const chunks: string[] = [];
  let start = -1;
  let pos = 0;
  while (pos <= patch.length) {
    const atLineStart = pos === 0 || patch.charCodeAt(pos - 1) === 10;
    if (atLineStart && patch.startsWith('diff --git ', pos)) {
      if (start >= 0) chunks.push(patch.slice(start, pos));
      start = pos;
    }
    const nl = patch.indexOf('\n', pos);
    if (nl < 0) break;
    pos = nl + 1;
  }
  if (start >= 0) chunks.push(patch.slice(start));
  return chunks;
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/;

export interface ParsedChunk {
  hunks: Hunk[];
  binary: boolean;
  additions: number;
  deletions: number;
}

function stripCr(s: string): string {
  return s.endsWith('\r') ? s.slice(0, -1) : s;
}

/** Parses the hunks of one file's patch text. */
export function parseChunk(chunk: string): ParsedChunk {
  const lines = chunk.split('\n');
  const hunks: Hunk[] = [];
  let binary = false;
  let additions = 0;
  let deletions = 0;
  let i = 0;
  // Header: everything before the first hunk.
  for (; i < lines.length; i++) {
    const l = lines[i]!;
    if (l.startsWith('@@ ')) break;
    if (l.startsWith('Binary files ') || l === 'GIT binary patch') binary = true;
  }
  while (i < lines.length) {
    const m = HUNK_RE.exec(lines[i]!);
    if (!m) {
      i++;
      continue;
    }
    const hunk: Hunk = {
      oldStart: Number(m[1]),
      oldLines: m[2] === undefined ? 1 : Number(m[2]),
      newStart: Number(m[3]),
      newLines: m[4] === undefined ? 1 : Number(m[4]),
      section: stripCr(m[5] ?? '').trim(),
      lines: [],
    };
    i++;
    let oldNo = hunk.oldStart;
    let newNo = hunk.newStart;
    let oldLeft = hunk.oldLines;
    let newLeft = hunk.newLines;
    while (i < lines.length && (oldLeft > 0 || newLeft > 0)) {
      const l = lines[i]!;
      const c = l.charAt(0);
      const text = stripCr(l.slice(1));
      let dl: DiffLine | null = null;
      if (c === '+') {
        dl = { type: 'add', newLine: newNo++, text };
        newLeft--;
        additions++;
      } else if (c === '-') {
        dl = { type: 'del', oldLine: oldNo++, text };
        oldLeft--;
        deletions++;
      } else if (c === ' ' || l === '') {
        dl = { type: 'context', oldLine: oldNo++, newLine: newNo++, text };
        oldLeft--;
        newLeft--;
      } else if (c === '\\') {
        // "\ No newline at end of file"
      } else {
        break;
      }
      if (dl) hunk.lines.push(dl);
      i++;
    }
    // A trailing "\ No newline" line belongs to this hunk.
    while (i < lines.length && lines[i]!.startsWith('\\')) i++;
    hunks.push(hunk);
  }
  return { hunks, binary, additions, deletions };
}

function statusOf(s: string): FileStatus {
  if (s === 'A') return 'added';
  if (s === 'D') return 'deleted';
  if (s === 'R') return 'renamed';
  return 'modified';
}

export function countLines(buf: Buffer): number {
  if (buf.length === 0) return 0;
  let n = 0;
  let idx = -1;
  while ((idx = buf.indexOf(10, idx + 1)) >= 0) n++;
  if (buf[buf.length - 1] !== 10) n++;
  return n;
}

/** Line counts per blob id. Blobs never change, so the cache never goes stale. */
const lineCountCache = new Map<string, number>();
const LINE_CACHE_MAX = 100_000;

async function lineCounts(cwd: string, ids: string[]): Promise<Map<string, number>> {
  const res = new Map<string, number>();
  const missing: string[] = [];
  for (const id of ids) {
    if (NULL_ID.test(id)) continue;
    const c = lineCountCache.get(id);
    if (c === undefined) missing.push(id);
    else res.set(id, c);
  }
  if (missing.length) {
    const blobs = await catFileBatch(cwd, missing);
    if (lineCountCache.size > LINE_CACHE_MAX) lineCountCache.clear();
    for (const [id, buf] of blobs) {
      const n = countLines(buf);
      lineCountCache.set(id, n);
      res.set(id, n);
    }
  }
  return res;
}

const DIFF_FLAGS = ['--no-ext-diff', '--no-textconv', '-M', '--src-prefix=a/', '--dst-prefix=b/'];

export function fileFingerprint(e: RawEntry): string {
  return sha1([e.oldMode, e.newMode, e.oldId, e.newId, e.oldPath, e.newPath].join('\0')).slice(0, 16);
}

/** Small LRU caches keyed by "from:to". Trees are immutable, so entries never go stale. */
class Lru<V> {
  private map = new Map<string, V>();
  constructor(private readonly max: number) {}
  get(k: string): V | undefined {
    const v = this.map.get(k);
    if (v !== undefined) {
      this.map.delete(k);
      this.map.set(k, v);
    }
    return v;
  }
  delete(k: string): void {
    this.map.delete(k);
  }
  set(k: string, v: V): void {
    this.map.delete(k);
    this.map.set(k, v);
    while (this.map.size > this.max) this.map.delete(this.map.keys().next().value!);
  }
}

const rawCache = new Lru<Promise<RawEntry[]>>(64);
const fullCache = new Lru<Promise<FileDiff[]>>(12);

/** The list of changed files between two trees (cheap: no patch text). Cached. */
export function rawDiff(cwd: string, from: string, to: string): Promise<RawEntry[]> {
  if (from === to) return Promise.resolve([]);
  const key = `${cwd}:${from}:${to}`;
  let p = rawCache.get(key);
  if (!p) {
    p = git(['diff-tree', '-r', '-z', '--raw', ...DIFF_FLAGS, from, to], { cwd }).then(parseRawZ);
    p.catch(() => rawCache.delete(key));
    rawCache.set(key, p);
  }
  return p;
}

export function fingerprintOfRaw(entries: RawEntry[]): string {
  return diffFingerprintOf(entries.map((e) => ({ fingerprint: fileFingerprint(e) })));
}

/** Computes the full diff between two trees. viewed/changedSinceViewed are left false. Cached. */
export function diffTrees(cwd: string, from: string, to: string): Promise<FileDiff[]> {
  const key = `${cwd}:${from}:${to}`;
  let p = fullCache.get(key);
  if (!p) {
    p = computeDiffTrees(cwd, from, to);
    p.catch(() => fullCache.delete(key));
    fullCache.set(key, p);
  }
  return p;
}

async function computeDiffTrees(cwd: string, from: string, to: string): Promise<FileDiff[]> {
  if (from === to) return [];
  const [raw, numOut, patchBuf] = await Promise.all([
    rawDiff(cwd, from, to),
    git(['diff-tree', '-r', '-z', '--numstat', ...DIFF_FLAGS, from, to], { cwd }),
    gitBuffer(['diff-tree', '-r', '-p', ...DIFF_FLAGS, from, to], { cwd }),
  ]);
  const nums = parseNumstatZ(numOut);
  const chunks = splitPatch(patchBuf.toString('utf8'));
  const counts = await lineCounts(cwd, raw.flatMap((e) => [e.oldId, e.newId]));
  const files: FileDiff[] = [];
  raw.forEach((e, idx) => {
    const chunk = chunks[idx] ?? '';
    const num = nums[idx];
    const binaryByNum = num === null;
    const tooLarge =
      !binaryByNum &&
      ((num !== undefined && num[0] + num[1] > MAX_FILE_LINES) || Buffer.byteLength(chunk) > MAX_FILE_BYTES);
    const parsed = tooLarge ? null : parseChunk(chunk);
    const binary = binaryByNum || (parsed?.binary ?? false);
    const status = statusOf(e.status);
    const oldExists = !NULL_ID.test(e.oldId) && status !== 'added';
    const newExists = !NULL_ID.test(e.newId) && status !== 'deleted';
    const path = status === 'deleted' ? e.oldPath : e.newPath;
    files.push({
      path,
      ...(status === 'renamed' ? { oldPath: e.oldPath } : {}),
      status,
      binary,
      additions: num ? num[0] : (parsed?.additions ?? 0),
      deletions: num ? num[1] : (parsed?.deletions ?? 0),
      hunks: binary || !parsed ? [] : parsed.hunks,
      tooLarge,
      fingerprint: fileFingerprint(e),
      viewed: false,
      changedSinceViewed: false,
      oldLineCount: oldExists && !binary ? (counts.get(e.oldId) ?? 0) : 0,
      newLineCount: newExists && !binary ? (counts.get(e.newId) ?? 0) : 0,
      oldId: oldExists ? e.oldId : null,
      newId: newExists ? e.newId : null,
      oldMode: e.oldMode,
      newMode: e.newMode,
      oldSidePath: e.oldPath,
    });
  });
  return files;
}

export function diffFingerprintOf(files: Array<{ fingerprint: string }>): string {
  return sha1(files.map((f) => f.fingerprint).join('\n')).slice(0, 16);
}

/** Diffs two blobs and returns the parsed hunks. */
export async function diffBlobs(cwd: string, oldId: string, newId: string): Promise<ParsedChunk> {
  const out = await git(['diff', '--no-ext-diff', '--no-textconv', '--no-color', '-p', oldId, newId], {
    cwd,
    okCodes: [0, 1],
  });
  return parseChunk(out);
}

/** Strips server-only fields before sending a file to a client. */
export function publicFile(f: FileDiff): DiffFile {
  const { oldId: _a, newId: _b, oldMode: _c, newMode: _d, oldSidePath: _e, ...rest } = f;
  return rest;
}
