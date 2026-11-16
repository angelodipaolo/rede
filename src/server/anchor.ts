/** Lines of context stored before and after an anchor for re-anchoring. */
export const CONTEXT_LINES = 3;

/** Splits file text into lines without terminators. A trailing newline does not add a line. */
export function splitLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

export interface Capture {
  snippet: string[];
  ctxBefore: string[];
  ctxAfter: string[];
}

/** Captures the snippet and context for a 1-based inclusive range. */
export function capture(lines: string[], start: number, end: number): Capture {
  return {
    snippet: lines.slice(start - 1, end),
    ctxBefore: lines.slice(Math.max(0, start - 1 - CONTEXT_LINES), start - 1),
    ctxAfter: lines.slice(end, end + CONTEXT_LINES),
  };
}

function eqAt(lines: string[], at: number, want: string[], loose: boolean): boolean {
  if (at < 0 || at + want.length > lines.length) return false;
  for (let k = 0; k < want.length; k++) {
    const a = lines[at + k]!;
    const b = want[k]!;
    if (loose ? a.trim() !== b.trim() : a !== b) return false;
  }
  return true;
}

/** Lines like "}", "", "end" match almost anywhere: they count a quarter of a real line. */
function lineWeight(l: string): number {
  return l.trim().length < 4 ? 0.25 : 1;
}

function contextScore(lines: string[], at: number, c: Capture): number {
  let score = 0;
  // Before: compare from the nearest line outward.
  for (let k = 1; k <= c.ctxBefore.length; k++) {
    const want = c.ctxBefore[c.ctxBefore.length - k]!;
    const line = lines[at - k];
    if (line !== undefined && line.trim() === want.trim()) score += lineWeight(want);
  }
  const after = at + c.snippet.length;
  for (let k = 0; k < c.ctxAfter.length; k++) {
    const want = c.ctxAfter[k]!;
    const line = lines[after + k];
    if (line !== undefined && line.trim() === want.trim()) score += lineWeight(want);
  }
  return score;
}

function maxScore(c: Capture): number {
  return [...c.ctxBefore, ...c.ctxAfter].reduce((n, l) => n + lineWeight(l), 0);
}

/** A snippet made only of short lines ("}", blank) matches too many places to trust alone. */
function isWeak(snippet: string[]): boolean {
  return snippet.every((l) => l.trim().length < 4);
}

/**
 * Finds the new 1-based start line of a snippet in the current content.
 * Returns null when the snippet cannot be found, or cannot be found with confidence.
 *
 * Every place where the snippet occurs is scored by how much of the stored context around it
 * still matches (more is better), then by distance to the old position. The old position wins
 * at once when the snippet and all its context are still there. Falls back to a
 * whitespace-insensitive search.
 *
 * A thread must never jump silently to an identical line elsewhere (the commented line was
 * edited, and the same text exists in another function). So when no context matches around
 * any occurrence, the thread only moves for a snippet of three or more substantial lines;
 * shorter snippets stay where they were if the text is still there, else they become outdated.
 */
export function reanchor(lines: string[], c: Capture, oldStart: number): number | null {
  const n = c.snippet.length;
  if (n === 0) return null;
  const full = maxScore(c);
  if (eqAt(lines, oldStart - 1, c.snippet, false) && contextScore(lines, oldStart - 1, c) === full) return oldStart;
  for (const loose of [false, true]) {
    let best: { at: number; score: number; dist: number } | null = null;
    for (let at = 0; at + n <= lines.length; at++) {
      if (!eqAt(lines, at, c.snippet, loose)) continue;
      const score = contextScore(lines, at, c);
      const dist = Math.abs(at + 1 - oldStart);
      if (!best || score > best.score || (score === best.score && dist < best.dist)) best = { at, score, dist };
    }
    if (!best) continue;
    if (full === 0 || best.score >= Math.min(1, full)) return best.at + 1;
    // No real context agrees anywhere.
    if (best.dist === 0) return best.at + 1;
    const substantial = c.snippet.filter((l) => l.trim().length >= 4).length;
    if (!isWeak(c.snippet) && substantial >= 3) return best.at + 1;
    return null;
  }
  return null;
}
