import type { DiffFile, Hunk, Side } from '../shared/types.ts';

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
