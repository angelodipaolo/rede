import type {
  AgentPresence,
  Anchor,
  DiffFile,
  Review,
  ReviewScope,
  ServerEvent,
  Side,
  Thread,
} from '../../src/shared/types.ts';
import { api } from './api.ts';
import { emit } from './bus.ts';
import { highlightText } from './highlight.ts';
import { langForPath } from './langmap.ts';
import type { Expansion } from './model.ts';

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
}

export interface ComposerState {
  key: string;
  kind: 'new' | 'reply' | 'edit';
  scope: ReviewScope;
  path: string;
  anchor?: Anchor;
  threadId?: number;
  messageId?: number;
  text: string;
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

export const S = {
  reviewId: '',
  scope: 'all' as ReviewScope,
  review: null as Review | null,
  scopeCache: new Map<ReviewScope, Review>(),
  loadError: null as string | null,
  files: [] as DiffFile[],
  fileByPath: new Map<string, DiffFile>(),
  threads: new Map<number, Thread>(),
  threadsByPath: new Map<string, Thread[]>(),
  agents: [] as AgentPresence[],
  conn: 'connecting' as ConnState,
  view: (lsGet('margin:view') === 'unified' ? 'unified' : 'split') as ViewMode,
  theme: ((lsGet('margin:theme') as Theme | null) ?? 'system') as Theme,
  collapsed: new Map<string, boolean>(),
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
  sidebarW: Number(lsGet('margin:sidebar:w')) || 280,
  sidebarHidden: lsGet('margin:sidebar:hidden') === '1',
  filter: '',
  scroller: null as HTMLElement | null,
};

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
  lsSet('margin:theme', S.theme === 'system' ? null : S.theme);
  applyTheme();
  emit('ui');
}

export function setView(v: ViewMode) {
  if (S.view === v) return;
  preserveScroll(() => {
    S.view = v;
    lsSet('margin:view', v);
    emit('view', 'ui');
  });
}

export function setSidebar(w: number | null, hidden?: boolean) {
  if (w !== null) {
    S.sidebarW = Math.max(180, Math.min(600, Math.round(w)));
    lsSet('margin:sidebar:w', String(S.sidebarW));
  }
  if (hidden !== undefined) {
    S.sidebarHidden = hidden;
    lsSet('margin:sidebar:hidden', hidden ? '1' : null);
  }
  emit('layout');
}

// ------------------------------------------------------------------ scroll anchoring

interface ScrollAnchor {
  path: string | null;
  key: string | null;
  top: number;
  cardTop: number;
}

function captureAnchor(): ScrollAnchor | null {
  const sc = S.scroller;
  if (!sc) return null;
  const r = sc.getBoundingClientRect();
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
      top: (keyed ?? card).getBoundingClientRect().top,
      cardTop: card.getBoundingClientRect().top,
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
  const card = findCard(a.path);
  if (!card) return;
  if (a.key) {
    const el = card.querySelector<HTMLElement>(`[data-k="${CSS.escape(a.key)}"]`);
    if (el) {
      sc.scrollTop += el.getBoundingClientRect().top - a.top;
      return;
    }
  }
  sc.scrollTop += card.getBoundingClientRect().top - a.cardTop;
}

let anchorDepth = 0;
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
    requestAnimationFrame(() => {
      restoreAnchor(a);
      // Lazily mounted chunks may settle one frame later.
      requestAnimationFrame(() => restoreAnchor(a));
    });
  }
}

// ------------------------------------------------------------------ review load & reconcile

function indexThreads() {
  const by = new Map<string, Thread[]>();
  for (const t of S.threads.values()) {
    if (t.inScope === false) continue;
    let arr = by.get(t.anchor.path);
    if (!arr) by.set(t.anchor.path, (arr = []));
    arr.push(t);
  }
  for (const arr of by.values()) arr.sort((a, b) => (a.anchor.endLine ?? 0) - (b.anchor.endLine ?? 0) || a.id - b.id);
  S.threadsByPath = by;
}

export function defaultCollapsed(f: DiffFile): boolean {
  if (f.viewed) return true;
  if (f.status === 'deleted' && f.deletions > 400) return true;
  return false;
}

export function isCollapsed(f: DiffFile): boolean {
  return S.collapsed.get(fk(f.path)) ?? defaultCollapsed(f);
}

/** Applies a review response. Keeps file objects whose fingerprint did not change. */
function applyReview(next: Review, opts: { initial: boolean; flash: boolean }) {
  const prevFiles = S.fileByPath;
  const changedTopics: string[] = [];
  const flashed: string[] = [];
  const files: DiffFile[] = [];
  const byPath = new Map<string, DiffFile>();
  for (const nf of next.files) {
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
      if (old && opts.flash) flashed.push(nf.path);
      if (old && old.fingerprint !== nf.fingerprint) {
        S.since.delete(fk(nf.path));
        S.expansions.delete(fk(nf.path));
      }
    }
  }
  const listChanged =
    opts.initial || files.length !== S.files.length || files.some((f, i) => S.files[i]?.path !== f.path);
  if (opts.flash) for (const f of files) if (!prevFiles.has(f.path) && prevFiles.size) flashed.push(f.path);

  S.review = next;
  S.scopeCache.set(next.scope ?? 'all', next);
  S.files = files;
  S.fileByPath = byPath;
  S.agents = next.agents;

  // Threads.
  const seen = new Set<number>();
  for (const t of next.threads) {
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
  emit(...changedTopics, 'review', 'threads', 'agents', 'progress', 'tree', 'ui');
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
          S.collapsed.set(fk(f.path), ev.viewed);
          emit(fileTopic(f.path), 'progress', 'tree');
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
  }
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
  if (prev && prev.updatedAt === t.updatedAt && prev.messages.length === t.messages.length && prev.inScope === t.inScope && prev.anchor.endLine === t.anchor.endLine && prev.outdated === t.outdated && prev.agentState === t.agentState && prev.resolved === t.resolved && JSON.stringify(prev.messages) === JSON.stringify(t.messages)) return;
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
  if (opts.reindex) indexThreads();
}

function removeThread(id: number) {
  const t = S.threads.get(id);
  if (!t) return;
  S.threads.delete(id);
  S.unread.delete(id);
  indexThreads();
  emit(fileTopic(t.anchor.path), 'threads', 'tree');
}

function saveUnread() {
  lsSet(`margin:unread:${S.reviewId}`, JSON.stringify([...S.unread]));
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

export async function createThread(c: ComposerState, noteOnly: boolean): Promise<boolean> {
  if (!c.anchor) return false;
  const t = await guard(
    api.createThread(S.reviewId, c.scope, { anchor: c.anchor, body: c.text, author: HUMAN, noteOnly }),
    'Comment',
  );
  if (!t) return false;
  preserveScroll(() => upsertThread(t, { quiet: true, reindex: true }));
  return true;
}

export async function reply(tid: number, body: string, resolve = false): Promise<boolean> {
  const t = await guard(api.addMessage(tid, { body, author: HUMAN, resolve }), 'Reply');
  if (!t) return false;
  markRead(tid);
  preserveScroll(() => upsertThread(t, { quiet: true, reindex: true }));
  return true;
}

export async function setResolved(tid: number, resolved: boolean) {
  const t = await guard(api.updateThread(tid, { resolved }), resolved ? 'Resolve' : 'Unresolve');
  if (!t) return;
  markRead(tid);
  S.openResolved.delete(tid);
  preserveScroll(() => upsertThread(t, { quiet: true, reindex: true }));
}

export async function editMessage(mid: number, body: string): Promise<boolean> {
  const t = await guard(api.editMessage(mid, body), 'Edit');
  if (!t) return false;
  preserveScroll(() => upsertThread(t, { quiet: true, reindex: true }));
  return true;
}

export async function deleteMessage(tid: number, mid: number) {
  const res = await guard(api.deleteMessage(mid), 'Delete');
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
    lsSet(`margin:composers:${S.reviewId}`, JSON.stringify([...S.composers.values()]));
  }, 250);
}

export function restoreDrafts() {
  const raw = lsGet(`margin:composers:${S.reviewId}`);
  if (!raw) return;
  try {
    for (const c of JSON.parse(raw) as ComposerState[]) if (c && c.key) S.composers.set(c.key, c);
  } catch {
    /* ignore */
  }
  const u = lsGet(`margin:unread:${S.reviewId}`);
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

export function openComposer(c: Omit<ComposerState, 'text'> & { text?: string }) {
  const existing = S.composers.get(c.key);
  preserveScroll(() => {
    if (!existing) S.composers.set(c.key, { ...c, text: c.text ?? '' });
    emit(fileTopic(c.path), 'composers');
  });
  saveDrafts();
  // Focus after render.
  requestAnimationFrame(() =>
    requestAnimationFrame(() => {
      const el = document.querySelector<HTMLTextAreaElement>(`[data-composer="${CSS.escape(c.key)}"] textarea`);
      if (el) {
        el.focus();
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
  if (isCollapsed(S.fileByPath.get(path)!)) setCollapsed(path, false);
  openComposer({ key, kind: 'new', scope: S.scope, path, anchor });
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
  preserveScroll(() => {
    S.collapsed.set(fk(path), collapsed);
    emit(fileTopic(path), 'tree');
  });
}

export async function setViewed(path: string, viewed: boolean) {
  const f = S.fileByPath.get(path);
  if (!f) return;
  const prev = { viewed: f.viewed, changed: f.changedSinceViewed, collapsed: S.collapsed.get(fk(path)) };
  const card = findCard(path);
  const sc = S.scroller;
  const cardAbove = card && sc ? card.getBoundingClientRect().top < sc.getBoundingClientRect().top : false;
  f.viewed = viewed;
  if (viewed) f.changedSinceViewed = false;
  S.collapsed.set(fk(path), viewed);
  if (viewed) S.since.delete(fk(path));
  emit(fileTopic(path), 'progress', 'tree');
  if (viewed && cardAbove) {
    // The reader was inside this file: keep the collapsed header at the top.
    requestAnimationFrame(() => {
      const c = findCard(path);
      if (c && sc) sc.scrollTop += c.getBoundingClientRect().top - sc.getBoundingClientRect().top;
    });
  }
  const scope = S.scope;
  const ok = await guard(api.setViewed(S.reviewId, scope, path, viewed), 'Mark viewed');
  if (!ok && scope === S.scope) {
    f.viewed = prev.viewed;
    f.changedSinceViewed = prev.changed;
    if (prev.collapsed === undefined) S.collapsed.delete(fk(path));
    else S.collapsed.set(fk(path), prev.collapsed);
    emit(fileTopic(path), 'progress', 'tree');
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

export async function expandGap(path: string, gapId: string, dir: 'up' | 'down' | 'all', step = 20) {
  const f = S.fileByPath.get(path);
  if (!f) return;
  const c = getContent(f);
  if (!c || (!c.new && !c.old)) {
    await ensureContent(path);
  }
  preserveScroll(() => {
    let m = S.expansions.get(fk(path));
    if (!m) S.expansions.set(fk(path), (m = new Map()));
    const e = m.get(gapId) ?? { top: 0, bottom: 0 };
    if (dir === 'all') e.top = 1e9;
    else if (dir === 'down') e.top += step;
    else e.bottom += step;
    m.set(gapId, e);
    emit(fileTopic(path));
  });
}

// ------------------------------------------------------------------ content & highlighting

export function getContent(f: DiffFile): Content | undefined {
  const c = S.contents.get(fk(f.path));
  return c && c.fp === f.fingerprint ? c : undefined;
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

const MAX_HL = 1_500_000;
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

export async function ensureContent(path: string): Promise<void> {
  const f = S.fileByPath.get(path);
  if (!f || f.binary || f.tooLarge) return;
  const key = fk(path);
  const have = S.contents.get(key);
  if (have && have.fp === f.fingerprint) return;
  const c: Content = { fp: f.fingerprint, old: null, new: null, oldHl: null, newHl: null, loading: true, ver: 0 };
  S.contents.set(key, c);
  const scope = S.scope;
  const fetchSide = (side: Side) =>
    slot(() => api.file(S.reviewId, scope, path, side)).catch(() => null);
  const [o, n] = await Promise.all([
    f.status !== 'added' ? fetchSide('old') : Promise.resolve(null),
    f.status !== 'deleted' ? fetchSide('new') : Promise.resolve(null),
  ]);
  if (S.contents.get(key) !== c) return;
  c.old = o && o.exists && !o.binary ? splitLines(o.text) : null;
  c.new = n && n.exists && !n.binary ? splitLines(n.text) : null;
  c.loading = false;
  c.ver++;
  emit(fileTopic(path));
  const lang = langForPath(path);
  if (!lang) return;
  const jobs: Promise<void>[] = [];
  if (c.old && o!.text.length < MAX_HL)
    jobs.push(
      highlightText(c.old.join('\n'), lang).then((h) => {
        if (h && h.length >= c.old!.length) c.oldHl = h;
      }),
    );
  if (c.new && n!.text.length < MAX_HL)
    jobs.push(
      highlightText(c.new.join('\n'), lang).then((h) => {
        if (h && h.length >= c.new!.length) c.newHl = h;
      }),
    );
  await Promise.all(jobs);
  if (S.contents.get(key) !== c) return;
  c.ver++;
  emit(fileTopic(path));
}

// ------------------------------------------------------------------ navigation

export function setCurrent(path: string | null) {
  if (S.current === path) return;
  S.current = path;
  emit('current');
}

export function scrollToFile(path: string, opts: { instant?: boolean } = {}) {
  const card = findCard(path);
  const sc = S.scroller;
  if (!card || !sc) return;
  sc.scrollTo({
    top: sc.scrollTop + card.getBoundingClientRect().top - sc.getBoundingClientRect().top,
    behavior: opts.instant ? 'instant' : 'auto',
  });
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
      S.collapsed.set(fk(f.path), false);
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
      else if (f) scrollToFile(f.path);
    };
    requestAnimationFrame(() => tryScroll(10));
  };
  if (t.inScope === false && t.homeScope && t.homeScope !== S.scope) {
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
  void loadReview({ initial: true });
  connectEvents();
}

export function fileKey(path: string) {
  return fk(path);
}
