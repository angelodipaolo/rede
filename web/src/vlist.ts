/**
 * Windowing for the diff column. Only cards near the viewport are mounted.
 * Heights come from measurement (ResizeObserver) when a card was mounted, else
 * from an estimate. Corrections to cards above the reading position are added to
 * scrollTop in the same frame, so the text under the reader does not move.
 */
import type { DiffFileMeta } from '../../src/shared/types.ts';
import { emit, emitHooks } from './bus.ts';
import { getDiff, getStaleDiff, holdUntil, isCollapsed, nav, requestHunks, S, setCurrent } from './store.ts';

const GAP = 10; // space between cards
const HEADER = 38; // header + card borders
const ROW = 20;
const GAP_ROW = 28;
const THREAD_EST = 150;

export const V = {
  first: 0,
  last: -1,
  anchorIdx: 0,
  tops: new Float64Array(1),
  total: 0,
  index: new Map<string, number>(),
  anchorPath: null as string | null,
  anchorTop: 0,
};

const rowCache = new Map<string, number>();

/** Rows a loaded diff takes, without building the full model. */
function rowsFor(path: string): number | null {
  const d = getDiff(path) ?? getStaleDiff(path);
  if (!d) return null;
  const key = `${S.view}|${path}|${d.fingerprint}`;
  const hit = rowCache.get(key);
  if (hit !== undefined) return hit;
  let rows = 0;
  for (const h of d.hunks) {
    rows += 1.4; // gap / section rows, on average
    if (S.view === 'unified') {
      rows += h.lines.length;
      continue;
    }
    let dels = 0;
    let adds = 0;
    for (const l of h.lines) {
      if (l.type === 'context') {
        rows += Math.max(dels, adds) + 1;
        dels = adds = 0;
      } else if (l.type === 'del') {
        if (adds) {
          rows += Math.max(dels, adds);
          dels = adds = 0;
        }
        dels++;
      } else adds++;
    }
    rows += Math.max(dels, adds);
  }
  if (rowCache.size > 5000) rowCache.clear();
  rowCache.set(key, rows);
  return rows;
}

export function estimate(f: DiffFileMeta): number {
  if (isCollapsed(f)) return HEADER + GAP;
  if (f.binary || f.tooLarge) return HEADER + 46 + GAP;
  const threads = (S.threadsByPath.get(f.path)?.length ?? 0) * THREAD_EST;
  const rows = rowsFor(f.path);
  if (rows !== null) return HEADER + rows * ROW + threads + GAP;
  const changed = S.view === 'split' ? Math.max(f.additions, f.deletions) : f.additions + f.deletions;
  const hunks = Math.max(1, Math.round((f.additions + f.deletions) / 14));
  return HEADER + (changed + hunks * 6) * ROW + hunks * GAP_ROW + threads + GAP;
}

/** Measured heights per metadata object (a new fingerprint is a new object), per collapsed state. */
let measured = new WeakMap<DiffFileMeta, [number | undefined, number | undefined]>();

export function heightOf(f: DiffFileMeta): number {
  const m = measured.get(f);
  const h = m?.[isCollapsed(f) ? 1 : 0];
  return h ?? estimate(f);
}

function setMeasured(f: DiffFileMeta, h: number) {
  let m = measured.get(f);
  if (!m) measured.set(f, (m = [undefined, undefined]));
  m[isCollapsed(f) ? 1 : 0] = h;
}

let dirty = true;
const QUIET = new Set(['current', 'vwin', 'toasts', 'tree', 'filter', 'conn', 'agents', 'progress', 'ui', 'layout']);
emitHooks.push((t) => {
  if (!QUIET.has(t)) dirty = true;
});
export function invalidateLayout() {
  dirty = true;
}

/** Recomputes cumulative tops when something changed. O(files). */
export function layout() {
  if (!dirty && V.tops.length === S.files.length + 1) return;
  dirty = false;
  const files = S.files;
  const n = files.length;
  if (V.tops.length !== n + 1) V.tops = new Float64Array(n + 1);
  let y = 0;
  V.index.clear();
  for (let i = 0; i < n; i++) {
    const f = files[i]!;
    V.index.set(f.path, i);
    V.tops[i] = y;
    y += heightOf(f);
  }
  V.tops[n] = y;
  V.total = y;
}

function indexAt(y: number): number {
  const t = V.tops;
  const n = S.files.length;
  let lo = 0;
  let hi = n - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (t[mid]! <= y) lo = mid;
    else hi = mid - 1;
  }
  return Math.max(0, lo);
}

const PAD_TOP = 12;

/** Recomputes the mounted window. Emits 'vwin' when it changes. */
export function updateWindow(force = false) {
  const sc = S.scroller;
  if (!sc) return;
  layout();
  const n = S.files.length;
  const top = sc.scrollTop - PAD_TOP;
  const h = sc.clientHeight || 800;
  const first = n ? indexAt(Math.max(0, top - h)) : 0;
  const last = n ? indexAt(top + h * 2.2) : -1;
  V.anchorIdx = n ? indexAt(Math.max(0, top)) : 0;
  V.anchorPath = S.files[V.anchorIdx]?.path ?? null;
  V.anchorTop = V.tops[V.anchorIdx] ?? 0;
  const cur = n ? S.files[indexAt(Math.max(0, top + 8))] : undefined;
  if (cur) setCurrent(cur.path);
  if (force || first !== V.first || last !== V.last) {
    V.first = first;
    V.last = last;
    emit('vwin');
  }
  // Prefetch hunks for the window (which already covers the next screenful).
  const want: string[] = [];
  for (let i = first; i <= last; i++) {
    const f = S.files[i]!;
    if (!isCollapsed(f) && !getDiff(f.path)) want.push(f.path);
  }
  if (want.length) requestHunks(want);
}

/**
 * After a render: when heights above the reading position changed (for example a
 * file far above was marked viewed by an agent), shift scrollTop by the same amount.
 */
export function correctAnchor() {
  const sc = S.scroller;
  if (!sc || !V.anchorPath) return;
  layout();
  const i = V.index.get(V.anchorPath);
  if (i === undefined) return;
  const delta = V.tops[i]! - V.anchorTop;
  if (Math.abs(delta) >= 0.5 && performance.now() > holdUntil) sc.scrollTop += delta;
  V.anchorTop = V.tops[i]!;
}

// ------------------------------------------------------------------ measurement

let ro: ResizeObserver | null = null;

export function measureObserver(): ResizeObserver {
  if (ro) return ro;
  ro = new ResizeObserver((entries) => {
    const sc = S.scroller;
    let adjust = 0;
    let changed = false;
    for (const e of entries) {
      const el = e.target as HTMLElement;
      const path = el.dataset.vpath;
      if (!path || !el.isConnected) continue;
      const box = e.borderBoxSize?.[0];
      const h = box ? box.blockSize : el.offsetHeight;
      const f = S.fileByPath.get(path);
      if (!f) continue;
      const old = heightOf(f);
      if (Math.abs(h - old) < 0.5) continue;
      setMeasured(f, h);
      dirty = true;
      changed = true;
      const idx = V.index.get(path);
      if (idx !== undefined && idx < V.anchorIdx) adjust += h - old;
    }
    if (!changed || !sc) return;
    if (adjust && performance.now() > holdUntil) sc.scrollTop += adjust;
    updateWindow();
    emit('vspace');
  });
  return ro;
}

export function resetHeights() {
  measured = new WeakMap();
  dirty = true;
}

// ------------------------------------------------------------------ navigation

export function scrollToIndex(i: number) {
  const sc = S.scroller;
  if (!sc) return;
  layout();
  V.anchorIdx = i;
  sc.scrollTop = V.tops[i]! + PAD_TOP;
  updateWindow(true);
  const f = S.files[i];
  if (f && !getDiff(f.path)) requestHunks([f.path], true);
}

nav.toFile = (path) => {
  layout();
  const i = V.index.get(path);
  if (i !== undefined) scrollToIndex(i);
};

nav.fileTop = (path) => {
  const i = V.index.get(path);
  const sc = S.scroller;
  if (i === undefined || !sc) return null;
  return V.tops[i]! + PAD_TOP - sc.scrollTop;
};
