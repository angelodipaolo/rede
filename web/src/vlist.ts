/**
 * Windowing for the diff column. Only cards near the viewport are mounted.
 * Heights come from measurement (ResizeObserver) when a card was mounted, else
 * from an estimate. Corrections to cards above the reading position are added to
 * scrollTop in the same frame, so the text under the reader does not move.
 */
import type { DiffFileMeta } from '../../src/shared/types.ts';
import { emit, emitHooks } from './bus.ts';
import { getDiff, getStaleDiff, holdUntil, isCollapsed, nav, requestHunks, S, setCurrent, visibleFiles } from './store.ts';

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
  /** First mounted file and its top as rendered: the height of the spacer above the window. */
  spacerPath: null as string | null,
  spacerTop: 0,
};

const rowCache = new Map<string, number>();

/**
 * Calibration. The metadata estimate (from +/- counts) cannot know the hunk count or
 * how many lines wrap, so it learns two ratios from files seen so far:
 * - rowF: real rows of loaded diffs / rows predicted from metadata;
 * - pxF:  measured body height / (rows * ROW) of mounted cards (wrapping, threads excluded).
 * A ratio is applied only when it moved by more than 2%, so heights do not churn every frame.
 */
const cal = { rowA: 0, rowM: 0, pxA: 0, pxM: 0, rowF: 1, pxF: 1 };
const rowSampled = new Set<string>();
let pxSampled = new WeakSet<DiffFileMeta>();

/** Rows predicted from metadata: changed lines, plus 3 context lines on each side of a hunk and a gap row. */
function metaRows(f: DiffFileMeta): number {
  const changed = S.view === 'split' ? Math.max(f.additions, f.deletions) : f.additions + f.deletions;
  const hunks = Math.max(1, (f.additions + f.deletions) / 5);
  const gapRows = hunks * (GAP_ROW / ROW);
  // A hunk never shows more lines than the file has.
  const cap = (S.view === 'split' ? Math.max(f.oldLineCount, f.newLineCount) : f.oldLineCount + f.additions) + gapRows;
  return Math.min(changed + hunks * 6 + gapRows, Math.max(changed, cap));
}

/** Prior weight (in rows / px) so the first few samples do not swing the ratios. */
const PRIOR_ROWS = 400;
const PRIOR_PX = 4000;

function recalibrate() {
  if (cal.rowM > 0) {
    const r = Math.max(0.3, Math.min(4, (cal.rowA + PRIOR_ROWS) / (cal.rowM + PRIOR_ROWS)));
    if (Math.abs(r / cal.rowF - 1) > 0.02) {
      cal.rowF = r;
      dirty = true;
    }
  }
  if (cal.pxM > 0) {
    const r = Math.max(0.8, Math.min(4, (cal.pxA + PRIOR_PX) / (cal.pxM + PRIOR_PX)));
    if (Math.abs(r / cal.pxF - 1) > 0.02) {
      cal.pxF = r;
      dirty = true;
    }
  }
}

function resetCalibration() {
  Object.assign(cal, { rowA: 0, rowM: 0, pxA: 0, pxM: 0, rowF: 1, pxF: 1 });
  rowSampled.clear();
  pxSampled = new WeakSet();
}

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
  const meta = S.fileByPath.get(path);
  if (meta && !rowSampled.has(key) && rows > 0) {
    rowSampled.add(key);
    cal.rowA += rows;
    cal.rowM += metaRows(meta);
    recalibrate();
  }
  return rows;
}

export function estimate(f: DiffFileMeta): number {
  if (isCollapsed(f)) return HEADER + GAP;
  if (f.binary || f.tooLarge) return HEADER + 46 + GAP;
  const threads = (S.threadsByPath.get(f.path)?.length ?? 0) * THREAD_EST;
  const rows = rowsFor(f.path);
  if (rows !== null) return Math.round(HEADER + rows * ROW * cal.pxF + threads + GAP);
  return Math.round(HEADER + metaRows(f) * cal.rowF * ROW * cal.pxF + threads + GAP);
}

/** Measured heights per metadata object (a new fingerprint is a new object), per collapsed state. */
let measured = new WeakMap<DiffFileMeta, [number | undefined, number | undefined]>();

export function heightOf(f: DiffFileMeta): number {
  const m = measured.get(f);
  const h = m?.[isCollapsed(f) ? 1 : 0];
  return h ?? estimate(f);
}

function setMeasured(f: DiffFileMeta, h: number, el: HTMLElement) {
  let m = measured.get(f);
  if (!m) measured.set(f, (m = [undefined, undefined]));
  m[isCollapsed(f) ? 1 : 0] = h;
  // Calibrate the row height from fully rendered cards without threads or drafts.
  if (isCollapsed(f) || pxSampled.has(f) || f.binary || f.tooLarge) return;
  const rows = rowsFor(f.path);
  if (!rows || rows < 5 || S.threadsByPath.has(f.path)) return;
  if (el.querySelector('.chunk.ph, .skel, .attach, .since-bar')) return;
  pxSampled.add(f);
  cal.pxA += h - HEADER - GAP;
  cal.pxM += rows * ROW;
  recalibrate();
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
let layoutFiles: DiffFileMeta[] | null = null;
export function layout() {
  const currentFiles = visibleFiles();
  if (layoutFiles !== currentFiles) dirty = true;
  layoutFiles = currentFiles;
  if (!dirty && V.tops.length === visibleFiles().length + 1) return;
  dirty = false;
  const files = visibleFiles();
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
  // Estimates of files above the window changed (calibration, collapse of an unmounted
  // file): the spacer changes height by the same amount. Move scrollTop with it now,
  // before the window is computed from the new tops, so the window stays where the reader is.
  const si = V.spacerPath === null ? undefined : V.index.get(V.spacerPath);
  if (si !== undefined) {
    const delta = V.tops[si]! - V.spacerTop;
    V.spacerTop = V.tops[si]!;
    const sc = S.scroller;
    if (Math.abs(delta) >= 0.5 && sc && performance.now() > holdUntil) {
      sc.scrollTop += delta;
      V.anchorTop += delta;
      if (reading) reading.y += delta;
    }
  }
}

function indexAt(y: number): number {
  const t = V.tops;
  const n = visibleFiles().length;
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
  const n = visibleFiles().length;
  const top = sc.scrollTop - PAD_TOP;
  const h = sc.clientHeight || 800;
  const first = n ? indexAt(Math.max(0, top - h)) : 0;
  const last = n ? indexAt(top + h * 2.2) : -1;
  V.anchorIdx = n ? indexAt(Math.max(0, top)) : 0;
  V.anchorPath = visibleFiles()[V.anchorIdx]?.path ?? null;
  V.anchorTop = V.tops[V.anchorIdx] ?? 0;
  const cur = n ? visibleFiles()[indexAt(Math.max(0, top + 8))] : undefined;
  setCurrent(cur?.path ?? null);
  V.spacerPath = visibleFiles()[first]?.path ?? null;
  V.spacerTop = V.tops[first] ?? 0;
  if (force || first !== V.first || last !== V.last) {
    V.first = first;
    V.last = last;
    emit('vwin');
  }
  // Prefetch hunks for the window (which already covers the next screenful).
  const want: string[] = [];
  for (let i = first; i <= last; i++) {
    const f = visibleFiles()[i]!;
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
  const kr = keepReading();
  if (!kr && Math.abs(delta) >= 0.5 && performance.now() > holdUntil) sc.scrollTop += delta;
  V.anchorTop = V.tops[i]!;
}

// ------------------------------------------------------------------ reading anchor

/**
 * The element at the reading position and where it was on screen. When anything above
 * it changes height (estimates replaced by measurements, chunks rendering wrapped lines,
 * a file above collapsing), scrollTop moves by the same amount before paint.
 */
let reading: { el: Element; y: number; path: string | null; k: string | null } | null = null;

const ANCHOR_SEL = '.r, .gap, .th-head, .msg, .composer, .draft-chip, .resolved-line, .ph-note, .since-bar, .chunk, .vitem';

/** Position of an element in the scroll content (independent of scrollTop). */
function contentY(el: Element, sc: HTMLElement): number {
  return el.getBoundingClientRect().top - sc.getBoundingClientRect().top + sc.scrollTop;
}

export function captureReading() {
  // Apply any shift that happened since the last correction first: a capture taken
  // after an uncorrected change would make that change permanent.
  keepReading();
  const sc = S.scroller;
  reading = null;
  if (!sc) return;
  const r = sc.getBoundingClientRect();
  const x = r.left + Math.min(240, r.width / 2);
  for (const y of [r.top + 60, r.top + 140, r.top + 260]) {
    const hit = document.elementFromPoint(x, y);
    if (!hit || !sc.contains(hit) || hit.closest('.fh')) continue;
    const el = hit.closest(ANCHOR_SEL);
    if (!el) continue;
    const k = el.closest<HTMLElement>('[data-k]');
    reading = {
      el,
      y: contentY(el, sc),
      path: el.closest<HTMLElement>('[data-vpath]')?.dataset.vpath ?? null,
      k: k?.dataset.k ?? null,
    };
    return;
  }
}

/**
 * Keeps the reading element at the same place on screen: when content above it changed
 * height, its position in the content moved, and scrollTop moves by the same amount.
 * Scrolling does not change that position, so this is safe while the reader scrolls.
 * Returns false when there is no usable DOM anchor (the caller falls back to the model).
 */
function keepReading(): boolean {
  const sc = S.scroller;
  const a = reading;
  if (!sc || !a) return false;
  if (!a.el.isConnected) {
    // Re-rendered (new highlight, new html): find the same line again.
    const card = a.path ? sc.querySelector(`[data-vpath="${CSS.escape(a.path)}"]`) : null;
    const again = card && a.k ? card.querySelector(`[data-k="${CSS.escape(a.k)}"]`) : null;
    if (!again) {
      reading = null;
      return false;
    }
    a.el = again;
  }
  const y = contentY(a.el, sc);
  if (performance.now() < holdUntil) {
    // A preserveScroll restore owns this change; follow it.
    a.y = y;
    return true;
  }
  const d = y - a.y;
  if (Math.abs(d) >= 0.5) sc.scrollTop += d;
  a.y = y;
  return true;
}

/** A programmatic jump: the old reading position no longer matters. */
export function dropReading() {
  reading = null;
}

nav.recapture = () => captureReading();

let settleQueued = false;
/**
 * Called after a component changed its height (a chunk rendered its rows, a card got its
 * hunks). Corrects scroll before paint; ResizeObserver alone may deliver the change a frame late.
 */
export function settleSoon() {
  if (settleQueued) return;
  settleQueued = true;
  queueMicrotask(() => {
    settleQueued = false;
    keepReading();
  });
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
      // 0 means the element is not rendered (an ancestor is hidden): not a real height.
      if (h <= 0) continue;
      if (Math.abs(h - old) < 0.5) continue;
      setMeasured(f, h, el);
      dirty = true;
      changed = true;
      const idx = V.index.get(path);
      if (idx !== undefined && idx < V.anchorIdx) adjust += h - old;
    }
    if (!changed || !sc) return;
    // Prefer the line on screen: it also covers growth inside the file being read.
    if (!keepReading() && adjust && performance.now() > holdUntil) sc.scrollTop += adjust;
    updateWindow();
    emit('vspace');
  });
  return ro;
}

export function resetHeights() {
  measured = new WeakMap();
  resetCalibration();
  dirty = true;
}

// ------------------------------------------------------------------ navigation

export function scrollToIndex(i: number) {
  const sc = S.scroller;
  if (!sc) return;
  layout();
  V.anchorIdx = i;
  reading = null;
  sc.scrollTop = V.tops[i]! + PAD_TOP;
  updateWindow(true);
  const f = visibleFiles()[i];
  if (f && !getDiff(f.path)) requestHunks([f.path], true);
}

nav.toFile = (path) => {
  layout();
  const i = V.index.get(path);
  if (i !== undefined) scrollToIndex(i);
};

nav.fileTop = (path) => {
  layout();
  const i = V.index.get(path);
  const sc = S.scroller;
  if (i === undefined || !sc) return null;
  return V.tops[i]! + PAD_TOP - sc.scrollTop;
};
