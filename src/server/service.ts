import type {
  AddMessageRequest,
  AgentPresence,
  AgentState,
  AgentThread,
  Anchor,
  CreateThreadRequest,
  DiffFile,
  FileContent,
  Message,
  RepoInfo,
  Review,
  ReviewScope,
  ReviewSpec,
  ReviewSummary,
  ServerEvent,
  Side,
  SinceViewed,
  Thread,
  UpdateThreadRequest,
  WaitResponse,
} from '../shared/types.ts';
import { capture, reanchor, splitLines } from './anchor.ts';
import {
  countLines,
  diffBlobs,
  diffTrees,
  fileFingerprint,
  fingerprintOfRaw,
  MAX_FILE_BYTES,
  publicFile,
  rawDiff,
  sha1,
  type FileDiff,
  type RawEntry,
} from './diff.ts';
import { badRequest, HttpError, notFound } from './errors.ts';
import {
  catFileBatch,
  currentBranch,
  EMPTY_TREE,
  gitLine,
  hashObject,
  headCommit,
  marginDir,
  mergeBase,
  resolveCommit,
  treeOf,
  type RepoPaths,
} from './git.ts';
import { IndexTreeReader, WorkingSnapshotter } from './snapshot.ts';
import type { MessageRow, ReviewRow, Store, Target, ThreadRow } from './store.ts';
import { renderDiffContext } from './context.ts';

export const SCOPE_SIDES: Record<ReviewScope, { old: Target; new: Target }> = {
  all: { old: 'old', new: 'new' },
  staged: { old: 'old', new: 'index' },
  unstaged: { old: 'index', new: 'new' },
};
const WORKING_SCOPES: ReviewScope[] = ['all', 'staged', 'unstaged'];

/** The computed state of one review at one moment. */
export interface ReviewState {
  review: ReviewRow;
  key: string;
  trees: { old: string; index: string | null; new: string };
  resolved: { from: string; to: string | null };
  scopes: ReviewScope[];
  raw: Partial<Record<ReviewScope, RawEntry[]>>;
  fingerprints: Partial<Record<ReviewScope, string>>;
  at: number;
}

export interface MarginOptions {
  repo: RepoPaths;
  store: Store;
  version: string;
  /** Claims without a reply return to 'pending' after this long. Default 15 minutes. */
  claimTimeoutMs?: number;
  /** Live diff poll interval while a browser is subscribed. Default 2000. */
  pollMs?: number;
  /** How long an agent stays "waiting" in presence after its wait returns. Default 5000. */
  presenceLingerMs?: number;
}

interface Subscriber {
  reviewId: string;
  scope: ReviewScope;
  send: (ev: ServerEvent) => void;
  lastFingerprint: string | null;
}

interface Waiter {
  agent: string;
  reviewId: string | null;
  since: string;
  deliver: (rows: ThreadRow[]) => void;
}

const nowIso = () => new Date().toISOString();

function displayPath(e: RawEntry): string {
  return e.status === 'D' ? e.oldPath : e.newPath;
}

function isNullId(id: string | null | undefined): boolean {
  return !id || /^0+$/.test(id);
}

/** Path and blob of an entry on one side. */
function sideOf(e: RawEntry, isNew: boolean): { path: string; id: string | null } {
  if (isNew) return { path: e.newPath, id: e.status === 'D' || isNullId(e.newId) ? null : e.newId };
  return { path: e.oldPath, id: e.status === 'A' || isNullId(e.oldId) ? null : e.oldId };
}

function slug(s: string): string {
  return s.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'x';
}

function toMessage(m: MessageRow): Message {
  return {
    id: m.id,
    author: { kind: m.authorKind, name: m.authorName },
    body: m.body,
    createdAt: m.createdAt,
    editedAt: m.editedAt,
  };
}

/** Text of blobs by id. Blobs never change, so a plain bounded cache is safe. */
const textCache = new Map<string, Buffer>();

export class Margin {
  readonly repo: RepoPaths;
  readonly store: Store;
  readonly version: string;
  private readonly snapshotter: WorkingSnapshotter;
  private readonly indexReader: IndexTreeReader;
  private readonly claimTimeoutMs: number;
  private readonly pollMs: number;
  private readonly lingerMs: number;

  private states = new Map<string, ReviewState>();
  private computeChains = new Map<string, Promise<unknown>>();
  private anchoredKey = new Map<string, string>();
  private subscribers = new Set<Subscriber>();
  private pollers = new Map<string, { timer: NodeJS.Timeout; busy: boolean }>();
  private waiters = new Set<Waiter>();
  private lingering = new Map<string, { since: string; until: number }>();
  private presenceKey = '';
  private timers: NodeJS.Timeout[] = [];
  private closed = false;
  /** Called on any API activity; the server uses it for idle shutdown. */
  onActivity: () => void = () => {};

  constructor(opts: MarginOptions) {
    this.repo = opts.repo;
    this.store = opts.store;
    this.version = opts.version;
    this.claimTimeoutMs = opts.claimTimeoutMs ?? 15 * 60_000;
    this.pollMs = opts.pollMs ?? 2000;
    this.lingerMs = opts.presenceLingerMs ?? 5000;
    const dir = marginDir(opts.repo);
    this.snapshotter = new WorkingSnapshotter(opts.repo.root, opts.repo.gitDir, dir);
    this.indexReader = new IndexTreeReader(opts.repo.root, opts.repo.gitDir, dir);
    const t = setInterval(() => this.expireClaims(), Math.min(10_000, Math.max(200, this.claimTimeoutMs / 4)));
    t.unref();
    this.timers.push(t);
  }

  close(): void {
    this.closed = true;
    for (const t of this.timers) clearInterval(t);
    for (const p of this.pollers.values()) clearInterval(p.timer);
    this.pollers.clear();
    for (const w of [...this.waiters]) w.deliver([]);
  }

  get cwd(): string {
    return this.repo.root;
  }

  get subscriberCount(): number {
    return this.subscribers.size;
  }

  get waiterCount(): number {
    return this.waiters.size;
  }

  async repoInfo(): Promise<RepoInfo> {
    const name = this.repo.root.split('/').filter(Boolean).pop() ?? this.repo.root;
    return { root: this.repo.root, name, branch: await currentBranch(this.cwd) };
  }

  // ================================================================ reviews

  private summary(r: ReviewRow): ReviewSummary {
    return { id: r.id, spec: r.spec, title: r.title, createdAt: r.createdAt, updatedAt: r.updatedAt, ...this.store.threadCounts(r.id) };
  }

  listReviews(): ReviewSummary[] {
    return this.store.listReviews().map((r) => this.summary(r));
  }

  private requireReview(id: string): ReviewRow {
    const r = this.store.getReview(id);
    if (!r) throw notFound(`Review "${id}" not found.`);
    return r;
  }

  /** Validates and normalizes a spec, then creates or reuses its review. */
  async openReview(spec: ReviewSpec): Promise<ReviewSummary> {
    const { id, title, spec: norm } = await this.normalizeSpec(spec);
    const row = this.store.upsertReview(id, norm, title, nowIso());
    return this.summary(row);
  }

  private async mustCommit(rev: string, what: string): Promise<string> {
    if (typeof rev !== 'string' || !rev.trim()) throw badRequest(`Missing ${what}.`);
    const c = await resolveCommit(this.cwd, rev);
    if (!c) throw badRequest(`Unknown revision "${rev}" (${what}).`);
    return c;
  }

  async normalizeSpec(spec: ReviewSpec): Promise<{ id: string; title: string; spec: ReviewSpec }> {
    if (!spec || typeof spec !== 'object') throw badRequest('Missing spec.');
    switch (spec.kind) {
      case 'working':
        return { id: 'working', title: 'Uncommitted changes', spec: { kind: 'working' } };
      case 'branch': {
        const head = spec.head?.trim() || (await currentBranch(this.cwd)) || 'HEAD';
        await this.mustCommit(spec.base, 'base');
        await this.mustCommit(head, 'head');
        return {
          id: `branch-${slug(head)}-vs-${slug(spec.base)}`,
          title: `${head} → ${spec.base}`,
          spec: { kind: 'branch', base: spec.base, head },
        };
      }
      case 'commit': {
        const sha = await this.mustCommit(spec.rev, 'commit');
        let subject = '';
        try {
          subject = await gitLine(['log', '-1', '--format=%s', sha], { cwd: this.cwd });
        } catch {
          /* ignore */
        }
        return {
          id: `commit-${sha.slice(0, 12)}`,
          title: `${sha.slice(0, 7)} ${subject}`.trim(),
          spec: { kind: 'commit', rev: sha },
        };
      }
      case 'range': {
        await this.mustCommit(spec.from, 'from');
        await this.mustCommit(spec.to, 'to');
        return { id: `range-${slug(spec.from)}-${slug(spec.to)}`, title: `${spec.from}..${spec.to}`, spec: { kind: 'range', from: spec.from, to: spec.to } };
      }
      default:
        throw badRequest(`Unknown spec kind "${(spec as { kind: string }).kind}".`);
    }
  }

  private async resolveTrees(r: ReviewRow): Promise<Pick<ReviewState, 'trees' | 'resolved' | 'scopes'>> {
    const cwd = this.cwd;
    const spec = r.spec;
    const fail = (m: string) => new HttpError(409, m);
    switch (spec.kind) {
      case 'working': {
        const head = await headCommit(cwd);
        const oldTree = head ? await treeOf(cwd, head) : EMPTY_TREE;
        const [index, worktree] = await Promise.all([this.indexReader.read(oldTree), this.snapshotter.snapshot()]);
        return { trees: { old: oldTree, index, new: worktree }, resolved: { from: head ?? EMPTY_TREE, to: null }, scopes: WORKING_SCOPES };
      }
      case 'branch': {
        const base = await resolveCommit(cwd, spec.base);
        const head = await resolveCommit(cwd, spec.head);
        if (!base) throw fail(`Base "${spec.base}" no longer resolves.`);
        if (!head) throw fail(`Head "${spec.head}" no longer resolves.`);
        const mb = (await mergeBase(cwd, base, head)) ?? base;
        const branch = await currentBranch(cwd);
        const headIsWorking = spec.head === 'HEAD' || spec.head === branch;
        const newTree = headIsWorking ? await this.snapshotter.snapshot() : await treeOf(cwd, head);
        return {
          trees: { old: await treeOf(cwd, mb), index: null, new: newTree },
          resolved: { from: mb, to: headIsWorking ? null : head },
          scopes: ['all'],
        };
      }
      case 'commit': {
        const c = await resolveCommit(cwd, spec.rev);
        if (!c) throw fail(`Commit "${spec.rev}" no longer exists.`);
        const parent = await resolveCommit(cwd, `${c}^`);
        return {
          trees: { old: parent ? await treeOf(cwd, parent) : EMPTY_TREE, index: null, new: await treeOf(cwd, c) },
          resolved: { from: parent ?? EMPTY_TREE, to: c },
          scopes: ['all'],
        };
      }
      case 'range': {
        const a = await resolveCommit(cwd, spec.from);
        const b = await resolveCommit(cwd, spec.to);
        if (!a || !b) throw fail(`Range ${spec.from}..${spec.to} no longer resolves.`);
        return { trees: { old: await treeOf(cwd, a), index: null, new: await treeOf(cwd, b) }, resolved: { from: a, to: b }, scopes: ['all'] };
      }
    }
  }

  private treeOfTarget(s: ReviewState, t: Target): string | null {
    return t === 'index' ? s.trees.index : s.trees[t];
  }

  /** Recomputes the state of a review (serialized per review). Re-anchors threads when the trees changed. */
  compute(id: string): Promise<ReviewState> {
    const prev = this.computeChains.get(id) ?? Promise.resolve();
    const run = async (): Promise<ReviewState> => {
      const review = this.requireReview(id);
      const { trees, resolved, scopes } = await this.resolveTrees(review);
      const raw: ReviewState['raw'] = {};
      const fingerprints: ReviewState['fingerprints'] = {};
      await Promise.all(
        scopes.map(async (sc) => {
          const sides = SCOPE_SIDES[sc];
          const tree = (t: Target) => (t === 'index' ? trees.index : trees[t])!;
          const entries = await rawDiff(this.cwd, tree(sides.old), tree(sides.new));
          raw[sc] = entries;
          fingerprints[sc] = fingerprintOfRaw(entries);
        }),
      );
      const state: ReviewState = {
        review,
        key: [trees.old, trees.index, trees.new].join(':'),
        trees,
        resolved,
        scopes,
        raw,
        fingerprints,
        at: Date.now(),
      };
      this.states.set(id, state);
      if (this.anchoredKey.get(id) !== state.key) {
        const changed = await this.reanchorAll(state);
        this.anchoredKey.set(id, state.key);
        for (const tid of changed) this.emitThread(tid, state);
      }
      return state;
    };
    const p = prev.then(run, run);
    this.computeChains.set(
      id,
      p.catch(() => {}),
    );
    return p;
  }

  /** Cached state when it is fresh enough, else a new computation. */
  private async freshState(id: string, maxAgeMs = 1000): Promise<ReviewState> {
    const s = this.states.get(id);
    if (s && Date.now() - s.at <= maxAgeMs) return s;
    return this.compute(id);
  }

  private checkScope(state: ReviewState, scope: ReviewScope): void {
    if (!state.scopes.includes(scope)) {
      throw badRequest(`Scope "${scope}" is not available for review "${state.review.id}" (available: ${state.scopes.join(', ')}).`);
    }
  }

  private scopeTrees(state: ReviewState, scope: ReviewScope): [string, string] {
    const s = SCOPE_SIDES[scope];
    return [this.treeOfTarget(state, s.old)!, this.treeOfTarget(state, s.new)!];
  }

  async fullFiles(state: ReviewState, scope: ReviewScope): Promise<FileDiff[]> {
    const [a, b] = this.scopeTrees(state, scope);
    return diffTrees(this.cwd, a, b);
  }

  async getReview(id: string, scope: ReviewScope = 'all'): Promise<Review> {
    const state = await this.compute(id);
    this.checkScope(state, scope);
    this.store.touchReviewOpened(id, nowIso());
    const files = await this.fullFiles(state, scope);
    const viewed = this.store.viewedOf(id, scope);
    const out: DiffFile[] = files.map((f) => {
      const pub = publicFile(f);
      const v = viewed.get(f.path);
      return { ...pub, viewed: !!v && v.fingerprint === f.fingerprint, changedSinceViewed: !!v && v.fingerprint !== f.fingerprint };
    });
    const scopeFileCounts: Review['scopeFileCounts'] = {};
    for (const sc of state.scopes) scopeFileCounts[sc] = state.raw[sc]?.length ?? 0;
    return {
      ...this.summary(this.store.getReview(id)!),
      repo: await this.repoInfo(),
      scope,
      scopes: state.scopes,
      scopeFileCounts,
      resolved: state.resolved,
      diffFingerprint: state.fingerprints[scope] ?? '',
      files: out,
      threads: this.store.threadsOfReview(id).map((t) => this.toThread(t, scope, state)),
      agents: this.agents(),
    };
  }

  private findEntry(state: ReviewState, scope: ReviewScope, p: string): RawEntry | null {
    const entries = state.raw[scope] ?? [];
    return entries.find((e) => displayPath(e) === p) ?? entries.find((e) => e.oldPath === p) ?? null;
  }

  private async blobs(ids: string[]): Promise<Map<string, Buffer>> {
    const res = new Map<string, Buffer>();
    const missing: string[] = [];
    for (const id of ids) {
      const b = textCache.get(id);
      if (b) res.set(id, b);
      else missing.push(id);
    }
    if (missing.length) {
      const got = await catFileBatch(this.cwd, missing);
      if (textCache.size > 500) textCache.clear();
      for (const [id, buf] of got) {
        if (buf.length <= 4 * MAX_FILE_BYTES) textCache.set(id, buf);
        res.set(id, buf);
      }
    }
    return res;
  }

  private async blobLines(id: string): Promise<string[]> {
    const b = (await this.blobs([id])).get(id);
    return b ? splitLines(b.toString('utf8')) : [];
  }

  async fileContent(id: string, p: string, side: Side, scope: ReviewScope = 'all'): Promise<FileContent> {
    const state = await this.freshState(id, 3000);
    this.checkScope(state, scope);
    if (side !== 'old' && side !== 'new') throw badRequest('side must be "old" or "new".');
    const e = this.findEntry(state, scope, p);
    if (!e) throw notFound(`File "${p}" is not in the diff.`);
    const s = sideOf(e, side === 'new');
    if (!s.id) return { path: p, side, exists: false, binary: false, text: '' };
    const buf = (await this.blobs([s.id])).get(s.id) ?? Buffer.alloc(0);
    const binary = buf.subarray(0, 8000).includes(0);
    return { path: p, side, exists: true, binary, text: binary ? '' : buf.toString('utf8') };
  }

  // ================================================================ viewed

  async setViewed(id: string, scope: ReviewScope, p: string, viewed: boolean): Promise<void> {
    if (typeof p !== 'string' || !p) throw badRequest('Missing path.');
    const state = await this.freshState(id, 1000);
    this.checkScope(state, scope);
    if (!viewed) {
      this.store.clearViewed(id, scope, p);
    } else {
      const e = this.findEntry(state, scope, p);
      if (!e) throw badRequest(`File "${p}" is not in the diff.`);
      const s = sideOf(e, true);
      let blobId: string | null = null;
      if (s.id) {
        const buf = (await this.blobs([s.id])).get(s.id);
        if (buf && buf.length <= MAX_FILE_BYTES) {
          this.store.putBlob(s.id, buf);
          blobId = s.id;
        }
      }
      this.store.setViewed(id, scope, displayPath(e), fileFingerprint(e), blobId, nowIso());
    }
    this.broadcast(id, () => ({ type: 'viewed', path: p, viewed }), scope);
  }

  async sinceViewed(id: string, scope: ReviewScope, p: string): Promise<SinceViewed> {
    const state = await this.freshState(id, 1000);
    this.checkScope(state, scope);
    const rec = this.store.viewedOf(id, scope).get(p);
    const e = this.findEntry(state, scope, p);
    if (!rec || !rec.blobId || !e) return { path: p, file: null };
    const cur = sideOf(e, true);
    if (!cur.id || cur.id === rec.blobId) return { path: p, file: null };
    // The snapshot object may have been pruned: restore it from the database.
    const have = await catFileBatch(this.cwd, [rec.blobId]);
    let oldBuf = have.get(rec.blobId);
    if (!oldBuf) {
      const stored = this.store.getBlob(rec.blobId);
      if (!stored) return { path: p, file: null };
      await hashObject(this.cwd, stored);
      oldBuf = stored;
    }
    const newBuf = (await this.blobs([cur.id])).get(cur.id) ?? Buffer.alloc(0);
    const parsed = await diffBlobs(this.cwd, rec.blobId, cur.id);
    const file: DiffFile = {
      path: p,
      status: 'modified',
      binary: parsed.binary,
      additions: parsed.additions,
      deletions: parsed.deletions,
      hunks: parsed.binary ? [] : parsed.hunks,
      tooLarge: false,
      fingerprint: sha1(`${rec.blobId}:${cur.id}`).slice(0, 16),
      viewed: false,
      changedSinceViewed: true,
      oldLineCount: countLines(oldBuf),
      newLineCount: countLines(newBuf),
    };
    return { path: p, file };
  }

  // ================================================================ threads

  /** Finds the file a thread refers to in one scope. */
  private locate(t: ThreadRow, state: ReviewState, scope: ReviewScope): { entry: RawEntry; isNew: boolean; path: string; id: string | null } | null {
    const sides = SCOPE_SIDES[scope];
    if (!state.scopes.includes(scope)) return null;
    if (sides.old !== t.target && sides.new !== t.target) return null;
    const isNew = sides.new === t.target;
    const entries = state.raw[scope] ?? [];
    const pick = (e: RawEntry) => ({ entry: e, isNew, ...sideOf(e, isNew) });
    for (const e of entries) if (sideOf(e, isNew).path === t.path) return pick(e);
    // Renamed since the thread was anchored: the file's other path matches.
    for (const e of entries) if (e.status === 'R' && (isNew ? e.oldPath : e.newPath) === t.path) return pick(e);
    if (t.pathHint) for (const e of entries) if (sideOf(e, isNew).path === t.pathHint) return pick(e);
    return null;
  }

  /** Scopes where the thread's target is a side, home scope first. */
  private scopesFor(t: ThreadRow, state: ReviewState): ReviewScope[] {
    const list = state.scopes.filter((s) => SCOPE_SIDES[s].old === t.target || SCOPE_SIDES[s].new === t.target);
    return [...list.filter((s) => s === t.homeScope), ...list.filter((s) => s !== t.homeScope)];
  }

  private findForThread(t: ThreadRow, state: ReviewState) {
    for (const sc of this.scopesFor(t, state)) {
      const loc = this.locate(t, state, sc);
      if (loc) return { scope: sc, ...loc };
    }
    return null;
  }

  /** Re-anchors every thread of the review. Returns ids of threads that changed. */
  private async reanchorAll(state: ReviewState): Promise<number[]> {
    const threads = this.store.threadsOfReview(state.review.id);
    const found = threads.map((t) => ({ t, loc: this.findForThread(t, state) }));
    const ids = found.flatMap((f) => (f.loc?.id && f.t.startLine !== null ? [f.loc.id] : []));
    const blobs = await this.blobs(ids);
    const changed: number[] = [];
    for (const { t, loc } of found) {
      const patch: Partial<ThreadRow> = {};
      if (!loc || !loc.id) {
        if (!t.outdated) patch.outdated = true;
      } else {
        const hint = loc.entry.status === 'R' ? (loc.isNew ? loc.entry.oldPath : loc.entry.newPath) : t.pathHint;
        if (loc.path !== t.path) patch.path = loc.path;
        if (hint !== t.pathHint) patch.pathHint = hint;
        if (t.startLine === null || t.endLine === null) {
          if (t.outdated) patch.outdated = false;
        } else {
          const lines = splitLines((blobs.get(loc.id) ?? Buffer.alloc(0)).toString('utf8'));
          const start = reanchor(lines, { snippet: t.snippet, ctxBefore: t.ctxBefore, ctxAfter: t.ctxAfter }, t.startLine);
          if (start === null) {
            if (!t.outdated) patch.outdated = true;
          } else {
            if (t.outdated) patch.outdated = false;
            if (start !== t.startLine) {
              patch.startLine = start;
              patch.endLine = start + t.snippet.length - 1;
            }
          }
        }
      }
      if (Object.keys(patch).length) {
        this.store.updateThread(t.id, patch);
        changed.push(t.id);
      }
    }
    return changed;
  }

  private claimValid(t: ThreadRow): boolean {
    return !!t.claimedBy && t.claimedAt !== null && Date.now() - t.claimedAt < this.claimTimeoutMs;
  }

  private agentStateOf(t: ThreadRow, msgs: MessageRow[]): { state: AgentState; claimedBy: string | null } {
    const last = msgs[msgs.length - 1];
    if (t.resolved || t.noteOnly || !last || last.authorKind === 'agent') return { state: 'idle', claimedBy: null };
    if (this.claimValid(t)) return { state: 'working', claimedBy: t.claimedBy };
    return { state: 'pending', claimedBy: null };
  }

  /** Converts a thread row to the API shape, expressed in the given scope. */
  toThread(t: ThreadRow, scope: ReviewScope, state: ReviewState | null, msgs = this.store.messagesOf(t.id)): Thread {
    let inScope = false;
    let viewScope: ReviewScope = t.homeScope;
    let loc = null as ReturnType<Margin['locate']>;
    if (state) {
      loc = this.locate(t, state, scope);
      const isSide = SCOPE_SIDES[scope].old === t.target || SCOPE_SIDES[scope].new === t.target;
      inScope = state.scopes.includes(scope) && isSide && (!!loc || (t.outdated && scope === t.homeScope));
      if (inScope) viewScope = scope;
      else loc = this.locate(t, state, t.homeScope);
    } else {
      inScope = scope === t.homeScope;
    }
    const side: Side = SCOPE_SIDES[viewScope].new === t.target ? 'new' : 'old';
    const anchor: Anchor = {
      path: loc ? displayPath(loc.entry) : t.path,
      side,
      startLine: t.startLine,
      endLine: t.endLine,
    };
    const { state: agentState, claimedBy } = this.agentStateOf(t, msgs);
    return {
      id: t.id,
      reviewId: t.reviewId,
      anchor,
      inScope,
      homeScope: t.homeScope,
      snippet: t.snippet,
      outdated: t.outdated,
      resolved: t.resolved,
      noteOnly: t.noteOnly,
      agentState,
      claimedBy,
      messages: msgs.map(toMessage),
      createdAt: t.createdAt,
      updatedAt: t.updatedAt,
    };
  }

  private requireThread(tid: number): ThreadRow {
    const t = Number.isInteger(tid) ? this.store.getThread(tid) : null;
    if (!t) throw notFound(`Thread ${tid} not found.`);
    return t;
  }

  async getThread(tid: number, scope?: ReviewScope): Promise<Thread> {
    const t = this.requireThread(tid);
    const state = this.states.get(t.reviewId) ?? (await this.compute(t.reviewId));
    return this.toThread(t, scope ?? t.homeScope, state);
  }

  private validateBody(body: unknown): string {
    if (typeof body !== 'string' || !body.trim()) throw badRequest('Message body is empty.');
    return body;
  }

  private validateAuthor(a: unknown): { kind: 'human' | 'agent'; name: string } {
    const au = a as { kind?: string; name?: string } | undefined;
    if (!au || (au.kind !== 'human' && au.kind !== 'agent')) throw badRequest('author.kind must be "human" or "agent".');
    const name = typeof au.name === 'string' && au.name.trim() ? au.name.trim() : au.kind === 'human' ? 'you' : 'agent';
    return { kind: au.kind, name };
  }

  async createThread(reviewId: string, scope: ReviewScope, req: CreateThreadRequest): Promise<Thread> {
    const body = this.validateBody(req?.body);
    const author = this.validateAuthor(req?.author);
    const a = req?.anchor;
    if (!a || typeof a.path !== 'string') throw badRequest('Missing anchor.path.');
    if (a.side !== 'old' && a.side !== 'new') throw badRequest('anchor.side must be "old" or "new".');
    const state = await this.freshState(reviewId, 1000);
    this.checkScope(state, scope);
    const e = this.findEntry(state, scope, a.path);
    if (!e) {
      const files = (state.raw[scope] ?? []).map(displayPath);
      const hint = files.length ? ` Files in the diff: ${files.slice(0, 20).join(', ')}${files.length > 20 ? ', …' : ''}` : ' The diff is empty.';
      throw badRequest(`File "${a.path}" is not in the diff of review "${reviewId}" (scope ${scope}).${hint}`);
    }
    const isNew = a.side === 'new';
    const side = sideOf(e, isNew);
    const target = isNew ? SCOPE_SIDES[scope].new : SCOPE_SIDES[scope].old;
    let start: number | null = null;
    let end: number | null = null;
    let cap = { snippet: [] as string[], ctxBefore: [] as string[], ctxAfter: [] as string[] };
    const hasLines = a.startLine !== null && a.startLine !== undefined;
    if (hasLines) {
      if (!side.id) throw badRequest(`The ${a.side} side of "${a.path}" does not exist (the file was ${e.status === 'A' ? 'added' : 'deleted'}).`);
      start = Number(a.startLine);
      end = a.endLine === null || a.endLine === undefined ? start : Number(a.endLine);
      if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start) throw badRequest('Invalid line range.');
      const buf = (await this.blobs([side.id])).get(side.id) ?? Buffer.alloc(0);
      if (buf.subarray(0, 8000).includes(0)) throw badRequest(`"${a.path}" is binary: comment on the file instead of a line.`);
      const lines = splitLines(buf.toString('utf8'));
      if (end > lines.length) throw badRequest(`Line ${end} is past the end of "${a.path}" (${a.side} side has ${lines.length} lines).`);
      cap = capture(lines, start, end);
    }
    const now = nowIso();
    const hint = e.status === 'R' ? (isNew ? e.oldPath : e.newPath) : null;
    const tid = this.store.transaction(() => {
      const id = this.store.insertThread({
        reviewId,
        target,
        homeScope: scope,
        path: side.path,
        pathHint: hint,
        startLine: start,
        endLine: end,
        snippet: cap.snippet,
        ctxBefore: cap.ctxBefore,
        ctxAfter: cap.ctxAfter,
        noteOnly: !!req.noteOnly,
        createdAt: now,
        updatedAt: now,
      });
      this.store.insertMessage(id, author.kind, author.name, body, now);
      this.store.touchReviewUpdated(reviewId, now);
      return id;
    });
    this.afterThreadChange(tid);
    return this.toThread(this.store.getThread(tid)!, scope, state);
  }

  async updateThread(tid: number, req: UpdateThreadRequest, scope?: ReviewScope): Promise<Thread> {
    const t = this.requireThread(tid);
    const patch: Partial<ThreadRow> = { updatedAt: nowIso() };
    if (req?.resolved !== undefined) {
      patch.resolved = !!req.resolved;
      if (req.resolved) Object.assign(patch, { claimedBy: null, claimedAt: null });
    }
    if (req?.noteOnly !== undefined) {
      patch.noteOnly = !!req.noteOnly;
      if (req.noteOnly) Object.assign(patch, { claimedBy: null, claimedAt: null });
    }
    this.store.updateThread(tid, patch);
    this.store.touchReviewUpdated(t.reviewId, patch.updatedAt!);
    this.afterThreadChange(tid);
    return this.getThread(tid, scope);
  }

  async deleteThread(tid: number): Promise<void> {
    const t = this.requireThread(tid);
    this.store.deleteThread(tid);
    this.store.touchReviewUpdated(t.reviewId, nowIso());
    this.broadcast(t.reviewId, () => ({ type: 'thread-deleted', threadId: tid }));
    this.refreshPresence();
  }

  async addMessage(tid: number, req: AddMessageRequest, scope?: ReviewScope): Promise<Thread> {
    const t = this.requireThread(tid);
    const body = this.validateBody(req?.body);
    const author = this.validateAuthor(req?.author);
    const now = nowIso();
    this.store.transaction(() => {
      this.store.insertMessage(tid, author.kind, author.name, body, now);
      const patch: Partial<ThreadRow> = { updatedAt: now };
      if (author.kind === 'agent') Object.assign(patch, { claimedBy: null, claimedAt: null });
      if (req.resolve) Object.assign(patch, { resolved: true, claimedBy: null, claimedAt: null });
      else if (author.kind === 'human' && t.resolved) patch.resolved = false; // a new question reopens the thread
      this.store.updateThread(tid, patch);
      this.store.touchReviewUpdated(t.reviewId, now);
    });
    this.afterThreadChange(tid);
    return this.getThread(tid, scope);
  }

  async editMessage(mid: number, body: string, scope?: ReviewScope): Promise<Thread> {
    const m = Number.isInteger(mid) ? this.store.getMessage(mid) : null;
    if (!m) throw notFound(`Message ${mid} not found.`);
    this.store.editMessage(mid, this.validateBody(body), nowIso());
    this.store.updateThread(m.threadId, { updatedAt: nowIso() });
    this.afterThreadChange(m.threadId);
    return this.getThread(m.threadId, scope);
  }

  async deleteMessage(mid: number, scope?: ReviewScope): Promise<Thread | { ok: true; threadDeleted: true }> {
    const m = Number.isInteger(mid) ? this.store.getMessage(mid) : null;
    if (!m) throw notFound(`Message ${mid} not found.`);
    if (this.store.messagesOf(m.threadId).length <= 1) {
      await this.deleteThread(m.threadId);
      return { ok: true, threadDeleted: true };
    }
    this.store.deleteMessage(mid);
    this.store.updateThread(m.threadId, { updatedAt: nowIso() });
    this.afterThreadChange(m.threadId);
    return this.getThread(m.threadId, scope);
  }

  /** Emits the thread, wakes waiters and updates presence. */
  private afterThreadChange(tid: number): void {
    const t = this.store.getThread(tid);
    if (t) this.emitThread(tid);
    this.wakeWaiters();
    this.refreshPresence();
  }

  // ================================================================ events

  private broadcast(reviewId: string | null, make: (sub: Subscriber) => ServerEvent | null, scope?: ReviewScope): void {
    for (const sub of this.subscribers) {
      if (reviewId !== null && sub.reviewId !== reviewId) continue;
      if (scope && sub.scope !== scope) continue;
      const ev = make(sub);
      if (ev) {
        try {
          sub.send(ev);
        } catch {
          /* a closed stream; it unsubscribes on close */
        }
      }
    }
  }

  private emitThread(tid: number, state?: ReviewState): void {
    const t = this.store.getThread(tid);
    if (!t) return;
    const subs = [...this.subscribers].filter((s) => s.reviewId === t.reviewId);
    if (!subs.length) return;
    const st = state ?? this.states.get(t.reviewId) ?? null;
    const msgs = this.store.messagesOf(tid);
    this.broadcast(t.reviewId, (sub) => ({ type: 'thread', thread: this.toThread(t, sub.scope, st, msgs) }));
  }

  /** Subscribes to a review's events. Starts live diff polling while anyone listens. */
  async subscribe(reviewId: string, scope: ReviewScope, send: (ev: ServerEvent) => void): Promise<() => void> {
    const state = await this.compute(reviewId);
    this.checkScope(state, scope);
    const sub: Subscriber = { reviewId, scope, send, lastFingerprint: state.fingerprints[scope] ?? null };
    this.subscribers.add(sub);
    send({ type: 'agents', agents: this.agents() });
    if (!this.pollers.has(reviewId)) {
      const poller = {
        busy: false,
        timer: setInterval(() => {
          if (poller.busy || this.closed) return;
          poller.busy = true;
          this.compute(reviewId)
            .then((s) => {
              for (const sb of this.subscribers) {
                if (sb.reviewId !== reviewId) continue;
                const fp = s.fingerprints[sb.scope] ?? null;
                if (fp !== sb.lastFingerprint) {
                  sb.lastFingerprint = fp;
                  try {
                    sb.send({ type: 'diff-changed', diffFingerprint: fp ?? '' });
                  } catch {
                    /* closed */
                  }
                }
              }
            })
            .catch(() => {})
            .finally(() => (poller.busy = false));
        }, this.pollMs),
      };
      this.pollers.set(reviewId, poller);
    }
    return () => {
      this.subscribers.delete(sub);
      if (![...this.subscribers].some((s) => s.reviewId === reviewId)) {
        const p = this.pollers.get(reviewId);
        if (p) clearInterval(p.timer);
        this.pollers.delete(reviewId);
      }
    };
  }

  // ================================================================ agents

  agents(): AgentPresence[] {
    const now = Date.now();
    const map = new Map<string, AgentPresence>();
    for (const w of this.waiters) {
      const cur = map.get(w.agent);
      if (!cur || w.since < cur.since) map.set(w.agent, { name: w.agent, state: 'waiting', since: w.since });
    }
    for (const [name, l] of this.lingering) {
      if (l.until < now) this.lingering.delete(name);
      else if (!map.has(name)) map.set(name, { name, state: 'waiting', since: l.since });
    }
    for (const t of this.store.allThreads()) {
      if (!t.claimedBy || !this.claimValid(t) || t.resolved) continue;
      if (map.has(t.claimedBy)) continue;
      map.set(t.claimedBy, { name: t.claimedBy, state: 'working', since: new Date(t.claimedAt!).toISOString() });
    }
    return [...map.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  private refreshPresence(): void {
    const list = this.agents();
    const key = JSON.stringify(list.map((a) => [a.name, a.state]));
    if (key === this.presenceKey) return;
    this.presenceKey = key;
    this.broadcast(null, () => ({ type: 'agents', agents: list }));
  }

  /** Threads this agent should receive now; claims them. Synchronous, so two waiters never take the same thread. */
  private takeDeliverable(agent: string, reviewId: string | null): ThreadRow[] {
    const rows = reviewId ? this.store.threadsOfReview(reviewId) : this.store.allThreads();
    const out: ThreadRow[] = [];
    const now = Date.now();
    for (const t of rows) {
      if (t.resolved || t.noteOnly) continue;
      const msgs = this.store.messagesOf(t.id);
      const last = msgs[msgs.length - 1];
      if (!last || last.authorKind !== 'human') continue;
      const valid = this.claimValid(t);
      if (valid && !(t.claimedBy === agent && last.id > t.deliveredUpTo)) continue;
      this.store.updateThread(t.id, { claimedBy: agent, claimedAt: now, deliveredUpTo: last.id });
      out.push({ ...t, claimedBy: agent, claimedAt: now, deliveredUpTo: last.id });
    }
    return out;
  }

  async agentThread(t: ThreadRow, state?: ReviewState): Promise<AgentThread> {
    const st = state ?? (await this.freshState(t.reviewId, 1000));
    const found = this.findForThread(t, st);
    const scope = found?.scope ?? t.homeScope;
    const thread = this.toThread(t, scope, st);
    let diffContext: string | null = null;
    if (found && !t.outdated && t.startLine !== null && t.endLine !== null && found.id) {
      const files = await this.fullFiles(st, scope);
      const f = files.find((x) => x.path === displayPath(found.entry));
      const lines = await this.blobLines(found.id);
      diffContext = renderDiffContext(f ?? null, found.isNew ? 'new' : 'old', t.startLine, t.endLine, lines);
    }
    return {
      thread,
      review: { id: st.review.id, title: st.review.title, spec: st.review.spec, from: st.resolved.from, to: st.resolved.to },
      repoRoot: this.repo.root,
      diffContext,
    };
  }

  private async buildAgentThreads(rows: ThreadRow[]): Promise<AgentThread[]> {
    const out: AgentThread[] = [];
    const states = new Map<string, ReviewState>();
    for (const r of rows) {
      let st = states.get(r.reviewId);
      if (!st) {
        st = await this.freshState(r.reviewId, 1000);
        states.set(r.reviewId, st);
      }
      out.push(await this.agentThread(this.store.getThread(r.id) ?? r, st));
    }
    return out;
  }

  async agentThreads(reviewId: string | null, filter: 'open' | 'pending' | 'all'): Promise<AgentThread[]> {
    if (reviewId) this.requireReview(reviewId);
    // Re-anchor first so positions are current.
    const ids = reviewId ? [reviewId] : this.store.listReviews().map((r) => r.id);
    for (const id of ids) await this.freshState(id, 1000).catch(() => null);
    const rows = (reviewId ? this.store.threadsOfReview(reviewId) : this.store.allThreads()).filter((t) => {
      if (filter === 'all') return true;
      if (filter === 'open') return !t.resolved;
      return this.agentStateOf(t, this.store.messagesOf(t.id)).state === 'pending';
    });
    return this.buildAgentThreads(rows);
  }

  async agentThreadById(tid: number): Promise<AgentThread> {
    const t = this.requireThread(tid);
    await this.freshState(t.reviewId, 1000);
    return this.agentThread(this.store.getThread(tid)!);
  }

  async wait(agent: string, timeoutMs: number, reviewId: string | null, signal?: AbortSignal): Promise<WaitResponse> {
    if (!agent) throw badRequest('Missing agent name.');
    if (reviewId) this.requireReview(reviewId);
    const now = this.takeDeliverable(agent, reviewId);
    if (now.length) {
      for (const t of now) this.emitThread(t.id);
      this.refreshPresence();
      return { threads: await this.buildAgentThreads(now), timedOut: false };
    }
    const since = nowIso();
    const rows = await new Promise<ThreadRow[] | null>((resolve) => {
      let done = false;
      const finish = (r: ThreadRow[] | null, linger = false) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        this.waiters.delete(w);
        // Between a timeout and the next `wait` the agent is still there: keep it visible briefly.
        if (linger && this.lingerMs > 0) {
          this.lingering.set(agent, { since, until: Date.now() + this.lingerMs });
          setTimeout(() => this.refreshPresence(), this.lingerMs + 50).unref();
        }
        resolve(r);
      };
      const w: Waiter = { agent, reviewId, since, deliver: (r) => finish(r) };
      const timer = setTimeout(() => finish(null, true), timeoutMs);
      signal?.addEventListener('abort', () => finish(null));
      this.waiters.add(w);
      this.refreshPresence();
    });
    this.refreshPresence();
    if (!rows || !rows.length) return { threads: [], timedOut: true };
    for (const t of rows) this.emitThread(t.id);
    return { threads: await this.buildAgentThreads(rows), timedOut: false };
  }

  private wakeWaiters(): void {
    for (const w of [...this.waiters]) {
      const rows = this.takeDeliverable(w.agent, w.reviewId);
      if (rows.length) w.deliver(rows);
    }
  }

  release(agent: string): number {
    let n = 0;
    for (const t of this.store.allThreads()) {
      if (t.claimedBy !== agent) continue;
      this.store.updateThread(t.id, { claimedBy: null, claimedAt: null });
      this.emitThread(t.id);
      n++;
    }
    this.wakeWaiters();
    this.refreshPresence();
    return n;
  }

  private expireClaims(): void {
    let any = false;
    for (const t of this.store.allThreads()) {
      if (!t.claimedBy || this.claimValid(t)) continue;
      this.store.updateThread(t.id, { claimedBy: null, claimedAt: null });
      this.emitThread(t.id);
      any = true;
    }
    if (any) this.wakeWaiters();
    this.refreshPresence();
  }
}
