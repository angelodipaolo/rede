import type { DiffFile, DiffLineType, Side } from '../../src/shared/types.ts';
import { wordDiff, type Ranges } from './worddiff.ts';

/** One displayed code line. Shared by unified and split rows. */
export interface DLine {
  type: DiffLineType;
  o?: number;
  n?: number;
  text: string;
  /** Context revealed by "expand". */
  exp?: boolean;
  /** Paired line on the other side (del <-> add) for word diff. */
  pair?: DLine;
  /** Lazily computed word-diff ranges. undefined = not computed, null = none. */
  wd?: Ranges | null;
}

export interface GapRow {
  gap: true;
  /** Unique per row: base id plus the segment start. */
  id: string;
  /** The hidden region between two hunks this row belongs to. Expansions are keyed by it. */
  base: string;
  /** Hidden segment [ks, ke) in line offsets from the start of the base region. */
  ks: number;
  ke: number;
  o: number;
  n: number;
  count: number;
  section: string;
  /** Lines can only be revealed when the full text is known. */
  position: 'top' | 'mid' | 'end';
}

export interface SplitRow {
  l: DLine | null;
  r: DLine | null;
}

export type URow = DLine | GapRow;
export type SRow = SplitRow | GapRow;
export type Row = URow | SRow;

export const isGap = (r: Row): r is GapRow => (r as GapRow).gap === true;

/** Revealed line ranges [a, b) in offsets from the start of a hidden region. */
export interface Expansion {
  ranges: [number, number][];
}

/** Lines that must be visible (thread anchors); revealed with a few lines around them. */
export interface Pin {
  side: Side;
  start: number;
  end: number;
}

const PIN_CONTEXT = 3;

function mergeRanges(list: [number, number][], count: number): [number, number][] {
  const r = list
    .map(([a, b]) => [Math.max(0, a), Math.min(count, b)] as [number, number])
    .filter(([a, b]) => b > a)
    .sort((x, y) => x[0] - y[0]);
  const out: [number, number][] = [];
  for (const x of r) {
    const last = out[out.length - 1];
    if (last && x[0] <= last[1]) last[1] = Math.max(last[1], x[1]);
    else out.push([x[0], x[1]]);
  }
  return out;
}

export interface FileModel {
  unified: URow[];
  split: SRow[];
  /** "n12" / "o40" -> row index, per view. */
  uIndex: Map<string, number>;
  sIndex: Map<string, number>;
}

/**
 * Builds display rows for a file. `ctx` is the full text (new side, else old) used to
 * reveal hidden context; without it gaps stay collapsed.
 */
export function buildModel(
  file: DiffFile,
  exp: Map<string, Expansion> | undefined,
  ctx: string[] | null,
  allowGaps: boolean,
  pins: Pin[] = [],
): FileModel {
  const unified: URow[] = [];
  let prevO = 0;
  let prevN = 0;
  const twoSided = file.status !== 'added' && file.status !== 'deleted';

  const addGap = (id: string, o0: number, n0: number, count: number, section: string, position: GapRow['position']) => {
    const gapRow = (ks: number, ke: number, sect: string): GapRow => ({
      gap: true,
      id: `${id}@${ks}`,
      base: id,
      ks,
      ke,
      o: o0 + ks,
      n: n0 + ks,
      count: ke - ks,
      section: sect,
      position: ks === 0 && position === 'top' ? 'top' : ke === count && position === 'end' ? 'end' : 'mid',
    });
    if (count <= 0) {
      if (section && position !== 'end') unified.push(gapRow(0, 0, section));
      return;
    }
    let revealed: [number, number][] = [];
    if (ctx) {
      const want = [...(exp?.get(id)?.ranges ?? [])];
      for (const p of pins) {
        const base = p.side === 'old' ? o0 : n0;
        if (p.end < base || p.start >= base + count) continue;
        want.push([p.start - base - PIN_CONTEXT, p.end - base + 1 + PIN_CONTEXT]);
      }
      revealed = mergeRanges(want, count);
    }
    let cur = 0;
    const show = (a: number, b: number) => {
      for (let k = a; k < b; k++) unified.push({ type: 'context', o: o0 + k, n: n0 + k, text: ctx![n0 + k - 1] ?? '', exp: true });
    };
    for (const [a, b] of revealed) {
      if (a > cur) unified.push(gapRow(cur, a, ''));
      show(a, b);
      cur = b;
    }
    if (cur < count) unified.push(gapRow(cur, count, section));
    else if (section && position !== 'end') unified.push(gapRow(count, count, section));
  };

  file.hunks.forEach((h, i) => {
    const firstO = h.oldLines > 0 ? h.oldStart : h.oldStart + 1;
    const firstN = h.newLines > 0 ? h.newStart : h.newStart + 1;
    if (twoSided && allowGaps) addGap(i === 0 ? 'top' : `g${i}`, prevO + 1, prevN + 1, firstN - 1 - prevN, h.section, i === 0 ? 'top' : 'mid');
    else if (h.section)
      unified.push({ gap: true, id: `h${i}`, base: `h${i}`, ks: 0, ke: 0, o: firstO, n: firstN, count: 0, section: h.section, position: 'mid' });
    // Pair del runs with the following add runs.
    let dels: DLine[] = [];
    let addsSeen = 0;
    for (const l of h.lines) {
      const d: DLine = { type: l.type, o: l.oldLine, n: l.newLine, text: l.text };
      if (l.type === 'del') {
        if (addsSeen) {
          dels = [];
          addsSeen = 0;
        }
        dels.push(d);
      } else if (l.type === 'add') {
        const partner = dels[addsSeen];
        if (partner) {
          partner.pair = d;
          d.pair = partner;
        }
        addsSeen++;
      } else {
        dels = [];
        addsSeen = 0;
      }
      unified.push(d);
    }
    prevO = firstO + h.oldLines - 1;
    prevN = firstN + h.newLines - 1;
  });
  if (twoSided && allowGaps && file.hunks.length) {
    const total = ctx ? ctx.length : file.newLineCount;
    addGap('end', prevO + 1, prevN + 1, total - prevN, '', 'end');
  }

  // Split rows: context on both sides, del run beside the following add run.
  const split: SRow[] = [];
  for (let i = 0; i < unified.length; ) {
    const r = unified[i]!;
    if (isGap(r)) {
      split.push(r);
      i++;
      continue;
    }
    if (r.type === 'context') {
      split.push({ l: r, r });
      i++;
      continue;
    }
    const dels: DLine[] = [];
    const adds: DLine[] = [];
    while (i < unified.length) {
      const x = unified[i]!;
      if (isGap(x) || x.type !== 'del') break;
      dels.push(x);
      i++;
    }
    while (i < unified.length) {
      const x = unified[i]!;
      if (isGap(x) || x.type !== 'add') break;
      adds.push(x);
      i++;
    }
    const k = Math.max(dels.length, adds.length);
    for (let j = 0; j < k; j++) split.push({ l: dels[j] ?? null, r: adds[j] ?? null });
  }

  const uIndex = new Map<string, number>();
  unified.forEach((r, i) => {
    if (isGap(r)) return;
    if (r.type !== 'add' && r.o !== undefined) uIndex.set('o' + r.o, i);
    if (r.type !== 'del' && r.n !== undefined) uIndex.set('n' + r.n, i);
  });
  const sIndex = new Map<string, number>();
  split.forEach((r, i) => {
    if (isGap(r)) return;
    if (r.l && r.l.o !== undefined) sIndex.set('o' + r.l.o, i);
    if (r.r && r.r.n !== undefined) sIndex.set('n' + r.r.n, i);
  });
  return { unified, split, uIndex, sIndex };
}

export function wordRanges(d: DLine): Ranges | null {
  if (d.wd !== undefined) return d.wd;
  if (!d.pair) return (d.wd = null);
  const del = d.type === 'del' ? d : d.pair;
  const add = d.type === 'del' ? d.pair : d;
  const res = wordDiff(del.text, add.text);
  del.wd = res ? res.a : null;
  add.wd = res ? res.b : null;
  return d.wd ?? null;
}

/** Side and line number that a gutter click on this line targets. */
export function lineTarget(d: DLine, side?: Side): { side: Side; line: number } | null {
  if (side === 'old') return d.o !== undefined ? { side: 'old', line: d.o } : null;
  if (side === 'new') return d.n !== undefined ? { side: 'new', line: d.n } : null;
  if (d.type === 'del') return { side: 'old', line: d.o! };
  return d.n !== undefined ? { side: 'new', line: d.n } : null;
}

export const ROW_H = 20;
export const GAP_H = 28;
export const CHUNK = 120;
