import { createHash } from 'node:crypto';
import type { DiffFile, DiffFileMeta, DiffLine, FileStatus, Hunk } from '../shared/types.ts';
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

/** File metadata plus the object ids the server needs internally. */
export interface FileMeta extends DiffFileMeta {
  oldId: string | null;
  newId: string | null;
  oldMode: string;
  newMode: string;
  /** Path of the old side (equals path unless renamed). */
  oldSidePath: string;
  /** The raw entry this file came from. */
  entry: RawEntry;
}

/** A file with its hunks. */
export interface FileDiff extends FileMeta {
  hunks: Hunk[];
}

export function sha1(text: string): string {
  return createHash('sha1').update(text).digest('hex');
}

/** Parses `git diff-tree -r -z --raw` output. */
export function parseRawZ(out: string): RawEntry[] {
  return parseRawParts(out.split('\0'), 0).entries;
}

/** Parses raw entries from the start of a -z part list. Stops at the first part that is not a raw header. */
function parseRawParts(parts: string[], start: number): { entries: RawEntry[]; next: number } {
  const entries: RawEntry[] = [];
  let i = start;
  while (i < parts.length) {
    const head = parts[i];
    if (!head || !head.startsWith(':')) break;
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
  return { entries, next: i };
}

/**
 * Parses `git diff-tree -r -z --raw --numstat` output: the raw entries, then one numstat
 * record per entry in the same order. `num` is null for binary files, undefined when missing.
 */
export function parseRawNumstatZ(out: string): Array<{ e: RawEntry; num: [number, number] | null | undefined }> {
  const parts = out.split('\0');
  const { entries, next } = parseRawParts(parts, 0);
  let i = next;
  while (i < parts.length && parts[i] === '') i++;
  return entries.map((e) => {
    const m = /^(-|\d+)\t(-|\d+)\t/.exec(parts[i] ?? '');
    i += e.status === 'R' || e.status === 'C' ? 3 : 1;
    if (!m) return { e, num: undefined };
    return { e, num: m[1] === '-' ? null : [Number(m[1]), Number(m[2])] };
  });
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
    const m = HUNK_RE.exec(stripCr(lines[i]!));
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

/** Small LRU cache. */
class Lru<V> {
  private map = new Map<string, V>();
  constructor(private readonly max: number) {}
  has(k: string): boolean {
    return this.map.has(k);
  }
  get(k: string): V | undefined {
    if (!this.map.has(k)) return undefined;
    const v = this.map.get(k)!;
    this.map.delete(k);
    this.map.set(k, v);
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

/*
 * Caches. Blobs and trees are immutable, so no entry ever goes stale; the caches are only bounded.
 * Per-file results are keyed by the blob pair, so a change to one file never re-diffs the others.
 */
const lineCountCache = new Lru<number>(100_000);
const numstatCache = new Lru<[number, number] | null>(50_000);
interface ParsedPatch {
  hunks: Hunk[];
  binary: boolean;
  tooLarge: boolean;
}
const patchCache = new Lru<ParsedPatch>(4_000);
const rawCache = new Lru<Promise<RawEntry[]>>(64);
const metaCache = new Lru<Promise<FileMeta[]>>(32);

/** Pathspecs are passed as literal paths, never as globs or magic. */
const LITERAL = { GIT_LITERAL_PATHSPECS: '1' };
/** Paths per git invocation, so the argument list stays far below ARG_MAX. */
const PATHS_PER_CALL = 2_000;

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

function pairKey(e: RawEntry): string {
  return `${e.oldMode}:${e.newMode}:${e.oldId}:${e.newId}`;
}

function entryPaths(entries: RawEntry[]): string[] {
  const set = new Set<string>();
  for (const e of entries) {
    set.add(e.oldPath);
    set.add(e.newPath);
  }
  return [...set];
}

function chunked<T>(list: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += n) out.push(list.slice(i, i + n));
  return out;
}

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

/** Fills numstat results for entries that are not cached yet. */
async function fillNumstat(cwd: string, from: string, to: string, all: RawEntry[], missing: RawEntry[], into: Map<string, [number, number] | null>): Promise<void> {
  const args = ['diff-tree', '-r', '-z', '--raw', '--numstat', ...DIFF_FLAGS, from, to];
  // Most files missing (cold start): one call for the whole diff. Else only the missing paths.
  const calls = missing.length * 2 > all.length ? [args] : chunked(entryPaths(missing), PATHS_PER_CALL).map((p) => [...args, '--', ...p]);
  for (const a of calls) {
    for (const { e, num } of parseRawNumstatZ(await git(a, { cwd, env: LITERAL }))) {
      if (num === undefined) continue;
      numstatCache.set(pairKey(e), num);
      into.set(pairKey(e), num);
    }
  }
}

/**
 * Per-file metadata between two trees: status, renames, +/- counts, line counts, fingerprints.
 * No patch text is produced. Cached per tree pair; +/- counts and line counts are cached per blob.
 */
export function diffMeta(cwd: string, from: string, to: string): Promise<FileMeta[]> {
  if (from === to) return Promise.resolve([]);
  const key = `${cwd}:${from}:${to}`;
  let p = metaCache.get(key);
  if (!p) {
    p = computeMeta(cwd, from, to);
    p.catch(() => metaCache.delete(key));
    metaCache.set(key, p);
  }
  return p;
}

async function computeMeta(cwd: string, from: string, to: string): Promise<FileMeta[]> {
  const raw = await rawDiff(cwd, from, to);
  const nums = new Map<string, [number, number] | null>();
  const missing: RawEntry[] = [];
  for (const e of raw) {
    const k = pairKey(e);
    if (numstatCache.has(k)) nums.set(k, numstatCache.get(k)!);
    else missing.push(e);
  }
  if (missing.length) await fillNumstat(cwd, from, to, raw, missing, nums);
  const textIds = raw.filter((e) => nums.get(pairKey(e)) !== null).flatMap((e) => [e.oldId, e.newId]);
  const counts = await lineCounts(cwd, textIds);
  return raw.map((e) => {
    const num = nums.get(pairKey(e));
    const binary = num === null;
    const status = statusOf(e.status);
    const oldExists = !NULL_ID.test(e.oldId) && status !== 'added';
    const newExists = !NULL_ID.test(e.newId) && status !== 'deleted';
    // num undefined: git paired the file differently in a partial call (rare). Fall back to line counts.
    const [additions, deletions] = num ?? (num === undefined ? [newExists ? (counts.get(e.newId) ?? 0) : 0, oldExists ? (counts.get(e.oldId) ?? 0) : 0] : [0, 0]);
    return {
      path: status === 'deleted' ? e.oldPath : e.newPath,
      ...(status === 'renamed' ? { oldPath: e.oldPath } : {}),
      status,
      binary,
      additions,
      deletions,
      tooLarge: !binary && additions + deletions > MAX_FILE_LINES,
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
      entry: e,
    };
  });
}

/** git's C-style quoting of a path in patch headers (core.quotepath=off: only control chars, quote and backslash). */
export function quotePath(s: string): string {
  if (!/["\\\x00-\x1f\x7f]/.test(s)) return s;
  const esc: Record<string, string> = { '\x07': '\\a', '\b': '\\b', '\t': '\\t', '\n': '\\n', '\v': '\\v', '\f': '\\f', '\r': '\\r', '"': '\\"', '\\': '\\\\' };
  return `"${s.replace(/["\\\x00-\x1f\x7f]/g, (c) => esc[c] ?? `\\${c.charCodeAt(0).toString(8).padStart(3, '0')}`)}"`;
}

function patchHeader(e: RawEntry): string {
  return `diff --git ${quotePath(`a/${e.oldPath}`)} ${quotePath(`b/${e.newPath}`)}`;
}

/** Groups patch chunks by their "diff --git" line. A type change (file <-> symlink) has two chunks with one header. */
function chunksByHeader(patch: string): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const c of splitPatch(patch)) {
    const nl = c.indexOf('\n');
    const h = nl < 0 ? c : c.slice(0, nl);
    const list = map.get(h);
    if (list) list.push(c);
    else map.set(h, [c]);
  }
  return map;
}

function parsePatchText(text: string): ParsedPatch {
  if (Buffer.byteLength(text) > MAX_FILE_BYTES) return { hunks: [], binary: false, tooLarge: true };
  const p = parseChunk(text);
  return { hunks: p.binary ? [] : p.hunks, binary: p.binary, tooLarge: false };
}

async function fillPatches(cwd: string, from: string, to: string, need: FileMeta[], into: Map<string, ParsedPatch>): Promise<void> {
  const args = ['diff-tree', '-r', '-p', ...DIFF_FLAGS, from, to, '--'];
  for (const group of chunked(need, PATHS_PER_CALL / 2)) {
    const byHeader = chunksByHeader((await git([...args, ...entryPaths(group.map((f) => f.entry))], { cwd, env: LITERAL })));
    for (const f of group) {
      let chunks = byHeader.get(patchHeader(f.entry));
      if (!chunks) {
        // git paired this file differently when it saw fewer paths: ask for this file alone.
        const one = chunksByHeader(await git([...args, ...entryPaths([f.entry])], { cwd, env: LITERAL }));
        chunks = one.get(patchHeader(f.entry));
        if (!chunks) continue;
      }
      const parsed = parsePatchText(chunks.join(''));
      patchCache.set(pairKey(f.entry), parsed);
      into.set(pairKey(f.entry), parsed);
    }
  }
}

/** Hunks for some files of a diff between two trees. Cached per blob pair. */
export async function diffHunks(cwd: string, from: string, to: string, files: FileMeta[]): Promise<FileDiff[]> {
  const got = new Map<string, ParsedPatch>();
  const need: FileMeta[] = [];
  for (const f of files) {
    if (f.binary || f.tooLarge) continue;
    const k = pairKey(f.entry);
    const c = patchCache.get(k);
    if (c) got.set(k, c);
    else if (!got.has(k)) need.push(f);
  }
  if (need.length) await fillPatches(cwd, from, to, need, got);
  return files.map((f) => {
    const p = got.get(pairKey(f.entry));
    if (!p) return { ...f, hunks: [] };
    return { ...f, hunks: p.hunks, binary: f.binary || p.binary, tooLarge: f.tooLarge || p.tooLarge };
  });
}

/** Computes the full diff (metadata and hunks of every file) between two trees. */
export async function diffTrees(cwd: string, from: string, to: string): Promise<FileDiff[]> {
  const meta = await diffMeta(cwd, from, to);
  return diffHunks(cwd, from, to, meta);
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

/** Arguments of the patch for two trees, for streaming to a client. */
export function patchArgs(from: string, to: string): string[] {
  return ['diff-tree', '-r', '-p', ...DIFF_FLAGS, from, to];
}

/** Strips server-only fields (and hunks) before sending file metadata to a client. */
export function publicMeta(f: FileMeta): DiffFileMeta {
  const { oldId: _a, newId: _b, oldMode: _c, newMode: _d, oldSidePath: _e, entry: _f, ...rest } = f as FileMeta & { hunks?: Hunk[] };
  delete (rest as { hunks?: Hunk[] }).hunks;
  return rest;
}

/** Strips server-only fields before sending a file to a client. */
export function publicFile(f: FileDiff): DiffFile {
  const { oldId: _a, newId: _b, oldMode: _c, newMode: _d, oldSidePath: _e, entry: _f, ...rest } = f;
  return rest;
}
