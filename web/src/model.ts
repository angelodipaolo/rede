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
  id: string;
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

export interface Expansion {
  top: number;
  bottom: number;
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
): FileModel {
  const unified: URow[] = [];
  let prevO = 0;
  let prevN = 0;
  const twoSided = file.status !== 'added' && file.status !== 'deleted';

  const addGap = (id: string, o0: number, n0: number, count: number, section: string, position: GapRow['position']) => {
    if (count <= 0) {
      if (section && position !== 'end')
        unified.push({ gap: true, id, o: o0, n: n0, count: 0, section, position });
      return;
    }
    const e = exp?.get(id);
    let top = ctx ? Math.min(e?.top ?? 0, count) : 0;
    let bottom = ctx ? Math.min(e?.bottom ?? 0, count - top) : 0;
    for (let k = 0; k < top; k++) {
      unified.push({ type: 'context', o: o0 + k, n: n0 + k, text: ctx![n0 + k - 1] ?? '', exp: true });
    }
    const rest = count - top - bottom;
    if (rest > 0) unified.push({ gap: true, id, o: o0 + top, n: n0 + top, count: rest, section, position });
    else if (section && position !== 'end') unified.push({ gap: true, id, o: o0 + top, n: n0 + top, count: 0, section, position });
    for (let k = count - bottom; k < count; k++) {
      unified.push({ type: 'context', o: o0 + k, n: n0 + k, text: ctx![n0 + k - 1] ?? '', exp: true });
    }
  };

  file.hunks.forEach((h, i) => {
    const firstO = h.oldLines > 0 ? h.oldStart : h.oldStart + 1;
    const firstN = h.newLines > 0 ? h.newStart : h.newStart + 1;
    if (twoSided && allowGaps) addGap(i === 0 ? 'top' : `g${i}`, prevO + 1, prevN + 1, firstN - 1 - prevN, h.section, i === 0 ? 'top' : 'mid');
    else if (h.section) unified.push({ gap: true, id: `h${i}`, o: firstO, n: firstN, count: 0, section: h.section, position: 'mid' });
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
