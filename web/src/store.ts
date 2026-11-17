import type {
  AgentPresence,
  Anchor,
  DiffFile,
  DiffFileMeta,
  Message,
  Review,
  ReviewBatch,
  ReviewScope,
  ServerEvent,
  Side,
  Thread,
} from '../../src/shared/types.ts';
import { api } from './api.ts';
import { emit } from './bus.ts';
import { cancelHighlight, highlightText } from './highlight.ts';
import { langForPath } from './langmap.ts';
import type { Expansion, GapRow } from './model.ts';

export type ViewMode = 'split' | 'unified';
export type Theme = 'system' | 'light' | 'dark';
export type ConnState = 'connecting' | 'open' | 'down';

export interface Content {
  fp: string;
  old: string[] | null;
  new: string[] | null;
  oldHl: string[] | null;
  newHl: string[] | null;
  loading: boolean;
  /** Bumps when text or highlight arrives, so rows know to re-render. */
  ver: number;
  hlDone: boolean;
  /** Text the current highlight was computed for, while a new highlight is pending. */
  staleOld?: string[] | null;
  staleNew?: string[] | null;
}

export interface ComposerState {
  key: string;
  kind: 'new' | 'reply' | 'edit';
  scope: ReviewScope;
  path: string;
  anchor?: Anchor;
  /** Text of the anchored end line when the draft was opened; lets the draft follow moved code. */
  lineText?: string;
  threadId?: number;
  messageId?: number;
  text: string;
  /** Edit composers: the message body when editing started. */
  original?: string;
  /** Closed with Esc: the draft is kept and shown as a chip until resumed or discarded. */
  hidden?: boolean;
}

export interface SinceState {
  state: 'loading' | 'ready' | 'none';
  file: DiffFile | null;
}

export interface Toast {
  id: number;
  text: string;
  kind: 'agent' | 'error' | 'info';
  threadId?: number;
  agent?: string;
  /** Opens this link on click (instead of jumping to a thread). */
  href?: string;
}

export interface Selection {
  path: string;
  side: Side;
  start: number;
  end: number;
  origin: number;
}

export const HUMAN = { kind: 'human' as const, name: 'you' };

function lsGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function lsSet(key: string, v: string | null) {
  try {
    if (v === null) localStorage.removeItem(key);
    else localStorage.setItem(key, v);
  } catch {
    /* storage unavailable */
  }
}

/** The tool was called Margin. Carry its settings and unsent drafts over to the new key names once. */
function migrateLegacyStorage() {
  try {
    for (const key of Object.keys(localStorage)) {
      if (!key.startsWith('margin:')) continue;
      const next = `rede:${key.slice('margin:'.length)}`;
      if (localStorage.getItem(next) === null) localStorage.setItem(next, localStorage.getItem(key)!);
      localStorage.removeItem(key);
    }
  } catch {
    /* storage unavailable */
  }
}
migrateLegacyStorage();

export const S = {
  reviewId: '',
  scope: 'all' as ReviewScope,
  review: null as Review | null,
  scopeCache: new Map<ReviewScope, Review>(),
  loadError: null as string | null,
  files: [] as DiffFileMeta[],
  fileByPath: new Map<string, DiffFileMeta>(),
  /** Loaded hunks by scope|path. Valid while the fingerprint matches the metadata. */
  hunks: new Map<string, DiffFile>(),
  threads: new Map<number, Thread>(),
  threadsByPath: new Map<string, Thread[]>(),
  agents: [] as AgentPresence[],
  conn: 'connecting' as ConnState,
  view: (lsGet('rede:view') === 'unified' ? 'unified' : 'split') as ViewMode,
  /** Soft-wrap long lines (default) or scroll them sideways. */
  wrap: lsGet('rede:wrap') !== '0',
  theme: ((lsGet('rede:theme') as Theme | null) ?? 'system') as Theme,
  /** Per scope: path -> explicit collapsed state. */
  collapsed: new Map<ReviewScope, Map<string, boolean>>(),
  since: new Map<string, SinceState>(),
  expansions: new Map<string, Map<string, Expansion>>(),
  contents: new Map<string, Content>(),
  composers: new Map<string, ComposerState>(),
  unread: new Set<number>(),
  flash: new Set<string>(),
  current: null as string | null,
  hover: null as { path: string; side: Side; line: number } | null,
  sel: null as Selection | null,
  panel: false,
  sheet: false,
  connect: false,
  toasts: [] as Toast[],
  openResolved: new Set<number>(),
  sidebarW: Number(lsGet('rede:sidebar:w')) || 280,
  sidebarHidden: lsGet('rede:sidebar:hidden') === '1',
  filter: '',
  scroller: null as HTMLElement | null,
  /** Pending messages in the review in progress (server side; survives reload). */
  pendingCount: 0,
  /** Submitted review batches by id. */
  batches: new Map<number, ReviewBatch>(),
  /** The Finish review popover is open. */
  finish: false,
  /** Threads of this review that live only in History (resolved and outdated). */
  archivedCount: 0,
};

/** Link to History, remembering the review to come back to. */
export function historyHref(): string {
  return S.reviewId ? `/history?from=${encodeURIComponent(S.reviewId)}` : '/history';
}

const fk = (path: string, scope: ReviewScope = S.scope) => `${scope}|${path}`;
export const fileTopic = (path: string) => `f:${path}`;

// ------------------------------------------------------------------ theme & view

export function applyTheme() {
  const el = document.documentElement;
  if (S.theme === 'system') delete el.dataset.theme;
  else el.dataset.theme = S.theme;
}

export function cycleTheme() {
  const dark = matchMedia('(prefers-color-scheme: dark)').matches;
  const effective = S.theme === 'system' ? (dark ? 'dark' : 'light') : S.theme;
  const next: Theme = effective === 'dark' ? 'light' : 'dark';
  // Returning to the OS value clears the override.
  S.theme = (next === 'dark') === dark ? 'system' : next;
  lsSet('rede:theme', S.theme === 'system' ? null : S.theme);
  applyTheme();
  emit('ui');
}

export function setView(v: ViewMode) {
  if (S.view === v) return;
  preserveScroll(() => {
    S.view = v;
    lsSet('rede:view', v);
    emit('view', 'ui');
  });
}

export function toggleWrap() {
  preserveScroll(() => {
    S.wrap = !S.wrap;
    lsSet('rede:wrap', S.wrap ? null : '0');
    emit('view', 'ui');
  });
}

export function setSidebar(w: number | null, hidden?: boolean) {
  if (w !== null) {
    S.sidebarW = Math.max(180, Math.min(600, Math.round(w)));
    lsSet('rede:sidebar:w', String(S.sidebarW));
  }
  if (hidden !== undefined) {
    S.sidebarHidden = hidden;
    lsSet('rede:sidebar:hidden', hidden ? '1' : null);
  }
  emit('layout');
}

// ------------------------------------------------------------------ scroll anchoring

interface ScrollAnchor {
  path: string | null;
  key: string | null;
  text: string | null;
  top: number;
  cardTop: number;
  /** scrollTop at capture. When the reader scrolls before the restore, the restore is skipped. */
  st: number;
}

function captureAnchor(): ScrollAnchor | null {
  const sc = S.scroller;
  if (!sc) return null;
  const r = sc.getBoundingClientRect();
  // A focused draft on screen is what the reader is looking at.
  const act = document.activeElement as HTMLElement | null;
  const cmp = act?.closest<HTMLElement>('[data-composer]');
  if (cmp && sc.contains(cmp)) {
    const cr = cmp.getBoundingClientRect();
    const card = cmp.closest<HTMLElement>('[data-path]');
    if (card && cr.bottom > r.top && cr.top < r.bottom)
      return { path: card.dataset.path!, key: `cmp:${cmp.dataset.composer}`, text: null, top: cr.top, cardTop: card.getBoundingClientRect().top, st: sc.scrollTop };
  }
  // Probe below the sticky file header.
  const ys = [r.top + 60, r.top + 140, r.top + 260];
  for (const y of ys) {
    const el = document.elementFromPoint(r.left + Math.min(240, r.width / 2), y) as HTMLElement | null;
    if (!el || !sc.contains(el)) continue;
    const card = el.closest<HTMLElement>('[data-path]');
    const keyed = el.closest<HTMLElement>('[data-k]');
    if (!card) continue;
    return {
      path: card.dataset.path!,
      key: keyed && card.contains(keyed) ? keyed.dataset.k! : null,
      text: keyed?.querySelector('.c')?.textContent ?? null,
      top: (keyed ?? card).getBoundingClientRect().top,
      cardTop: card.getBoundingClientRect().top,
      st: sc.scrollTop,
    };
  }
  return null;
}

function findCard(path: string): HTMLElement | null {
  return S.scroller?.querySelector<HTMLElement>(`[data-path="${CSS.escape(path)}"]`) ?? null;
}

function restoreAnchor(a: ScrollAnchor) {
  const sc = S.scroller;
  if (!sc || !a.path) return;
  if (Math.abs(sc.scrollTop - a.st) > 1) return; // the reader scrolled meanwhile
  try {
    restoreAnchorNow(a, sc);
  } finally {
    a.st = sc.scrollTop;
  }
}

function restoreAnchorNow(a: ScrollAnchor, sc: HTMLElement) {
  const card = findCard(a.path!);
  if (!card) return;
  if (a.key) {
    let el = card.querySelector<HTMLElement>(`[data-k="${CSS.escape(a.key)}"]`);
    const m = /^([no])(\d+)$/.exec(a.key);
    if (m && a.text !== null && el?.querySelector('.c')?.textContent !== a.text) {
      // Lines moved: find the same code nearby.
      const base = Number(m[2]);
      for (let d = 1; d <= 80; d++) {
        const hit = [base + d, base - d]
          .map((n) => card.querySelector<HTMLElement>(`[data-k="${m[1]}${n}"]`))
          .find((x) => x?.querySelector('.c')?.textContent === a.text);
        if (hit) {
          el = hit;
          break;
        }
      }
    }
    if (el) {
      sc.scrollTop += el.getBoundingClientRect().top - a.top;
      return;
    }
  }
  sc.scrollTop += card.getBoundingClientRect().top - a.cardTop;
}

let anchorDepth = 0;
/** While a DOM-anchored restore is pending, the virtual list must not also correct scroll. */
export let holdUntil = 0;
let heldAnchor: ScrollAnchor | null = null;

/** Runs a state change and keeps the line the reader looks at in the same place on screen. */
export function preserveScroll(fn: () => void) {
  if (anchorDepth === 0) heldAnchor = captureAnchor();
  anchorDepth++;
  try {
    fn();
  } finally {
    anchorDepth--;
  }
  if (anchorDepth === 0 && heldAnchor) {
    const a = heldAnchor;
    heldAnchor = null;
    // Preact renders in a microtask; rAF runs after it and before paint.
    holdUntil = performance.now() + 120;
    requestAnimationFrame(() => {
      restoreAnchor(a);
      // Lazily mounted chunks may settle one frame later.
      requestAnimationFrame(() => {
        restoreAnchor(a);
        nav.recapture();
      });
    });
  }
}

/**
 * Runs a change to one file (collapse, viewed) and keeps that file's header where it was.
 * When the reader was inside the file (its header stuck at the top), the header stays at the top.
 */
function keepCard(path: string, fn: () => void) {
  const sc = S.scroller;
  const card = findCard(path);
  if (!sc || !card) {
    preserveScroll(fn);
    return;
  }
  const target = Math.max(0, card.getBoundingClientRect().top - sc.getBoundingClientRect().top);
  holdUntil = performance.now() + 120;
  fn();
  const fix = () => {
    const c = findCard(path);
    if (c) sc.scrollTop += c.getBoundingClientRect().top - sc.getBoundingClientRect().top - target;
  };
  requestAnimationFrame(() => {
    fix();
    requestAnimationFrame(() => {
      fix();
      nav.recapture();
    });
  });
}

// ------------------------------------------------------------------ review load & reconcile

function indexThreads() {
  const by = new Map<string, Thread[]>();
  for (const t of S.threads.values()) {
    if (!t.inScope) continue;
    let arr = by.get(t.anchor.path);
    if (!arr) by.set(t.anchor.path, (arr = []));
    arr.push(t);
  }
  for (const arr of by.values()) arr.sort((a, b) => (a.anchor.endLine ?? 0) - (b.anchor.endLine ?? 0) || a.id - b.id);
  S.threadsByPath = by;
}

function colMap(): Map<string, boolean> {
  let m = S.collapsed.get(S.scope);
  if (!m) S.collapsed.set(S.scope, (m = new Map()));
  return m;
}

export function defaultCollapsed(f: DiffFileMeta): boolean {
  if (f.viewed) return true;
  if (f.status === 'deleted' && f.deletions > 400) return true;
  return false;
}

export function isCollapsed(f: DiffFileMeta): boolean {
  return colMap().get(f.path) ?? defaultCollapsed(f);
}

/** Orders paths like the file tree: directories before files at each level. */
export function treeCompare(a: string, b: string): number {
  const pa = a.split('/');
  const pb = b.split('/');
  const n = Math.min(pa.length, pb.length);
  for (let i = 0; i < n; i++) {
    if (pa[i] === pb[i]) continue;
    const aFile = i === pa.length - 1;
    const bFile = i === pb.length - 1;
    if (aFile !== bFile) return aFile ? 1 : -1;
    return pa[i]!.localeCompare(pb[i]!);
  }
  return pa.length - pb.length;
}

/** Text of one line from the diff hunks or the loaded content, if known. */
export function lineTextAt(meta: DiffFileMeta, side: Side, line: number): string | null {
  const f = getDiff(meta.path);
  if (f)
    for (const h of f.hunks)
    for (const l of h.lines) if ((side === 'old' ? l.oldLine : l.newLine) === line && (side === 'old' ? l.type !== 'add' : l.type !== 'del')) return l.text;
  const c = S.contents.get(fk(meta.path));
  const arr = c ? (side === 'old' ? c.old : c.new) : null;
  return arr?.[line - 1] ?? null;
}

/** After a live diff change, moves open comment drafts with the code they were written on. */
function shiftComposers(f: DiffFile) {
  for (const c of S.composers.values()) {
    const a = c.anchor;
    if (c.kind !== 'new' || c.path !== f.path || c.scope !== S.scope || !a || a.endLine === null || !c.lineText) continue;
    if (lineTextAt(f, a.side, a.endLine) === c.lineText) continue;
    let best: number | null = null;
    for (const h of f.hunks)
      for (const l of h.lines) {
        const ln = a.side === 'old' ? (l.type !== 'add' ? l.oldLine : undefined) : l.type !== 'del' ? l.newLine : undefined;
        if (ln === undefined || l.text !== c.lineText) continue;
        if (best === null || Math.abs(ln - a.endLine) < Math.abs(best - a.endLine)) best = ln;
      }
    if (best === null) continue;
    const d = best - a.endLine;
    c.anchor = { ...a, startLine: a.startLine! + d, endLine: best };
  }
}

/** Applies a review response. Keeps file objects whose fingerprint did not change. */
function applyReview(next: Review, opts: { initial: boolean; flash: boolean }) {
  const prevFiles = S.fileByPath;
  const changedTopics: string[] = [];
  const flashed: string[] = [];
  const files: DiffFileMeta[] = [];
  const byPath = new Map<string, DiffFileMeta>();
  const scope = next.scope ?? S.scope;
  for (const nf of next.files) {
    // Older servers send hunks inline; use them as a preloaded cache.
    if ('hunks' in nf && Array.isArray((nf as DiffFile).hunks)) {
      S.hunks.set(fk(nf.path, scope), nf as DiffFile);
    }
    const old = prevFiles.get(nf.path);
    if (!opts.initial && old && old.fingerprint === nf.fingerprint) {
      if (old.viewed !== nf.viewed || old.changedSinceViewed !== nf.changedSinceViewed) {
        old.viewed = nf.viewed;
        old.changedSinceViewed = nf.changedSinceViewed;
        changedTopics.push(fileTopic(nf.path));
      }
      files.push(old);
      byPath.set(old.path, old);
    } else {
      files.push(nf);
      byPath.set(nf.path, nf);
      changedTopics.push(fileTopic(nf.path));
      // A viewed file that changed is no longer viewed: show it again.
      if (old && old.viewed && nf.changedSinceViewed) colMap().delete(nf.path);
      if (old && opts.flash) flashed.push(nf.path);
      if (old && old.fingerprint !== nf.fingerprint) S.since.delete(fk(nf.path));
    }
  }
  files.sort((a, b) => treeCompare(a.path, b.path));
  const listChanged =
    opts.initial || files.length !== S.files.length || files.some((f, i) => S.files[i]?.path !== f.path);
  if (opts.flash) for (const f of files) if (!prevFiles.has(f.path) && prevFiles.size) flashed.push(f.path);

  S.review = next;
  S.scopeCache.set(next.scope ?? 'all', next);
  S.files = files;
  S.fileByPath = byPath;
  S.agents = next.agents;
  S.pendingCount = next.pendingCount ?? 0;
  S.batches = new Map((next.batches ?? []).map((b) => [b.id, b]));
  S.archivedCount = next.archivedCount ?? 0;

  // Threads.
  const seen = new Set<number>();
  for (const t of next.threads) {
    if (t.archived) continue;
    seen.add(t.id);
    upsertThread(t, { quiet: opts.initial, reindex: false });
  }
  for (const id of [...S.threads.keys()]) {
    if (!seen.has(id)) {
      const t = S.threads.get(id)!;
      S.threads.delete(id);
      changedTopics.push(fileTopic(t.anchor.path));
    }
  }
  indexThreads();

  for (const p of flashed) {
    S.flash.add(p);
    setTimeout(() => {
      S.flash.delete(p);
      emit(fileTopic(p), 'tree');
    }, 2400);
  }
  emit(...changedTopics, 'review', 'threads', 'agents', 'progress', 'tree', 'ui', 'vspace', 'pending', 'batches', 'archived');
  if (listChanged) emit('files');
}

let loadSeq = 0;
let refetchInFlight = false;
let refetchAgain = false;

export async function loadReview(opts: { initial?: boolean; flash?: boolean } = {}) {
  const seq = ++loadSeq;
  const scope = S.scope;
  try {
    const r = await api.review(S.reviewId, scope);
    if (seq !== loadSeq || scope !== S.scope) return;
    S.loadError = null;
    preserveScroll(() => applyReview(r, { initial: !!opts.initial, flash: !!opts.flash }));
  } catch (e) {
    if (seq !== loadSeq) return;
    if (!S.review) {
      S.loadError = (e as Error).message;
      emit('review', 'ui');
    }
  }
}

/** Coalesces refetches: at most one in flight plus one queued. */
export async function refetch(flash = true) {
  if (refetchInFlight) {
    refetchAgain = true;
    return;
  }
  refetchInFlight = true;
  try {
    await loadReview({ flash });
  } finally {
    refetchInFlight = false;
    if (refetchAgain) {
      refetchAgain = false;
      void refetch(flash);
    }
  }
}

// ------------------------------------------------------------------ scope

export function scopeFromUrl(): ReviewScope {
  const s = new URLSearchParams(location.search).get('scope');
  return s === 'staged' || s === 'unstaged' ? s : 'all';
}

export function setScope(scope: ReviewScope, opts: { push?: boolean; then?: () => void } = {}) {
  if (scope === S.scope) {
    opts.then?.();
    return;
  }
  const keepPath = S.current;
  S.scope = scope;
  if (opts.push !== false) {
    const u = new URL(location.href);
    if (scope === 'all') u.searchParams.delete('scope');
    else u.searchParams.set('scope', scope);
    history.pushState(null, '', u);
  }
  const cached = S.scopeCache.get(scope);
  S.fileByPath = new Map();
  S.files = [];
  if (cached) applyReview(cached, { initial: true, flash: false });
  else {
    S.review = S.review ? { ...S.review, files: [] } : null;
    emit('files', 'review', 'progress', 'tree', 'ui');
  }
  connectEvents();
  const after = () => {
    if (keepPath && S.fileByPath.has(keepPath)) scrollToFile(keepPath, { instant: true });
    else if (S.scroller) S.scroller.scrollTop = 0;
    opts.then?.();
  };
  requestAnimationFrame(after);
  void loadReview({ initial: !cached }).then(() => {
    if (!cached) requestAnimationFrame(after);
  });
}

export function cycleScope() {
  const scopes = S.review?.scopes ?? ['all'];
  if (scopes.length < 2) return;
  const i = scopes.indexOf(S.scope);
  setScope(scopes[(i + 1) % scopes.length]!);
}

// ------------------------------------------------------------------ events

let es: EventSource | null = null;
let retry = 0;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let everOpened = false;

export function connectEvents() {
  if (retryTimer) clearTimeout(retryTimer);
  retryTimer = null;
  es?.close();
  const src = new EventSource(api.eventsUrl(S.reviewId, S.scope));
  es = src;
  src.onopen = () => {
    if (es !== src) return;
    const wasDown = S.conn === 'down' || everOpened;
    everOpened = true;
    retry = 0;
    S.conn = 'open';
    emit('conn');
    // Anything may have changed while away.
    if (wasDown) void refetch(true);
  };
  src.onmessage = (e) => {
    if (es !== src) return;
    let ev: ServerEvent;
    try {
      ev = JSON.parse(e.data);
    } catch {
      return;
    }
    handleEvent(ev);
  };
  src.onerror = () => {
    if (es !== src) return;
    src.close();
    es = null;
    S.conn = 'down';
    emit('conn');
    const delay = Math.min(15000, 500 * 2 ** retry++);
    retryTimer = setTimeout(connectEvents, delay);
  };
}

function handleEvent(ev: ServerEvent) {
  switch (ev.type) {
    case 'thread':
      preserveScroll(() => upsertThread(ev.thread, { quiet: false, reindex: true }));
      break;
    case 'thread-deleted':
      preserveScroll(() => removeThread(ev.threadId));
      break;
    case 'viewed': {
      const f = S.fileByPath.get(ev.path);
      if (f && f.viewed !== ev.viewed) {
        preserveScroll(() => {
          f.viewed = ev.viewed;
          if (ev.viewed) f.changedSinceViewed = false;
          colMap().set(f.path, ev.viewed);
          emit(fileTopic(f.path), 'progress', 'tree', 'vspace');
        });
      }
      break;
    }
    case 'diff-changed':
      if (ev.diffFingerprint !== S.review?.diffFingerprint) void refetch(true);
      break;
    case 'agents':
      S.agents = ev.agents;
      emit('agents');
      break;
    case 'batch':
      S.batches.set(ev.batch.id, ev.batch);
      setPendingCount(ev.pendingCount);
      emit('batches', 'threads');
      break;
    case 'pending':
      setPendingCount(ev.pendingCount);
      break;
  }
}

// ------------------------------------------------------------------ review in progress

function setPendingCount(n: number) {
  if (S.pendingCount === n) return;
  S.pendingCount = n;
  emit('pending');
  if (n === 0 && S.finish) {
    S.finish = false;
    emit('ui');
  }
}

/** Recounts pending messages from the threads, after a local change. Events confirm it later. */
function recountPending() {
  let n = 0;
  for (const t of S.threads.values()) for (const m of t.messages) if (m.pending) n++;
  setPendingCount(n);
}

export const hasPending = (t: Thread) => t.messages.some((m) => m.pending);
export const pendingIn = (t: Thread) => t.messages.reduce((n, m) => n + (m.pending ? 1 : 0), 0);

/** The batch of the latest submitted human message; null for a one-off or none. */
export function latestBatchId(t: Thread): number | null {
  for (let i = t.messages.length - 1; i >= 0; i--) {
    const m = t.messages[i]!;
    if (m.pending || m.author.kind !== 'human') continue;
    return m.batchId;
  }
  return null;
}

/** Pending messages of the review in progress, in diff order. */
export function pendingList(): { t: Thread; m: Message }[] {
  const order = new Map(S.files.map((f, i) => [f.path, i]));
  const out: { t: Thread; m: Message }[] = [];
  for (const t of S.threads.values()) for (const m of t.messages) if (m.pending) out.push({ t, m });
  return out.sort(
    (a, b) =>
      (order.get(a.t.anchor.path) ?? 1e9) - (order.get(b.t.anchor.path) ?? 1e9) ||
      a.t.anchor.path.localeCompare(b.t.anchor.path) ||
      (a.t.anchor.endLine ?? 0) - (b.t.anchor.endLine ?? 0) ||
      a.m.id - b.m.id,
  );
}

export function setFinishOpen(open: boolean) {
  if (open && S.pendingCount === 0) return;
  if (S.finish === open) return;
  S.finish = open;
  if (open) S.connect = false;
  emit('ui');
}

const MODE_LABEL = { discuss: 'Discuss', implement: 'Implement' } as const;

export async function submitReview(mode: 'discuss' | 'implement', body: string): Promise<boolean> {
  const n = S.pendingCount;
  const b = await guard(api.submitReview(S.reviewId, { mode, body }), 'Submit review');
  if (!b) return false;
  S.batches.set(b.id, b);
  setReviewNote('');
  setFinishOpen(false);
  setPendingCount(0);
  emit('batches', 'threads');
  const none = S.agents.length === 0 ? ' Waiting for an agent · tell your agent: “Address the Rede feedback.”' : '';
  pushToast({ kind: 'info', text: `Review sent (${MODE_LABEL[mode]}, ${n} comment${n === 1 ? '' : 's'}).${none}` });
  return true;
}

export async function discardReview(): Promise<void> {
  const ok = await guard(api.discardPending(S.reviewId), 'Discard review');
  if (!ok) return;
  setReviewNote('');
  setFinishOpen(false);
  // The server sends the deletions as events too; apply them now.
  preserveScroll(() => {
    for (const t of [...S.threads.values()]) {
      if (!hasPending(t)) continue;
      const rest = t.messages.filter((m) => !m.pending);
      if (!rest.length) removeThread(t.id);
      else upsertThread({ ...t, messages: rest }, { quiet: true, reindex: true });
    }
  });
  setPendingCount(0);
  pushToast({ kind: 'info', text: 'Review discarded.' });
}

/** The overall note of the review in progress: a local draft until the review is submitted. */
export function reviewNote(): string {
  return lsGet(`rede:reviewnote:${S.reviewId}`) ?? '';
}
export function setReviewNote(v: string) {
  lsSet(`rede:reviewnote:${S.reviewId}`, v.trim() ? v : null);
}

/** The "Comment vs Review" hint under composers shows for the first few sends. */
export function sendHintVisible(): boolean {
  return Number(lsGet('rede:sendhint') ?? 0) < 5;
}
function countSend() {
  lsSet('rede:sendhint', String(Number(lsGet('rede:sendhint') ?? 0) + 1));
}

// ------------------------------------------------------------------ threads

function threadVisible(id: number): boolean {
  const el = S.scroller?.querySelector(`[data-thread="${id}"]`);
  if (!el || !S.scroller) return false;
  const r = el.getBoundingClientRect();
  const s = S.scroller.getBoundingClientRect();
  return r.bottom > s.top + 40 && r.top < s.bottom - 20;
}

export function threadLabel(t: Thread): string {
  const a = t.anchor;
  if (a.startLine === null) return a.path;
  return a.startLine === a.endLine ? `${a.path}:${a.endLine}` : `${a.path}:${a.startLine}-${a.endLine}`;
}

export function upsertThread(t: Thread, opts: { quiet: boolean; reindex: boolean }) {
  const prev = S.threads.get(t.id);
  // The live-view rule (server side): resolved + outdated threads leave the diff and live in History.
  if (t.archived) {
    if (!prev) return;
    removeThread(t.id);
    S.archivedCount++;
    emit('archived');
    pushToast({ kind: 'info', text: `Thread #${t.id} moved to History: resolved, code changed.`, href: historyHref() });
    return;
  }
  // An older thread came back from History (reopened, or its code returned): refresh the count.
  if (!prev && S.archivedCount > 0 && Date.now() - Date.parse(t.createdAt) > 30_000) void refetch(false);
  if (prev && JSON.stringify(prev) === JSON.stringify(t)) return;
  S.threads.set(t.id, t);
  const last = t.messages[t.messages.length - 1];
  if (!opts.quiet && last && last.author.kind === 'agent' && !(prev && prev.messages.some((m) => m.id === last.id))) {
    S.unread.add(t.id);
    saveUnread();
    if (!threadVisible(t.id)) {
      const verb = t.messages.length === 1 ? 'commented' : 'replied';
      pushToast({ kind: 'agent', text: `${last.author.name} ${verb} on ${threadLabel(t)}`, threadId: t.id, agent: last.author.name });
    }
  }
  if (prev && prev.anchor.path !== t.anchor.path) emit(fileTopic(prev.anchor.path));
  emit(fileTopic(t.anchor.path), `t:${t.id}`, 'threads', 'tree');
  if (opts.reindex) {
    indexThreads();
    recountPending();
  }
}

function removeThread(id: number) {
  const t = S.threads.get(id);
  if (!t) return;
  S.threads.delete(id);
  S.unread.delete(id);
  indexThreads();
  recountPending();
  emit(fileTopic(t.anchor.path), 'threads', 'tree');
}

function saveUnread() {
  lsSet(`rede:unread:${S.reviewId}`, JSON.stringify([...S.unread]));
}

export function markRead(id: number) {
  if (!S.unread.delete(id)) return;
  saveUnread();
  const t = S.threads.get(id);
  emit(`t:${id}`, 'threads', 'tree');
  if (t) emit(fileTopic(t.anchor.path));
  S.toasts = S.toasts.filter((x) => x.threadId !== id);
  emit('toasts');
}

async function guard<T>(p: Promise<T>, what: string): Promise<T | null> {
  try {
    return await p;
  } catch (e) {
    pushToast({ kind: 'error', text: `${what} failed: ${(e as Error).message}` });
    return null;
  }
}

/**
 * - comment: a one-off, sent to the agent now.
 * - review: queued as pending in the review in progress.
 * - note: a private note, never sent.
 */
export type SendKind = 'comment' | 'review' | 'note';

export async function createThread(c: ComposerState, kind: SendKind): Promise<boolean> {
  if (!c.anchor) return false;
  const t = await guard(
    api.createThread(S.reviewId, c.scope, { anchor: c.anchor, body: c.text, author: HUMAN, noteOnly: kind === 'note', pending: kind === 'review' }),
    kind === 'review' ? 'Add to review' : 'Comment',
  );
  if (!t) return false;
  if (kind !== 'note') countSend();
  preserveScroll(() => upsertThread(t, { quiet: true, reindex: true }));
  return true;
}

export async function reply(tid: number, body: string, opts: { resolve?: boolean; pending?: boolean } = {}): Promise<boolean> {
  const t = await guard(
    api.addMessage(tid, S.scope, { body, author: HUMAN, resolve: !!opts.resolve, pending: !!opts.pending }),
    opts.pending ? 'Add to review' : 'Reply',
  );
  if (!t) return false;
  countSend();
  markRead(tid);
  preserveScroll(() => upsertThread(t, { quiet: true, reindex: true }));
  return true;
}

export async function setResolved(tid: number, resolved: boolean) {
  const t = await guard(api.updateThread(tid, S.scope, { resolved }), resolved ? 'Resolve' : 'Unresolve');
  if (!t) return;
  markRead(tid);
  S.openResolved.delete(tid);
  preserveScroll(() => upsertThread(t, { quiet: true, reindex: true }));
}

export async function editMessage(mid: number, body: string): Promise<boolean> {
  const t = await guard(api.editMessage(mid, S.scope, body), 'Edit');
  if (!t) return false;
  preserveScroll(() => upsertThread(t, { quiet: true, reindex: true }));
  return true;
}

export async function deleteMessage(tid: number, mid: number) {
  const res = await guard(api.deleteMessage(mid, S.scope), 'Delete');
  if (!res) return;
  preserveScroll(() => {
    if ('threadDeleted' in res) removeThread(tid);
    else upsertThread(res as Thread, { quiet: true, reindex: true });
  });
}

export function toggleResolvedOpen(tid: number) {
  const t = S.threads.get(tid);
  preserveScroll(() => {
    if (S.openResolved.has(tid)) S.openResolved.delete(tid);
    else S.openResolved.add(tid);
    emit(`t:${tid}`);
    if (t) emit(fileTopic(t.anchor.path));
  });
}

// ------------------------------------------------------------------ toasts

let toastSeq = 0;
export function pushToast(t: Omit<Toast, 'id'>) {
  const toast = { ...t, id: ++toastSeq };
  S.toasts = [...S.toasts.slice(-3), toast];
  emit('toasts');
  setTimeout(() => dismissToast(toast.id), t.kind === 'error' ? 8000 : 12000);
}
export function dismissToast(id: number) {
  const before = S.toasts.length;
  S.toasts = S.toasts.filter((x) => x.id !== id);
  if (S.toasts.length !== before) emit('toasts');
}

// ------------------------------------------------------------------ composers & drafts

let draftTimer: ReturnType<typeof setTimeout> | null = null;
function saveDrafts() {
  if (draftTimer) clearTimeout(draftTimer);
  draftTimer = setTimeout(() => {
    lsSet(`rede:composers:${S.reviewId}`, JSON.stringify([...S.composers.values()]));
  }, 250);
}

/**
 * Another tab on the same review saved its drafts. Merge them, so this tab's next save
 * does not drop drafts it never saw, and drop drafts the other tab posted or discarded.
 */
function onDraftsStorage(e: StorageEvent) {
  if (e.key !== `rede:composers:${S.reviewId}`) return;
  const parse = (v: string | null): ComposerState[] => {
    try {
      return v ? (JSON.parse(v) as ComposerState[]).filter((c) => c && c.key) : [];
    } catch {
      return [];
    }
  };
  const next = new Map(parse(e.newValue).map((c) => [c.key, c]));
  const before = new Map(parse(e.oldValue).map((c) => [c.key, c]));
  const focused = (document.activeElement as HTMLElement | null)?.closest<HTMLElement>('[data-composer]')?.dataset.composer;
  let changed = false;
  for (const [k, c] of next) {
    const mine = S.composers.get(k);
    if (!mine) {
      S.composers.set(k, { ...c, hidden: true });
      changed = true;
    } else if (k !== focused && mine.text !== c.text && before.get(k)?.text === mine.text) {
      mine.text = c.text;
      changed = true;
    }
  }
  for (const [k, old] of before) {
    const mine = S.composers.get(k);
    if (!next.has(k) && mine && k !== focused && mine.text === old.text) {
      S.composers.delete(k);
      changed = true;
    }
  }
  if (changed) preserveScroll(() => emit('composers', ...[...S.fileByPath.keys()].map(fileTopic)));
}

export function restoreDrafts() {
  window.addEventListener('storage', onDraftsStorage);
  const raw = lsGet(`rede:composers:${S.reviewId}`);
  if (!raw) return;
  try {
    for (const c of JSON.parse(raw) as ComposerState[]) if (c && c.key) S.composers.set(c.key, c);
  } catch {
    /* ignore */
  }
  const u = lsGet(`rede:unread:${S.reviewId}`);
  if (u) {
    try {
      for (const id of JSON.parse(u) as number[]) S.unread.add(id);
    } catch {
      /* ignore */
    }
  }
}

export function composerKeyFor(a: Anchor, scope: ReviewScope = S.scope) {
  return a.startLine === null ? `new:${scope}:${a.path}:file` : `new:${scope}:${a.path}:${a.side}:${a.startLine}:${a.endLine}`;
}

/** The composer to focus as soon as it mounts (keys typed right after the click must land in it). */
export let focusComposer: string | null = null;
export function takeFocusComposer(key: string): boolean {
  if (focusComposer !== key) return false;
  focusComposer = null;
  return true;
}

export function openComposer(c: Omit<ComposerState, 'text'> & { text?: string }) {
  const existing = S.composers.get(c.key);
  focusComposer = c.key;
  preserveScroll(() => {
    if (!existing) S.composers.set(c.key, { ...c, text: c.text ?? '' });
    else existing.hidden = false;
    emit(fileTopic(c.path), 'composers', `t:${c.threadId ?? -1}`);
  });
  saveDrafts();
  // Focus after render.
  requestAnimationFrame(() =>
    requestAnimationFrame(() => {
      const el = document.querySelector<HTMLTextAreaElement>(`[data-composer="${CSS.escape(c.key)}"] textarea`);
      if (el) {
        if (focusComposer === c.key || document.activeElement !== el) {
          focusComposer = null;
          if (document.activeElement !== el) el.focus();
        }
        const r = el.getBoundingClientRect();
        const s = S.scroller?.getBoundingClientRect();
        if (s && (r.bottom > s.bottom || r.top < s.top)) el.scrollIntoView({ block: 'center' });
      }
    }),
  );
}

export function updateComposer(key: string, text: string) {
  const c = S.composers.get(key);
  if (!c) return;
  c.text = text;
  saveDrafts();
}

/** Esc: closes the composer and keeps a non-empty draft. */
export function stashComposer(key: string, text?: string) {
  const c = S.composers.get(key);
  if (!c) return;
  if (text !== undefined) c.text = text;
  if (!c.text.trim() || (c.kind === 'edit' && c.text === c.original)) {
    closeComposer(key);
    return;
  }
  preserveScroll(() => {
    c.hidden = true;
    emit(fileTopic(c.path), 'composers', `t:${c.threadId ?? -1}`);
  });
  saveDrafts();
}

/** Removes the draft (after submit, or an explicit Discard). */
export function closeComposer(key: string) {
  const c = S.composers.get(key);
  if (!c) return;
  preserveScroll(() => {
    S.composers.delete(key);
    emit(fileTopic(c.path), 'composers', `t:${c.threadId ?? -1}`);
  });
  saveDrafts();
}

export function commentOn(path: string, side: Side, start: number, end: number) {
  const anchor: Anchor = { path, side, startLine: Math.min(start, end), endLine: Math.max(start, end) };
  const key = composerKeyFor(anchor);
  const f = S.fileByPath.get(path)!;
  if (isCollapsed(f)) setCollapsed(path, false);
  const lineText = lineTextAt(f, side, anchor.endLine!) ?? undefined;
  openComposer({ key, kind: 'new', scope: S.scope, path, anchor, lineText });
}

export function commentOnFile(path: string) {
  const anchor: Anchor = { path, side: 'new', startLine: null, endLine: null };
  const f = S.fileByPath.get(path);
  if (f && f.status === 'deleted') anchor.side = 'old';
  if (f && isCollapsed(f)) setCollapsed(path, false);
  openComposer({ key: composerKeyFor(anchor), kind: 'new', scope: S.scope, path, anchor });
}

// ------------------------------------------------------------------ selection

export function setSelection(sel: Selection | null) {
  const prev = S.sel;
  S.sel = sel;
  if (prev) emit(fileTopic(prev.path));
  if (sel && sel.path !== prev?.path) emit(fileTopic(sel.path));
}

// ------------------------------------------------------------------ files

export function setCollapsed(path: string, collapsed: boolean) {
  keepCard(path, () => {
    colMap().set(path, collapsed);
    emit(fileTopic(path), 'tree', 'vspace');
  });
}

export async function setViewed(path: string, viewed: boolean) {
  const f = S.fileByPath.get(path);
  if (!f) return;
  const prev = { viewed: f.viewed, changed: f.changedSinceViewed, collapsed: colMap().get(path) };
  keepCard(path, () => {
    f.viewed = viewed;
    if (viewed) f.changedSinceViewed = false;
    colMap().set(path, viewed);
    if (viewed) S.since.delete(fk(path));
    emit(fileTopic(path), 'progress', 'tree', 'vspace');
  });
  const scope = S.scope;
  const ok = await guard(api.setViewed(S.reviewId, scope, path, viewed), 'Mark viewed');
  if (!ok && scope === S.scope) {
    f.viewed = prev.viewed;
    f.changedSinceViewed = prev.changed;
    if (prev.collapsed === undefined) colMap().delete(path);
    else colMap().set(path, prev.collapsed);
    emit(fileTopic(path), 'progress', 'tree', 'vspace');
  }
}

export function getSince(path: string): SinceState | undefined {
  return S.since.get(fk(path));
}

export async function showSince(path: string, on: boolean) {
  const key = fk(path);
  if (!on) {
    preserveScroll(() => {
      S.since.delete(key);
      emit(fileTopic(path));
    });
    return;
  }
  S.since.set(key, { state: 'loading', file: null });
  emit(fileTopic(path));
  const res = await guard(api.sinceViewed(S.reviewId, S.scope, path), 'Load changes since viewed');
  if (S.since.get(key)?.state !== 'loading') return;
  preserveScroll(() => {
    if (!res || !res.file) {
      S.since.set(key, { state: 'none', file: null });
      if (res) pushToast({ kind: 'info', text: 'No snapshot of the viewed version. Showing the full diff.' });
      S.since.delete(key);
    } else {
      S.since.set(key, { state: 'ready', file: res.file });
    }
    emit(fileTopic(path));
  });
}

export function getExpansion(path: string) {
  return S.expansions.get(fk(path));
}

export async function expandGap(path: string, gap: GapRow, dir: 'up' | 'down' | 'all', step = 20) {
  const f = S.fileByPath.get(path);
  if (!f) return;
  const c = getContent(f);
  if (!c || (!c.new && !c.old)) {
    await ensureContent(path);
  }
  preserveScroll(() => {
    let m = S.expansions.get(fk(path));
    if (!m) S.expansions.set(fk(path), (m = new Map()));
    const e = m.get(gap.base) ?? { ranges: [] };
    if (dir === 'all') e.ranges.push([gap.ks, gap.ke]);
    else if (dir === 'down') e.ranges.push([gap.ks, Math.min(gap.ke, gap.ks + step)]);
    else e.ranges.push([Math.max(gap.ks, gap.ke - step), gap.ke]);
    m.set(gap.base, e);
    emit(fileTopic(path));
  });
}

// ------------------------------------------------------------------ content & highlighting

export function getContent(f: DiffFileMeta): Content | undefined {
  // May be from an older fingerprint; row rendering checks each line's text before using it.
  return S.contents.get(fk(f.path));
}

function splitLines(text: string): string[] {
  const lines = text.split('\n');
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!;
    if (l.endsWith('\r')) lines[i] = l.slice(0, -1);
  }
  return lines;
}

const MAX_HL = 1_000_000;
let active = 0;
const waiting: (() => void)[] = [];
async function slot<T>(fn: () => Promise<T>): Promise<T> {
  if (active >= 4) await new Promise<void>((r) => waiting.push(r));
  active++;
  try {
    return await fn();
  } finally {
    active--;
    waiting.shift()?.();
  }
}

/** Minified or generated text: highlighting costs much and helps little. */
function skipHighlight(lines: string[], size: number): boolean {
  if (size > MAX_HL) return true;
  if (!lines.length) return true;
  if (size / lines.length > 300) return true;
  for (const l of lines) if (l.length > 4000) return true;
  return false;
}

interface Fetching {
  fp: string;
  jobs: number[];
}
const fetching = new Map<string, Fetching>();

/** Loads both sides' text and highlights them in the worker. Safe to call often. */
export async function ensureContent(path: string): Promise<void> {
  const f = S.fileByPath.get(path);
  if (!f || f.binary || f.tooLarge) return;
  const key = fk(path);
  const have = S.contents.get(key);
  const busy = fetching.get(key);
  if (busy && busy.fp === f.fingerprint) return;
  if (have && have.fp === f.fingerprint) {
    if (have.hlDone) return;
    void highlightContent(path, have);
    return;
  }
  const mark: Fetching = { fp: f.fingerprint, jobs: [] };
  fetching.set(key, mark);
  const scope = S.scope;
  const fetchSide = (side: Side) => slot(() => api.file(S.reviewId, scope, path, side)).catch(() => null);
  const [o, n] = await Promise.all([
    f.status !== 'added' ? fetchSide('old') : Promise.resolve(null),
    f.status !== 'deleted' ? fetchSide('new') : Promise.resolve(null),
  ]);
  if (fetching.get(key) !== mark) return;
  fetching.delete(key);
  const c: Content = {
    fp: f.fingerprint,
    old: o && o.exists && !o.binary ? splitLines(o.text) : null,
    new: n && n.exists && !n.binary ? splitLines(n.text) : null,
    oldHl: null,
    newHl: null,
    loading: false,
    ver: (have?.ver ?? 0) + 1,
    hlDone: false,
  };
  // Keep the old highlight for lines that did not change, until the new one arrives.
  if (have) {
    c.oldHl = have.oldHl;
    c.newHl = have.newHl;
    c.staleOld = have.old;
    c.staleNew = have.new;
  }
  S.contents.set(key, c);
  emit(fileTopic(path));
  void highlightContent(path, c);
}

const hlJobs = new Map<string, number[]>();

async function highlightContent(path: string, c: Content) {
  const key = fk(path);
  if (hlJobs.has(key)) return;
  const lang = langForPath(path);
  if (!lang) {
    c.hlDone = true;
    return;
  }
  const ids: number[] = [];
  hlJobs.set(key, ids);
  let wasCancelled = false;
  const run = async (lines: string[] | null): Promise<string[] | null> => {
    if (!lines) return null;
    const text = lines.join('\n');
    if (skipHighlight(lines, text.length)) return null;
    const job = highlightText(text, lang);
    ids.push(job.id);
    const h = await job.done;
    if (h === 'cancelled') {
      wasCancelled = true;
      return null;
    }
    return h && h.length >= lines.length ? h : null;
  };
  const [oh, nh] = await Promise.all([run(c.old), run(c.new)]);
  // Cancelled: the file left the viewport. It retries when it comes back.
  if (wasCancelled || S.contents.get(key) !== c) return;
  if (hlJobs.get(key) === ids) hlJobs.delete(key);
  c.oldHl = oh;
  c.newHl = nh;
  c.staleOld = null;
  c.staleNew = null;
  c.hlDone = true;
  c.ver++;
  emit(fileTopic(path));
}

/** The file left the viewport: drop its queued highlight work. */
export function releaseContent(path: string) {
  const key = fk(path);
  const ids = hlJobs.get(key);
  if (!ids) return;
  hlJobs.delete(key);
  for (const id of ids) cancelHighlight(id);
}

// ------------------------------------------------------------------ hunks

/** Hunks for the current scope, if loaded and still current. */
export function getDiff(path: string): DiffFile | undefined {
  const meta = S.fileByPath.get(path);
  const d = S.hunks.get(fk(path));
  if (!meta || !d) return undefined;
  return d.fingerprint === meta.fingerprint ? d : undefined;
}

/** The last loaded hunks even when stale; shown while fresh ones load. */
export function getStaleDiff(path: string): DiffFile | undefined {
  return S.hunks.get(fk(path));
}

export function needsHunks(f: DiffFileMeta): boolean {
  if (f.binary || f.tooLarge) return false;
  return !getDiff(f.path);
}

const wanted = new Set<string>();
const inflight = new Map<string, string>(); // fk -> fingerprint requested
let hunkTimer: ReturnType<typeof setTimeout> | null = null;

/** Queues hunk loads. Requests are batched (<= 200 paths) and sent together. */
export function requestHunks(paths: string[], urgent = false) {
  for (const p of paths) {
    const f = S.fileByPath.get(p);
    if (!f || !needsHunks(f)) continue;
    if (inflight.get(fk(p)) === f.fingerprint) continue;
    wanted.add(p);
  }
  if (!wanted.size) return;
  if (hunkTimer) clearTimeout(hunkTimer);
  hunkTimer = setTimeout(flushHunks, urgent ? 0 : 60);
}

function flushHunks() {
  hunkTimer = null;
  const scope = S.scope;
  const paths = [...wanted];
  wanted.clear();
  for (let i = 0; i < paths.length; i += 200) {
    const batch = paths.slice(i, i + 200);
    for (const p of batch) inflight.set(fk(p, scope), S.fileByPath.get(p)?.fingerprint ?? '');
    api
      .hunks(S.reviewId, scope, batch)
      .then((list) => receiveHunks(list, scope, batch))
      .catch((e: Error) => {
        for (const p of batch) inflight.delete(fk(p, scope));
        pushToast({ kind: 'error', text: `Loading diff failed: ${e.message}` });
      });
  }
}

function receiveHunks(list: DiffFile[], scope: ReviewScope, asked: string[]) {
  for (const p of asked) inflight.delete(fk(p, scope));
  if (scope !== S.scope) {
    for (const d of list) S.hunks.set(fk(d.path, scope), d);
    return;
  }
  // No preserveScroll here: hunks arrive while the reader scrolls. The virtual list keeps
  // the line at the reading position in place when the cards grow.
  const topics: string[] = [];
  for (const d of list) {
    const key = fk(d.path, scope);
    const prev = S.hunks.get(key);
    S.hunks.set(key, d);
    if (prev && prev.fingerprint !== d.fingerprint) shiftComposers(d);
    topics.push(fileTopic(d.path));
  }
  emit(...topics);
}

// ------------------------------------------------------------------ navigation

export function setCurrent(path: string | null) {
  if (S.current === path) return;
  S.current = path;
  emit('current');
}

/** Navigation hooks, installed by the virtual list. */
export const nav = {
  toFile: (_path: string, _opts?: { instant?: boolean }) => {},
  /** Scroll position of a file's top relative to the scroller, from the layout model. */
  fileTop: (_path: string): number | null => null,
  /** Re-reads the reading position after a programmatic scroll adjustment. */
  recapture: () => {},
};

export function scrollToFile(path: string, opts: { instant?: boolean } = {}) {
  nav.toFile(path, opts);
  setCurrent(path);
}

export function flashElement(el: Element) {
  el.classList.remove('pulse');
  void (el as HTMLElement).offsetWidth;
  el.classList.add('pulse');
}

export function jumpToThread(id: number) {
  const t = S.threads.get(id);
  if (!t) return;
  const go = () => {
    const t2 = S.threads.get(id);
    if (!t2) return;
    const f = S.fileByPath.get(t2.anchor.path);
    if (f && isCollapsed(f)) {
      colMap().set(f.path, false);
      emit(fileTopic(f.path), 'tree');
    }
    if (t2.resolved && !S.openResolved.has(id)) {
      S.openResolved.add(id);
      emit(`t:${id}`, fileTopic(t2.anchor.path));
    }
    const tryScroll = (n: number) => {
      const el = S.scroller?.querySelector<HTMLElement>(`[data-thread="${id}"]`);
      if (el && S.scroller) {
        const s = S.scroller.getBoundingClientRect();
        const r = el.getBoundingClientRect();
        S.scroller.scrollTop += r.top - s.top - Math.max(80, s.height * 0.25);
        flashElement(el);
        markRead(id);
      } else if (n > 0) requestAnimationFrame(() => tryScroll(n - 1));
    };
    // The file may be far away and not loaded: go there first, then find the thread.
    if (f && !S.scroller?.querySelector(`[data-thread="${id}"]`)) scrollToFile(f.path, { instant: true });
    requestAnimationFrame(() => tryScroll(120));
  };
  if (!t.inScope && t.homeScope !== S.scope) {
    setScope(t.homeScope, { then: () => setTimeout(go, 50) });
  } else go();
}

/** Ordered list of open threads in diff order, used by n/p. */
export function orderedOpenThreads(): Thread[] {
  const out: Thread[] = [];
  for (const f of S.files) {
    const arr = S.threadsByPath.get(f.path);
    if (arr) for (const t of arr) if (!t.resolved) out.push(t);
  }
  return out;
}

export function init(reviewId: string) {
  S.reviewId = reviewId;
  S.scope = scopeFromUrl();
  applyTheme();
  restoreDrafts();
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => emit('ui'));
  window.addEventListener('popstate', () => setScope(scopeFromUrl(), { push: false }));
  void loadReview({ initial: true }).then(jumpFromHash);
  connectEvents();
}

/** `#thread-12` (History's "Open in diff"): scroll to that thread once the review is loaded. */
function jumpFromHash() {
  const m = /^#thread-(\d+)$/.exec(location.hash);
  if (!m) return;
  history.replaceState(null, '', location.pathname + location.search);
  const id = Number(m[1]);
  if (S.threads.has(id)) requestAnimationFrame(() => jumpToThread(id));
  else pushToast({ kind: 'info', text: `Thread #${id} is not in this diff any more. It stays in History.`, href: historyHref() });
}

export function fileKey(path: string) {
  return fk(path);
}
