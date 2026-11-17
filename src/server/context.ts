import type { DiffFile, Hunk, OriginalLine, Side } from '../shared/types.ts';

const WINDOW = 15;
const FILE_WINDOW = 10;

function hunkRange(h: Hunk, side: Side): [number, number] {
  return side === 'new' ? [h.newStart, h.newStart + Math.max(h.newLines, 1) - 1] : [h.oldStart, h.oldStart + Math.max(h.oldLines, 1) - 1];
}

/**
 * Renders the code around an anchor for an agent.
 * Hunks that cover the anchor come as unified diff with an old/new line-number gutter;
 * anchored lines carry a ">" marker. When no hunk covers the anchor, it renders ~10 lines
 * of the file around it.
 */
export function renderDiffContext(file: DiffFile | null, side: Side, start: number, end: number, sideLines: string[]): string {
  const hunks = (file?.hunks ?? []).filter((h) => {
    const [a, b] = hunkRange(h, side);
    return a <= end && b >= start;
  });
  if (hunks.length) {
    const width = String(Math.max(file!.oldLineCount, file!.newLineCount, end)).length;
    const pad = (n: number | undefined) => (n === undefined ? ''.padStart(width) : String(n).padStart(width));
    const out: string[] = [];
    for (const h of hunks) {
      out.push(`@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@${h.section ? ' ' + h.section : ''}`);
      // Long hunks: keep a window around the anchor.
      const idx = h.lines.map((l, i) => ({ l, i })).filter(({ l }) => {
        const n = side === 'new' ? l.newLine : l.oldLine;
        return n !== undefined && n >= start && n <= end;
      });
      const first = idx[0]?.i ?? 0;
      const last = idx[idx.length - 1]?.i ?? h.lines.length - 1;
      const from = Math.max(0, first - WINDOW);
      const to = Math.min(h.lines.length - 1, last + WINDOW);
      if (from > 0) out.push(`  ${pad(undefined)} ${pad(undefined)}   ... ${from} lines above ...`);
      for (let i = from; i <= to; i++) {
        const l = h.lines[i]!;
        const n = side === 'new' ? l.newLine : l.oldLine;
        const mark = n !== undefined && n >= start && n <= end ? '>' : ' ';
        const sign = l.type === 'add' ? '+' : l.type === 'del' ? '-' : ' ';
        out.push(`${mark} ${pad(l.oldLine)} ${pad(l.newLine)} ${sign}${l.text}`);
      }
      if (to < h.lines.length - 1) out.push(`  ${pad(undefined)} ${pad(undefined)}   ... ${h.lines.length - 1 - to} lines below ...`);
    }
    return out.join('\n');
  }
  // Outside every hunk (unchanged code): plain file content with line numbers.
  const from = Math.max(1, start - FILE_WINDOW);
  const to = Math.min(sideLines.length, end + FILE_WINDOW);
  const width = String(to).length;
  const out = [`(unchanged code, ${side} side, lines ${from}-${to})`];
  for (let n = from; n <= to; n++) {
    const mark = n >= start && n <= end ? '>' : ' ';
    out.push(`${mark} ${String(n).padStart(width)}  ${sideLines[n - 1] ?? ''}`);
  }
  return out.join('\n');
}

/** Lines kept before and after the anchored lines in a thread's code snapshot. */
export const ORIGINAL_RADIUS = 6;
/** Anchored lines kept in a snapshot; a longer anchor keeps its first lines and is marked truncated. */
export const ORIGINAL_MAX_ANCHORED = 40;

/**
 * The code snapshot stored with a new thread: the diff lines around the anchor with their old/new
 * line numbers, the anchored lines flagged, bounded to ORIGINAL_RADIUS lines around the anchor.
 * Uses the same hunk lookup as renderDiffContext. When no hunk covers the anchor (unchanged code),
 * it takes the file lines of `side` as context lines.
 */
export function captureOriginal(
  file: DiffFile | null,
  side: Side,
  start: number,
  end: number,
  sideLines: string[],
): { lines: OriginalLine[]; section: string; truncated: boolean } {
  let truncated = false;
  if (end - start + 1 > ORIGINAL_MAX_ANCHORED) {
    end = start + ORIGINAL_MAX_ANCHORED - 1;
    truncated = true;
  }
  const lineOf = (l: { oldLine?: number; newLine?: number; type: string }) =>
    side === 'new' ? (l.type === 'del' ? undefined : l.newLine) : l.type === 'add' ? undefined : l.oldLine;
  const hunks = (file?.hunks ?? []).filter((h) => {
    const [a, b] = hunkRange(h, side);
    return a <= end && b >= start;
  });
  if (hunks.length) {
    const all = hunks.flatMap((h) => h.lines);
    const inside = (i: number) => {
      const n = lineOf(all[i]!);
      return n !== undefined && n >= start && n <= end;
    };
    let first = -1;
    let last = -1;
    for (let i = 0; i < all.length; i++) {
      if (!inside(i)) continue;
      if (first < 0) first = i;
      last = i;
    }
    if (first >= 0) {
      const from = Math.max(0, first - ORIGINAL_RADIUS);
      const to = Math.min(all.length - 1, last + ORIGINAL_RADIUS);
      const lines: OriginalLine[] = [];
      for (let i = from; i <= to; i++) {
        const l = all[i]!;
        const o: OriginalLine = { type: l.type, text: l.text, anchored: inside(i) };
        if (l.oldLine !== undefined) o.oldLine = l.oldLine;
        if (l.newLine !== undefined) o.newLine = l.newLine;
        lines.push(o);
      }
      // Lines of the window outside the hunks (anchor on the edge of a hunk) are not added: the
      // window stays within what the diff showed.
      return { lines, section: hunks[0]!.section, truncated };
    }
  }
  const from = Math.max(1, start - ORIGINAL_RADIUS);
  const to = Math.min(sideLines.length, end + ORIGINAL_RADIUS);
  const lines: OriginalLine[] = [];
  for (let n = from; n <= to; n++) {
    const o: OriginalLine = { type: 'context', text: sideLines[n - 1] ?? '', anchored: n >= start && n <= end };
    if (side === 'new') o.newLine = n;
    else o.oldLine = n;
    lines.push(o);
  }
  return { lines, section: '', truncated };
}

export { renderOriginal } from '../shared/history-md.ts';
