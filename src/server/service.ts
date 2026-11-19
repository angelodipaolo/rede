import fs from 'node:fs';
import path from 'node:path';
import type {
  AddMessageRequest,
  AgentPresence,
  AgentState,
  AgentThread,
  Anchor,
  CreateThreadRequest,
  DiffFile,
  FileContent,
  HistoryEntry,
  HistoryPage,
  HistoryReviewRef,
  Message,
  RepoInfo,
  Review,
  ReviewMode,
  ReviewBatch,
  ReviewScope,
  ReviewSpec,
  ReviewSummary,
  ServerEvent,
  Side,
  SinceViewed,
  SubmitReviewRequest,
  Thread,
  ThreadOriginal,
  UpdateThreadRequest,
  WaitResponse,
} from '../shared/types.ts';
import { capture, reanchor, splitLines } from './anchor.ts';
import {
  countLines,
  diffBlobs,
  diffHunks,
  diffMeta,
  fileFingerprint,
  fingerprintOfRaw,
  MAX_FILE_BYTES,
  publicFile,
  publicMeta,
  rawDiff,
  sha1,
  type FileDiff,
  type FileMeta,
  type RawEntry,
} from './diff.ts';
import { badRequest, HttpError, notFound } from './errors.ts';
import {
  catFileBatch,
  currentBranch,
  EMPTY_TREE,
  gitLine,
  hashObject,
  headAndTree,
  redeDir,
  mergeBase,
  missingObjects,
  readHeadSync,
  resolveCommit,
  useObjectStore,
  treeOf,
  type RepoPaths,
} from './git.ts';
import { IndexTreeReader, WorkingSnapshotter } from './snapshot.ts';
import type { BatchRow, MessageRow, ReviewRow, Store, Target, ThreadRow } from './store.ts';
import { captureOriginal, renderDiffContext } from './context.ts';

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

export interface RedeOptions {
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

export interface HistoryQuery {
  q?: string;
  review?: string;
  state?: 'open' | 'resolved' | 'all';
  mode?: ReviewMode;
  since?: string;
  before?: string;
  limit?: number;
}

/** Loose objects in Rede's private object directory above which it is emptied at start. */
const PRIVATE_OBJECTS_MAX = 20_000;

/**
 * Sets up Rede's private object directory (<rede dir>/objects). Snapshots write their
 * blobs and trees there, never into the repository's object store, so a review that polls a
 * changing working tree adds no loose objects to the repository and never triggers its auto gc.
 * Nothing in the repository refers to these objects, so Rede can delete them: at start, when
 * there are many, it empties the directory together with the private index files that point
 * into it. Must run before any snapshot (no in-memory state refers to old objects yet).
 */
function prepareObjectStore(repo: RepoPaths, dir: string): void {
  const objects = path.join(dir, 'objects');
  let count = 0;
  try {
    for (const sub of fs.readdirSync(objects)) if (/^[0-9a-f]{2}$/.test(sub)) count += fs.readdirSync(path.join(objects, sub)).length;
    // Bulk check-ins write one pack each; count a pack like many loose objects.
    count += fs.readdirSync(path.join(objects, 'pack')).filter((f) => f.endsWith('.pack')).length * 500;
  } catch {
    /* not there yet */
  }
  if (count > PRIVATE_OBJECTS_MAX) {
    fs.rmSync(objects, { recursive: true, force: true });
    for (const f of ['snapshot.index', 'staged.index']) fs.rmSync(path.join(dir, f), { force: true });
  }
  fs.mkdirSync(objects, { recursive: true });
  useObjectStore(repo.root, objects, path.join(repo.commonDir, 'objects'));
}

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
    pending: m.pending,
    batchId: m.batchId,
    id: m.id,
    author: { kind: m.authorKind, name: m.authorName },
    body: m.body,
    createdAt: m.createdAt,
    editedAt: m.editedAt,
  };
}

function toBatch(b: BatchRow): ReviewBatch {
  return { id: b.id, reviewId: b.reviewId, mode: b.mode, body: b.body, submittedAt: b.submittedAt, threadIds: b.threadIds, head: b.head, branch: b.branch };
}

/**
 * The live-view rule: a thread that is resolved and outdated, with no pending message, is a finished
 * conversation about code that is gone. It leaves the diff view and lives in History. It is never
 * deleted; a new message or the code coming back returns it to the diff view.
 */
export function isArchived(t: Pick<ThreadRow, 'resolved' | 'outdated'>, msgs: Pick<MessageRow, 'pending'>[]): boolean {
  return t.resolved && t.outdated && !msgs.some((m) => m.pending);
}

/** Threads of a batch that got an agent message after the batch's last message in that thread. */
function answeredIn(b: BatchRow, msgsOf: (tid: number) => MessageRow[] | undefined): number {
  let n = 0;
  for (const tid of b.threadIds) {
    const msgs = msgsOf(tid) ?? [];
    let last = -1;
    for (const m of msgs) if (m.batchId === b.id) last = m.id;
    if (last >= 0 && msgs.some((m) => m.authorKind === 'agent' && m.id > last)) n++;
  }
  return n;
}

/** Cursor of a history entry: its time, then a key that orders entries of the same time. */
function historyKey(e: { at: string; key: string }): string {
  return `${e.at}|${e.key}`;
}

/** Messages an agent can see: pending ones wait in the human's review in progress. */
const submitted = (msgs: MessageRow[]) => msgs.filter((m) => !m.pending);

/** The batch of the latest submitted human message, or null for a one-off (or no human message). */
function batchOfLatest(msgs: MessageRow[]): number | null {
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i]!;
    if (m.pending || m.authorKind !== 'human') continue;
    return m.batchId;
  }
  return null;
}

/** Text of blobs by id. Blobs never change, so a plain bounded cache is safe. */
const textCache = new Map<string, Buffer>();

export class Rede {
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
  /** A computation that is queued and not started yet. Callers that arrive meanwhile share it. */
  private computeQueued = new Map<string, Promise<ReviewState>>();
  /** Working-tree blob ids known to exist (see snapshotObjectsExist). */
  private verified = new Set<string>();
  private packStamp = '';
  private anchoredKey = new Map<string, string>();
  private subscribers = new Set<Subscriber>();
  private pollers = new Map<string, { timer: NodeJS.Timeout; busy: boolean }>();
  private waiters = new Set<Waiter>();
  private lingering = new Map<string, { since: string; until: number }>();
  private presenceKey = '';
  /** Last pending count sent to browsers, per review. */
  private pendingSent = new Map<string, number>();
  private timers: NodeJS.Timeout[] = [];
  private closed = false;
  /** Called on any API activity; the server uses it for idle shutdown. */
  onActivity: () => void = () => {};
  /** Called when a review or its threads changed (the hub refreshes the dashboard). */
  onChange: (reviewId: string | null) => void = () => {};
  /** Id of this worktree in the hub (see WorkspaceInfo). */
  workspaceId = '';

  constructor(opts: RedeOptions) {
    this.repo = opts.repo;
    this.store = opts.store;
    this.version = opts.version;
    this.claimTimeoutMs = opts.claimTimeoutMs ?? 15 * 60_000;
    this.pollMs = opts.pollMs ?? 2000;
    this.lingerMs = opts.presenceLingerMs ?? 5000;
    const dir = redeDir(opts.repo);
    prepareObjectStore(opts.repo, dir);
    this.snapshotter = new WorkingSnapshotter(opts.repo.root, opts.repo.gitDir, dir);
    this.indexReader = new IndexTreeReader(opts.repo.root, opts.repo.gitDir, dir);
    const t = setInterval(() => this.expireClaims(), Math.min(10_000, Math.max(200, this.claimTimeoutMs / 4)));
    t.unref();
    this.timers.push(t);
  }

  close(): void {
    this.closed = true;
    useObjectStore(this.repo.root, null);
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
    // Read HEAD directly (no process) when it is a plain symbolic ref; else ask git.
    let branch: string | null | undefined;
    try {
      const head = fs.readFileSync(path.join(this.repo.gitDir, 'HEAD'), 'utf8').trim();
      if (/^[0-9a-f]{40,64}$/.test(head)) branch = null;
      else if (head.startsWith('ref: refs/heads/') && head !== 'ref: refs/heads/.invalid') branch = head.slice('ref: refs/heads/'.length);
    } catch {
      /* fall back to git */
    }
    if (branch === undefined) branch = await currentBranch(this.cwd);
    return { root: this.repo.root, name, branch };
  }

  // ================================================================ reviews

  summary(r: ReviewRow): ReviewSummary {
    return {
      id: r.id,
      spec: r.spec,
      title: r.title,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
      ...this.store.threadCounts(r.id),
      summary: r.summary,
      publishedBy: r.publishedKind && r.publishedName ? { kind: r.publishedKind, name: r.publishedName } : null,
      readyAt: r.readyAt,
      ackedAt: r.ackedAt,
      awaiting: !!r.readyAt && (!r.ackedAt || r.ackedAt < r.readyAt),
      agentReplies: this.store.agentReplyCount(r.id),
    };
  }

  /** An agent sets the change summary and marks the review ready for human review. */
  publish(id: string, req: { summary?: unknown; author?: unknown; ready?: unknown }): ReviewSummary {
    this.requireReview(id);
    if (typeof req?.summary !== 'string') throw badRequest('Missing summary.');
    const summary = req.summary.trim();
    if (!summary) throw badRequest('The summary is empty.');
    if (summary.length > 20_000) throw badRequest('The summary is too long (20,000 characters at most).');
    const author = this.validateAuthor(req.author);
    this.store.publishReview(id, summary, author, req.ready !== false, nowIso());
    this.onChange(id);
    return this.summary(this.store.getReview(id)!);
  }

  /** The human has seen the review: it no longer waits (until an agent publishes it again). */
  ack(id: string): ReviewSummary {
    const r = this.requireReview(id);
    if (r.readyAt && (!r.ackedAt || r.ackedAt < r.readyAt)) {
      this.store.ackReview(id, nowIso());
      this.onChange(id);
    }
    return this.summary(this.store.getReview(id)!);
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
    const existed = !!this.store.getReview(id);
    const row = this.store.upsertReview(id, norm, title, nowIso());
    if (!existed) this.onChange(id);
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
        // The snapshot is the slow part: start it first, read HEAD and the index meanwhile.
        const worktreeP = this.snapshotter.snapshot();
        worktreeP.catch(() => {});
        const { head, tree: oldTree } = await headAndTree(cwd);
        const [index, worktree] = await Promise.all([this.indexReader.read(oldTree), worktreeP]);
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
    const queued = this.computeQueued.get(id);
    if (queued) return queued;
    const prev = this.computeChains.get(id) ?? Promise.resolve();
    const run = async (): Promise<ReviewState> => {
      this.computeQueued.delete(id);
      const review = this.requireReview(id);
      let { trees, resolved, scopes } = await this.resolveTrees(review);
      let raw: ReviewState['raw'] = {};
      const fingerprints: ReviewState['fingerprints'] = {};
      const diffScopes = async () => {
        raw = {};
        await Promise.all(
          scopes.map(async (sc) => {
            const sides = SCOPE_SIDES[sc];
            const tree = (t: Target) => (t === 'index' ? trees.index : trees[t])!;
            const entries = await rawDiff(this.cwd, tree(sides.old), tree(sides.new));
            raw[sc] = entries;
            fingerprints[sc] = fingerprintOfRaw(entries);
          }),
        );
      };
      await diffScopes();
      if (resolved.to === null && !(await this.snapshotObjectsExist(raw, scopes))) {
        // The private index points at objects that git gc removed: rebuild the snapshot once.
        await this.snapshotter.reset();
        ({ trees, resolved, scopes } = await this.resolveTrees(review));
        await diffScopes();
      }
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
    this.computeQueued.set(id, p);
    this.computeChains.set(
      id,
      p.catch(() => {}),
    );
    return p;
  }

  /**
   * The private snapshot index trusts its stat cache, so it can point at a blob that the
   * user's `git gc` pruned (content that was staged once and is unreachable now). Checks the
   * working-tree blobs of the diff. Ids checked once are not checked again until a gc changes
   * the pack directory.
   */
  private async snapshotObjectsExist(raw: ReviewState['raw'], scopes: ReviewScope[]): Promise<boolean> {
    let stamp = '';
    try {
      stamp = String(fs.statSync(path.join(this.repo.commonDir, 'objects', 'pack')).mtimeMs);
    } catch {
      /* no pack dir */
    }
    if (stamp !== this.packStamp || this.verified.size > 200_000) {
      this.verified.clear();
      this.packStamp = stamp;
    }
    const ids = new Set<string>();
    for (const sc of scopes) {
      if (SCOPE_SIDES[sc].new !== 'new') continue;
      for (const e of raw[sc] ?? []) {
        const s = sideOf(e, true);
        if (s.id && !this.verified.has(s.id) && !e.newMode.startsWith('160')) ids.add(s.id);
      }
    }
    if (!ids.size) return true;
    const missing = await missingObjects(this.cwd, [...ids]);
    if (missing.length) return false;
    for (const id of ids) this.verified.add(id);
    return true;
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

  /** File metadata of one scope (no hunks). Cached per tree pair. */
  metaFiles(state: ReviewState, scope: ReviewScope): Promise<FileMeta[]> {
    const [a, b] = this.scopeTrees(state, scope);
    return diffMeta(this.cwd, a, b);
  }

  /** Files with hunks, for some files of one scope. Cached per blob pair. */
  withHunks(state: ReviewState, scope: ReviewScope, files: FileMeta[]): Promise<FileDiff[]> {
    const [a, b] = this.scopeTrees(state, scope);
    return diffHunks(this.cwd, a, b, files);
  }

  private viewedFlags<T extends { path: string; fingerprint: string }>(f: T, viewed: Map<string, { fingerprint: string }>): { viewed: boolean; changedSinceViewed: boolean } {
    const v = viewed.get(f.path);
    return { viewed: !!v && v.fingerprint === f.fingerprint, changedSinceViewed: !!v && v.fingerprint !== f.fingerprint };
  }

  /** True while a browser has the review open (the live poller then keeps its state fresh). */
  isLive(id: string): boolean {
    return this.pollers.has(id);
  }

  /**
   * @param maxAgeMs reuse a state computed this recently (0: always recompute). The HTTP layer
   *   passes 1000 while a browser has the review open: the 2 s poller then pushes diff-changed
   *   for anything newer.
   */
  async getReview(id: string, scope: ReviewScope = 'all', maxAgeMs = 0): Promise<Review> {
    const [state, repo] = await Promise.all([maxAgeMs > 0 ? this.freshState(id, maxAgeMs) : this.compute(id), this.repoInfo()]);
    this.checkScope(state, scope);
    this.store.touchReviewOpened(id, nowIso());
    const files = await this.metaFiles(state, scope);
    const viewed = this.store.viewedOf(id, scope);
    const out = files.map((f) => ({ ...publicMeta(f), ...this.viewedFlags(f, viewed) }));
    const scopeFileCounts: Review['scopeFileCounts'] = {};
    for (const sc of state.scopes) scopeFileCounts[sc] = state.raw[sc]?.length ?? 0;
    return {
      ...this.summary(this.store.getReview(id)!),
      repo,
      scope,
      scopes: state.scopes,
      scopeFileCounts,
      resolved: state.resolved,
      diffFingerprint: state.fingerprints[scope] ?? '',
      files: out,
      ...this.liveThreads(id, scope, state),
      batches: this.store.batchesOf(id).map(toBatch),
      pendingCount: this.store.pendingCount(id),
      agents: this.agents(),
    };
  }

  /** The threads of the diff view (the live-view rule, see isArchived) and how many were left out. */
  private liveThreads(id: string, scope: ReviewScope, state: ReviewState): { threads: Thread[]; archivedCount: number } {
    const threads: Thread[] = [];
    let archivedCount = 0;
    for (const t of this.store.threadsOfReview(id)) {
      const th = this.toThread(t, scope, state);
      if (th.archived) archivedCount++;
      else threads.push(th);
    }
    return { threads, archivedCount };
  }

  /** Files with hunks for the given new-side paths. Unknown paths are skipped. */
  async hunks(id: string, scope: ReviewScope, paths: unknown): Promise<DiffFile[]> {
    if (!Array.isArray(paths) || paths.some((p) => typeof p !== 'string')) throw badRequest('paths must be an array of strings.');
    if (paths.length > 200) throw badRequest('At most 200 paths per request.');
    const state = await this.freshState(id, 1000);
    this.checkScope(state, scope);
    const metas = await this.metaFiles(state, scope);
    const byPath = new Map(metas.map((f) => [f.path, f]));
    const want = [...new Set(paths as string[])].flatMap((p) => (byPath.has(p) ? [byPath.get(p)!] : []));
    const files = await this.withHunks(state, scope, want);
    const viewed = this.store.viewedOf(id, scope);
    return files.map((f) => ({ ...publicFile(f), ...this.viewedFlags(f, viewed) }));
  }

  /** The trees of one scope, for streaming the patch. */
  async scopeTreesOf(id: string, scope: ReviewScope): Promise<[string, string]> {
    const state = await this.freshState(id, 1000);
    this.checkScope(state, scope);
    return this.scopeTrees(state, scope);
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
        if (t.outdatedReason !== 'file-gone') patch.outdatedReason = 'file-gone';
      } else {
        const hint = loc.entry.status === 'R' ? (loc.isNew ? loc.entry.oldPath : loc.entry.newPath) : t.pathHint;
        if (loc.path !== t.path) patch.path = loc.path;
        if (hint !== t.pathHint) patch.pathHint = hint;
        if (t.startLine === null || t.endLine === null) {
          if (t.outdated) Object.assign(patch, { outdated: false, outdatedReason: null });
        } else {
          const lines = splitLines((blobs.get(loc.id) ?? Buffer.alloc(0)).toString('utf8'));
          const start = reanchor(lines, { snippet: t.snippet, ctxBefore: t.ctxBefore, ctxAfter: t.ctxAfter }, t.startLine);
          if (start === null) {
            if (!t.outdated) patch.outdated = true;
            if (t.outdatedReason !== 'changed' || !t.outdated) patch.outdatedReason = 'changed';
          } else {
            if (t.outdated) Object.assign(patch, { outdated: false, outdatedReason: null });
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

  /** Computed from submitted messages only: pending messages are invisible to agents. */
  private agentStateOf(t: ThreadRow, msgs: MessageRow[]): { state: AgentState; claimedBy: string | null } {
    const sent = submitted(msgs);
    const last = sent[sent.length - 1];
    if (t.resolved || t.noteOnly || !last || last.authorKind === 'agent') return { state: 'idle', claimedBy: null };
    if (this.claimValid(t)) return { state: 'working', claimedBy: t.claimedBy };
    return { state: 'pending', claimedBy: null };
  }

  /**
   * Converts a thread row to the API shape, expressed in the given scope.
   * @param forAgent leave out pending messages (agents never see them).
   */
  toThread(t: ThreadRow, scope: ReviewScope, state: ReviewState | null, msgs = this.store.messagesOf(t.id), forAgent = false): Thread {
    let inScope = false;
    let viewScope: ReviewScope = t.homeScope;
    let loc = null as ReturnType<Rede['locate']>;
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
      original: t.original,
      outdated: t.outdated,
      outdatedReason: t.outdated ? (t.outdatedReason ?? 'changed') : null,
      resolved: t.resolved,
      archived: isArchived(t, msgs),
      noteOnly: t.noteOnly,
      agentState,
      mode: t.mode,
      claimedBy,
      messages: (forAgent ? submitted(msgs) : msgs).map(toMessage),
      createdAt: t.createdAt,
      updatedAt: t.updatedAt,
    };
  }

  private missingThread(tid: number): HttpError {
    return notFound(`Thread ${tid} not found. It may have been deleted. Run \`rede threads --all\` to list threads.`);
  }

  private requireThread(tid: number): ThreadRow {
    const t = Number.isInteger(tid) ? this.store.getThread(tid) : null;
    if (!t) throw this.missingThread(tid);
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

  /** Pending messages: human only, never in a note (a note is never sent). */
  private validatePending(pending: unknown, author: { kind: string }, noteOnly: boolean): boolean {
    if (!pending) return false;
    if (author.kind !== 'human') throw badRequest('Only the human reviewer can add pending messages. Agents reply at once.');
    if (noteOnly) throw badRequest('A private note is never sent to an agent, so it cannot be part of a review. Send it as a note, or as a comment.');
    return true;
  }

  async createThread(reviewId: string, scope: ReviewScope, req: CreateThreadRequest): Promise<Thread> {
    const body = this.validateBody(req?.body);
    const author = this.validateAuthor(req?.author);
    const pending = this.validatePending(req?.pending, author, !!req?.noteOnly);
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
    const { head, branch } = readHeadSync(this.repo);
    const original: ThreadOriginal = { side: a.side, lines: [], section: '', truncated: false, head, branch };
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
      // The code as the reviewer saw it: the diff lines around the anchor, for History and outdated threads.
      const meta = (await this.metaFiles(state, scope)).find((x) => x.path === displayPath(e));
      const f = meta ? (await this.withHunks(state, scope, [meta]))[0] : undefined;
      Object.assign(original, captureOriginal(f ?? null, a.side, start, end, lines));
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
        original,
        createdAt: now,
        updatedAt: now,
      });
      this.store.insertMessage(id, author.kind, author.name, body, now, pending);
      this.store.touchReviewUpdated(reviewId, now);
      return id;
    });
    this.afterThreadChange(tid);
    this.emitPending(reviewId);
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
      if (req.noteOnly && this.store.messagesOf(tid).some((m) => m.pending)) {
        throw badRequest('This thread has pending review comments. A private note is never sent: submit or remove them first.');
      }
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
    this.emitPending(t.reviewId);
    this.refreshPresence();
  }

  async addMessage(tid: number, req: AddMessageRequest, scope?: ReviewScope): Promise<Thread> {
    const t = this.requireThread(tid);
    const body = this.validateBody(req?.body);
    const author = this.validateAuthor(req?.author);
    const pending = this.validatePending(req?.pending, author, t.noteOnly);
    if (pending && req.resolve) throw badRequest('A pending message cannot resolve the thread. Resolve it after the review is submitted.');
    // A thread with only pending messages does not exist for agents yet.
    if (author.kind === 'agent' && !this.visibleToAgents(t)) throw this.missingThread(tid);
    const now = nowIso();
    this.store.transaction(() => {
      this.store.insertMessage(tid, author.kind, author.name, body, now, pending);
      const patch: Partial<ThreadRow> = { updatedAt: now };
      if (author.kind === 'agent') Object.assign(patch, { claimedBy: null, claimedAt: null });
      if (author.kind === 'human' && !pending) patch.mode = 'ask'; // a one-off message
      if (req.resolve) Object.assign(patch, { resolved: true, claimedBy: null, claimedAt: null });
      else if (author.kind === 'human' && !pending && t.resolved) patch.resolved = false; // a new question reopens the thread
      this.store.updateThread(tid, patch);
      this.store.touchReviewUpdated(t.reviewId, now);
    });
    this.afterThreadChange(tid);
    if (pending) this.emitPending(t.reviewId);
    return this.getThread(tid, scope);
  }

  /** False while the thread has only pending messages. */
  private visibleToAgents(t: ThreadRow, msgs = this.store.messagesOf(t.id)): boolean {
    return msgs.some((m) => !m.pending);
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
    if (m.pending) this.emitPending(this.store.getThread(m.threadId)!.reviewId);
    return this.getThread(m.threadId, scope);
  }

  // ================================================================ review batches

  /**
   * Submits the review in progress: every pending message of the review is released in one
   * transaction as one batch. Touched threads get the batch's mode, reopen, lose any claim and
   * become 'pending' for agents, so the whole batch goes to the next waiting agent at once.
   */
  submitReview(reviewId: string, req: SubmitReviewRequest): ReviewBatch {
    this.requireReview(reviewId);
    const mode = req?.mode;
    if (mode !== 'discuss' && mode !== 'implement') throw badRequest('mode must be "discuss" or "implement".');
    if (req.body !== undefined && typeof req.body !== 'string') throw badRequest('body must be a string.');
    const note = (req.body ?? '').trim();
    const now = nowIso();
    const { head, branch } = readHeadSync(this.repo);
    const batch = this.store.transaction(() => {
      const msgs = this.store.pendingMessages(reviewId);
      if (!msgs.length) throw badRequest('Nothing to submit: the review has no pending comments.');
      const threadIds = [...new Set(msgs.map((m) => m.threadId))].sort((a, b) => a - b);
      const row = { reviewId, mode, body: note, submittedAt: now, threadIds, head, branch };
      const id = this.store.insertBatch(row);
      this.store.releaseMessages(
        msgs.map((m) => m.id),
        id,
        now,
      );
      for (const tid of threadIds) {
        this.store.updateThread(tid, { mode, resolved: false, claimedBy: null, claimedAt: null, deliveredUpTo: 0, updatedAt: now });
      }
      this.store.touchReviewUpdated(reviewId, now);
      return { id, ...row };
    });
    for (const tid of batch.threadIds) this.emitThread(tid);
    this.pendingSent.set(reviewId, 0);
    const out = toBatch(batch);
    this.broadcast(reviewId, () => ({ type: 'batch', batch: out, pendingCount: 0 }));
    this.wakeWaiters();
    this.refreshPresence();
    return out;
  }

  /** Discards the review in progress: all pending messages, and threads left without messages. */
  discardPending(reviewId: string): { deleted: number[]; changed: number[] } {
    this.requireReview(reviewId);
    const now = nowIso();
    const res = this.store.transaction(() => {
      const msgs = this.store.pendingMessages(reviewId);
      for (const m of msgs) this.store.deleteMessage(m.id);
      const deleted: number[] = [];
      const changed: number[] = [];
      for (const tid of new Set(msgs.map((m) => m.threadId))) {
        if (this.store.messagesOf(tid).length === 0) {
          this.store.deleteThread(tid);
          deleted.push(tid);
        } else {
          this.store.updateThread(tid, { updatedAt: now });
          changed.push(tid);
        }
      }
      if (msgs.length) this.store.touchReviewUpdated(reviewId, now);
      return { deleted, changed };
    });
    for (const tid of res.deleted) this.broadcast(reviewId, () => ({ type: 'thread-deleted', threadId: tid }));
    for (const tid of res.changed) this.emitThread(tid);
    this.emitPending(reviewId);
    return res;
  }

  /** Sends the pending count to browsers when it changed. */
  private emitPending(reviewId: string): void {
    const n = this.store.pendingCount(reviewId);
    if (this.pendingSent.get(reviewId) === n) return;
    this.pendingSent.set(reviewId, n);
    this.broadcast(reviewId, () => ({ type: 'pending', pendingCount: n }));
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
    this.onChange(reviewId);
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
    this.onChange(t.reviewId);
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
    if (!this.pendingSent.has(reviewId)) this.pendingSent.set(reviewId, this.store.pendingCount(reviewId));
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

  // ================================================================ history

  /** Repo-wide review history, newest first. See HistoryPage in the contract. Reads stored state only. */
  history(query: HistoryQuery = {}): HistoryPage {
    const limit = Math.min(500, Math.max(1, Math.floor(Number(query.limit ?? 50)) || 50));
    const state = query.state ?? 'all';
    if (!['open', 'resolved', 'all'].includes(state)) throw badRequest('state must be open, resolved or all.');
    const mode = query.mode || null;
    if (mode && !['ask', 'discuss', 'implement'].includes(mode)) throw badRequest('mode must be ask, discuss or implement.');
    let since: string | null = null;
    if (query.since) {
      const t = Date.parse(query.since);
      if (Number.isNaN(t)) throw badRequest(`Invalid date "${query.since}". Use an ISO date such as 2026-11-01.`);
      since = new Date(t).toISOString();
    }
    const text = (query.q ?? '').trim().toLowerCase();
    const reviewFilter = query.review || null;

    const reviews = new Map(this.store.listReviews().map((r) => [r.id, r]));
    const ref = (id: string): HistoryReviewRef => {
      const r = reviews.get(id);
      return { id, title: r?.title ?? id, spec: r?.spec ?? { kind: 'working' } };
    };
    const threads = this.store.allThreads();
    const byId = new Map(threads.map((t) => [t.id, t]));
    const msgsBy = this.store.messagesByThread();
    const msgsOf = (tid: number) => msgsBy.get(tid) ?? [];
    // Threads with only pending messages belong to the review in progress, not to history.
    const visible = (t: ThreadRow) => msgsOf(t.id).some((m) => !m.pending);
    const stateOk = (t: ThreadRow) => state === 'all' || (state === 'open' ? !t.resolved : t.resolved);
    const textOk = (t: ThreadRow) =>
      !text ||
      t.path.toLowerCase().includes(text) ||
      (t.pathHint ?? '').toLowerCase().includes(text) ||
      msgsOf(t.id).some((m) => m.body.toLowerCase().includes(text));

    type Candidate = { at: string; key: string; build: () => HistoryEntry };
    const list: Candidate[] = [];
    const inBatch = new Set<number>();
    for (const b of this.store.allBatches()) {
      for (const tid of b.threadIds) inBatch.add(tid);
      if (reviewFilter && b.reviewId !== reviewFilter) continue;
      if (mode && mode !== b.mode) continue;
      if (since && b.submittedAt < since) continue;
      const own = b.threadIds.flatMap((tid) => {
        const t = byId.get(tid);
        return t && visible(t) ? [t] : [];
      });
      const noteHit = !!text && b.body.toLowerCase().includes(text);
      const shown = own.filter((t) => stateOk(t) && (noteHit || textOk(t)));
      if (!shown.length && !(state === 'all' && (!text || noteHit) && !own.length)) continue;
      list.push({
        at: b.submittedAt,
        key: `b${String(b.id).padStart(9, '0')}`,
        build: () => ({
          kind: 'batch',
          at: b.submittedAt,
          review: ref(b.reviewId),
          batch: toBatch(b),
          threads: shown.map((t) => this.toThread(t, t.homeScope, null, msgsOf(t.id))),
          counts: { threads: own.length, answered: answeredIn(b, msgsOf), resolved: own.filter((t) => t.resolved).length },
        }),
      });
    }
    for (const t of threads) {
      // A thread that got any message from a batch is shown under its batch(es).
      if (inBatch.has(t.id) || msgsOf(t.id).some((m) => m.batchId !== null) || !visible(t)) continue;
      if (reviewFilter && t.reviewId !== reviewFilter) continue;
      if (mode && mode !== 'ask') continue;
      if (since && t.createdAt < since) continue;
      if (!stateOk(t) || !textOk(t)) continue;
      list.push({
        at: t.createdAt,
        key: `t${String(t.id).padStart(9, '0')}`,
        build: () => ({ kind: 'thread', at: t.createdAt, review: ref(t.reviewId), thread: this.toThread(t, t.homeScope, null, msgsOf(t.id)) }),
      });
    }
    list.sort((a, b) => (historyKey(a) < historyKey(b) ? 1 : historyKey(a) > historyKey(b) ? -1 : 0));
    const start = query.before ? list.findIndex((e) => historyKey(e) < query.before!) : 0;
    const from = start < 0 ? list.length : start;
    const page = list.slice(from, from + limit);
    const more = from + limit < list.length;
    return { entries: page.map((e) => e.build()), next: more && page.length ? historyKey(page[page.length - 1]!) : null, total: list.length };
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
      const msgs = submitted(this.store.messagesOf(t.id));
      const last = msgs[msgs.length - 1];
      if (!last || last.authorKind !== 'human') continue;
      const valid = this.claimValid(t);
      if (valid && !(t.claimedBy === agent && last.id > t.deliveredUpTo)) continue;
      this.store.updateThread(t.id, { claimedBy: agent, claimedAt: now, deliveredUpTo: last.id });
      out.push({ ...t, claimedBy: agent, claimedAt: now, deliveredUpTo: last.id });
    }
    // Batches first, each one's threads together, then one-off threads.
    const key = (t: ThreadRow) => batchOfLatest(this.store.messagesOf(t.id)) ?? Number.MAX_SAFE_INTEGER;
    const keys = new Map(out.map((t) => [t.id, key(t)]));
    return out.sort((a, b) => keys.get(a.id)! - keys.get(b.id)! || a.id - b.id);
  }

  async agentThread(t: ThreadRow, state?: ReviewState): Promise<AgentThread> {
    const st = state ?? (await this.freshState(t.reviewId, 1000));
    const found = this.findForThread(t, st);
    const scope = found?.scope ?? t.homeScope;
    const msgs = this.store.messagesOf(t.id);
    const thread = this.toThread(t, scope, st, msgs, true);
    let diffContext: string | null = null;
    if (found && !t.outdated && t.startLine !== null && t.endLine !== null && found.id) {
      const meta = (await this.metaFiles(st, scope)).find((x) => x.path === displayPath(found.entry));
      const f = meta ? (await this.withHunks(st, scope, [meta]))[0] : undefined;
      const lines = await this.blobLines(found.id);
      diffContext = renderDiffContext(f ?? null, found.isNew ? 'new' : 'old', t.startLine, t.endLine, lines);
    }
    return {
      thread,
      review: { id: st.review.id, title: st.review.title, spec: st.review.spec, from: st.resolved.from, to: st.resolved.to },
      repoRoot: this.repo.root,
      workspace: this.workspaceId || undefined,
      diffContext,
      batchId: batchOfLatest(msgs),
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
      if (!this.visibleToAgents(t)) return false;
      if (filter === 'all') return true;
      if (filter === 'open') return !t.resolved;
      return this.agentStateOf(t, this.store.messagesOf(t.id)).state === 'pending';
    });
    return this.buildAgentThreads(rows);
  }

  async agentThreadById(tid: number): Promise<AgentThread> {
    const t = this.requireThread(tid);
    if (!this.visibleToAgents(t)) throw this.missingThread(tid);
    await this.freshState(t.reviewId, 1000);
    return this.agentThread(this.store.getThread(tid)!);
  }

  async wait(agent: string, timeoutMs: number, reviewId: string | null, signal?: AbortSignal): Promise<WaitResponse> {
    if (!agent) throw badRequest('Missing agent name.');
    if (reviewId) this.requireReview(reviewId);
    if (signal?.aborted) return { threads: [], batches: [], timedOut: true };
    const now = this.takeDeliverable(agent, reviewId);
    if (now.length) return this.handOver(agent, now, signal);
    // timeout 0 (`rede inbox`): never block, and do not show the agent as waiting.
    if (timeoutMs <= 0) return { threads: [], batches: [], timedOut: true };
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
      signal?.addEventListener('abort', () => finish(null), { once: true });
      this.waiters.add(w);
      this.refreshPresence();
    });
    this.refreshPresence();
    if (!rows || !rows.length) return { threads: [], batches: [], timedOut: true };
    return this.handOver(agent, rows, signal);
  }

  /**
   * Builds the response for claimed threads. When the agent went away meanwhile (Ctrl-C, a
   * killed shell, a tool timeout), nobody will see them: the claims are given back at once
   * instead of blocking the threads for the claim timeout.
   */
  private async handOver(agent: string, rows: ThreadRow[], signal?: AbortSignal): Promise<WaitResponse> {
    for (const t of rows) this.emitThread(t.id);
    this.refreshPresence();
    let threads: AgentThread[];
    try {
      threads = await this.buildAgentThreads(rows);
    } catch (e) {
      this.unclaim(agent, rows);
      throw e;
    }
    if (signal?.aborted) {
      this.unclaim(agent, rows);
      return { threads: [], batches: [], timedOut: true };
    }
    const ids = [...new Set(threads.flatMap((t) => (t.batchId === null ? [] : [t.batchId])))];
    const batches = ids.flatMap((id) => {
      const b = this.store.getBatch(id);
      return b ? [toBatch(b)] : [];
    });
    return { threads, batches, timedOut: false };
  }

  /** Gives back claims taken by one hand-over, unless something changed them since. */
  unclaim(agent: string, rows: ThreadRow[]): void {
    for (const r of rows) {
      const cur = this.store.getThread(r.id);
      if (!cur || cur.claimedBy !== agent || cur.claimedAt !== r.claimedAt) continue;
      this.store.updateThread(r.id, { claimedBy: null, claimedAt: null, deliveredUpTo: 0 });
      this.emitThread(r.id);
    }
    this.wakeWaiters();
    this.refreshPresence();
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
