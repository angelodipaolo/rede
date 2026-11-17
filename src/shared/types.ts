/**
 * Margin: shared contract between the server, the CLI and the web UI.
 *
 * This file is the single source of truth for the HTTP API. The server
 * implements it, the web UI and the agent CLI consume it. Change it only
 * with a matching change on both sides.
 *
 * Transport: HTTP on 127.0.0.1, JSON bodies, UTF-8.
 * Errors: non-2xx status with body `ApiError`.
 */

// ---------------------------------------------------------------- authors

export type AuthorKind = 'human' | 'agent';

export interface Author {
  kind: AuthorKind;
  /** Display name. Human: "you". Agent: "claude", "codex", or any name the agent gives. */
  name: string;
}

// ---------------------------------------------------------------- reviews

/**
 * What a review compares.
 * - working: HEAD -> working tree (staged + unstaged + untracked, not ignored).
 * - branch:  merge-base(base, HEAD) -> working tree. This is the "pull request" view.
 *            It includes uncommitted changes, so fixes made during the review show up.
 * - commit:  commit^ -> commit.
 * - range:   from -> to (two revisions, no working tree).
 */
export type ReviewSpec =
  | { kind: 'working' }
  | { kind: 'branch'; base: string; head: string }
  | { kind: 'commit'; rev: string }
  | { kind: 'range'; from: string; to: string };

/**
 * Which part of the uncommitted changes a view shows. Applies to 'working' reviews only;
 * every other review kind has the single scope 'all'.
 *
 *   scope      old side      new side
 *   all        HEAD          working tree
 *   staged     HEAD          index
 *   unstaged   index         working tree
 *
 * A scope is a VIEW of one review, not a separate review. Threads belong to the review.
 * The server stores each thread against the content it was written on (HEAD, index or
 * working tree) and shows it in every scope where that content is one of the two sides.
 * Example: a thread written on the new side in 'all' (working tree) also shows on the new
 * side in 'unstaged'. A thread written on the new side in 'staged' (index) shows on the
 * old side in 'unstaged'. Viewed state is kept per scope.
 *
 * Endpoints that take a scope use the query parameter `scope` (default 'all'):
 * GET review, GET file, GET since-viewed, PUT viewed, POST threads, GET events.
 */
export type ReviewScope = 'all' | 'staged' | 'unstaged';

export interface ReviewSummary {
  /** Stable, URL-safe id derived from the spec. Example: "working", "branch-feature-x-vs-main". */
  id: string;
  spec: ReviewSpec;
  /** Short human title. Example: "feature-x → main", "Uncommitted changes". */
  title: string;
  createdAt: string;
  updatedAt: string;
  threadCount: number;
  unresolvedCount: number;
}

export interface Review extends ReviewSummary {
  repo: RepoInfo;
  /** The scope this response shows. */
  scope: ReviewScope;
  /** Scopes this review supports. ['all', 'staged', 'unstaged'] for working reviews, else ['all']. */
  scopes: ReviewScope[];
  /** Number of changed files in each supported scope. Lets the UI label the scope toggle. */
  scopeFileCounts: Partial<Record<ReviewScope, number>>;
  /** Resolved revisions for the current diff. `to` is null when the right side is the working tree. */
  resolved: { from: string; to: string | null };
  /** Changes when the diff content changes. The UI refetches when it sees a new value. */
  diffFingerprint: string;
  /** Metadata only. Load hunks with POST /api/reviews/:id/hunks. */
  files: DiffFileMeta[];
  threads: Thread[];
  /** Submitted batches of this review, oldest first. */
  batches: ReviewBatch[];
  /** Number of pending messages in the review in progress. */
  pendingCount: number;
  agents: AgentPresence[];
  /**
   * Threads of this review left out of `threads` because they are archived (resolved and
   * outdated, see Thread.archived). They are kept and shown in History (GET /api/history).
   */
  archivedCount: number;
}

export interface RepoInfo {
  /** Absolute path of the repository root. */
  root: string;
  /** Directory name of the root. */
  name: string;
  /** Current branch, or null when HEAD is detached. */
  branch: string | null;
}

// ------------------------------------------------------------------- diff

export type FileStatus = 'added' | 'deleted' | 'modified' | 'renamed';

/**
 * Scale target: 1,500 changed files and 25,000 changed lines must stay fast.
 * So the review response carries only per-file metadata. The UI loads hunks
 * on demand (POST hunks) for files near the viewport and caches them by
 * path + fingerprint. The server caches parsed per-file diffs by fingerprint,
 * so a change to one file does not re-diff the others.
 */
export interface DiffFileMeta {
  /** Path on the new side (old side path for deleted files). Repo-relative, forward slashes. */
  path: string;
  /** Previous path. Set only for renames. */
  oldPath?: string;
  status: FileStatus;
  binary: boolean;
  additions: number;
  deletions: number;
  /** True when the diff was too large and hunks were omitted. */
  tooLarge: boolean;
  /** Hash of this file's diff. Viewed state holds only while it stays the same. */
  fingerprint: string;
  /** True when the user marked the file as viewed and the fingerprint did not change since. */
  viewed: boolean;
  /**
   * True when the user marked the file as viewed, and the file's diff changed after that.
   * `viewed` is false in this case. The UI shows a "changed since viewed" badge and can
   * request only the new changes with GET /api/reviews/:id/since-viewed.
   */
  changedSinceViewed: boolean;
  /** Total line count of each side. Lets the UI expand context. 0 when the side does not exist. */
  oldLineCount: number;
  newLineCount: number;
}

export interface DiffFile extends DiffFileMeta {
  /** Empty for binary files and for files over the size limit. */
  hunks: Hunk[];
}

export interface Hunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  /** Text after the second "@@", normally the enclosing function. May be empty. */
  section: string;
  lines: DiffLine[];
}

export type DiffLineType = 'context' | 'add' | 'del';

export interface DiffLine {
  type: DiffLineType;
  /** 1-based line number on the old side. Absent for 'add'. */
  oldLine?: number;
  /** 1-based line number on the new side. Absent for 'del'. */
  newLine?: number;
  /** Line text without the +/-/space prefix and without the line terminator. */
  text: string;
}

// ---------------------------------------------------------------- threads

export type Side = 'old' | 'new';

/**
 * Where a thread attaches.
 * Lines are 1-based and inclusive, on the given side of the diff.
 * A file-level thread has startLine = endLine = null.
 */
export interface Anchor {
  path: string;
  side: Side;
  startLine: number | null;
  endLine: number | null;
}

/**
 * - idle:    nothing for an agent to do (resolved, note-only, or the agent spoke last).
 * - pending: the human spoke last. No agent took it yet.
 * - working: an agent received it through `wait` and has not replied yet.
 */
export type AgentState = 'idle' | 'pending' | 'working';

export interface Thread {
  /** Small integer, unique in the repo. The agent CLI uses it: `margin reply 12`. */
  id: number;
  reviewId: string;
  /**
   * Current position, expressed in the sides of the scope the response was requested in.
   * The server re-anchors it when the code moves.
   */
  anchor: Anchor;
  /**
   * False when the content this thread was written on is not a side of the requested scope
   * (example: a working-tree thread while the view is 'staged'). The UI does not render such
   * threads inline; it lists them in the threads panel with a control to switch scope.
   * `anchor` is then expressed in `homeScope`.
   */
  inScope: boolean;
  /** The scope the thread was created in. Switching to it always makes the thread visible. */
  homeScope: ReviewScope;
  /** The anchored lines as they were when the thread was created. */
  snippet: string[];
  /**
   * The code as it was when the thread was created: the diff lines around the anchor, and the
   * commit and branch checked out then. Null for threads created before Margin stored it; the UI
   * then falls back to `snippet`.
   */
  original: ThreadOriginal | null;
  /**
   * True when the server cannot find the anchored code in the current diff
   * (the lines changed or the file left the diff). The UI shows such threads
   * at the top of the file, or in a review-level list, with the snippet.
   */
  outdated: boolean;
  /**
   * Why the thread is outdated. 'changed': the file is in the diff but the anchored lines changed.
   * 'file-gone': the file is no longer in this diff. Null when not outdated.
   */
  outdatedReason: 'changed' | 'file-gone' | null;
  resolved: boolean;
  /**
   * The live-view rule. True when the thread is resolved, outdated, and has no pending message:
   * the conversation is finished and its code is gone. Archived threads are left out of
   * Review.threads (counted in Review.archivedCount) and live in History. A 'thread' event with
   * archived = true tells the UI to drop the thread from the diff view. Nothing is deleted: a
   * new message (it reopens the thread) or the code coming back brings it back.
   */
  archived: boolean;
  /** A private note. Agents never receive it through `wait`. */
  noteOnly: boolean;
  /**
   * Computed from submitted messages only. A thread that has only pending messages is 'idle'
   * and is hidden from every agent endpoint.
   */
  agentState: AgentState;
  /** How the agent must treat the latest human message: its batch's mode, or 'ask' for a one-off. */
  mode: ReviewMode;
  /** Name of the agent that holds the thread while agentState is 'working'. */
  claimedBy: string | null;
  messages: Message[];
  createdAt: string;
  updatedAt: string;
}

/**
 * Two ways for the human to talk to an agent.
 *
 * 1. One-off: a comment or reply that is sent at once (pending = false). The agent
 *    answers it as soon as it can. Its mode is 'ask': answer the question; change code
 *    only when the comment itself asks for a change.
 *
 * 2. Review: the human queues comments and replies as pending (pending = true). Agents
 *    never see pending messages. When the human submits the review, all pending messages
 *    of that review are released together as one ReviewBatch with a mode:
 *      'discuss'   : answer and discuss only. The agent must not change any code.
 *      'implement' : the agent changes the code to address each comment, then replies in
 *                    each thread with what it changed.
 *    A review has at most one set of pending messages (the review in progress).
 */
export type ReviewMode = 'ask' | 'discuss' | 'implement';

export interface ReviewBatch {
  /** Small integer, unique in the repo. */
  id: number;
  reviewId: string;
  mode: 'discuss' | 'implement';
  /** Optional overall note from the human to the agent. Markdown. May be empty. */
  body: string;
  submittedAt: string;
  /** Threads that received a message from this batch. */
  threadIds: number[];
  /** HEAD commit when the review was submitted. Null for batches stored before Margin kept it, or when HEAD did not resolve. */
  head: string | null;
  /** Branch checked out when the review was submitted. Null when HEAD was detached or unknown. */
  branch: string | null;
}

/** One line of the code snapshot of a thread. */
export interface OriginalLine extends DiffLine {
  /** True for the commented lines. */
  anchored: boolean;
}

/** The code a thread was written on, stored when the thread was created. */
export interface ThreadOriginal {
  /** Side of the anchor. */
  side: Side;
  /**
   * Diff lines around the anchor (the anchored lines plus up to 6 lines before and after) with
   * their old/new line numbers. When the anchor was on unchanged code outside every hunk, the lines
   * are 'context' lines with the line number of `side` only. Empty for file-level threads.
   */
  lines: OriginalLine[];
  /** Text after the second "@@" of the hunk (the enclosing function), when known. */
  section: string;
  /** True when a long anchor was cut to fit the bound. */
  truncated: boolean;
  /** HEAD commit at creation, or null when it did not resolve (no commits yet). */
  head: string | null;
  /** Branch checked out at creation, or null when HEAD was detached. */
  branch: string | null;
}

export interface Message {
  /** True while the message waits in the review in progress. Only human messages can be pending. */
  pending: boolean;
  /** The batch that released this message. Null for one-off messages and pending ones. */
  batchId: number | null;
  id: number;
  author: Author;
  /** Markdown. */
  body: string;
  createdAt: string;
  editedAt: string | null;
}

export interface AgentPresence {
  name: string;
  /** 'waiting': blocked in `wait`. 'working': holds one or more threads. */
  state: 'waiting' | 'working';
  since: string;
}

// ----------------------------------------------------------- HTTP: browser

/**
 * GET  /api/health                         -> Health
 * GET  /api/reviews                        -> ReviewSummary[]
 * POST /api/reviews            OpenReviewRequest   -> ReviewSummary   (create or reuse)
 * GET  /api/reviews/:id                    -> Review   (recomputes the diff, re-anchors threads)
 * POST /api/reviews/:id/hunks?scope=  HunksRequest -> DiffFile[]   (hunks for the given paths; unknown paths are skipped)
 * GET  /api/reviews/:id/file?path=&side=   -> FileContent   (full text of one side)
 * GET  /api/reviews/:id/since-viewed?path= -> SinceViewed   (what changed in one file after the user marked it viewed)
 * PUT  /api/reviews/:id/viewed  SetViewedRequest   -> { ok: true }
 * POST /api/reviews/:id/threads CreateThreadRequest -> Thread
 * GET  /api/threads/:tid                   -> Thread
 * PATCH /api/threads/:tid       UpdateThreadRequest -> Thread
 * DELETE /api/threads/:tid                 -> { ok: true }
 * POST /api/threads/:tid/messages  AddMessageRequest -> Thread
 * PATCH /api/messages/:mid      EditMessageRequest -> Thread
 * DELETE /api/messages/:mid                -> Thread   (deletes the thread too when it was the last message; then returns { ok: true, threadDeleted: true })
 * POST /api/reviews/:id/submit  SubmitReviewRequest -> ReviewBatch   (releases all pending messages; 400 when none)
 * DELETE /api/reviews/:id/pending          -> { ok: true }   (discards the review in progress: all pending messages, and threads left empty)
 * GET  /api/reviews/:id/events             -> text/event-stream of ServerEvent (one JSON per `data:` line)
 * GET  /api/history?q=&review=&state=&mode=&since=&before=&limit=   -> HistoryPage
 */

// ----------------------------------------------------------------- history

/**
 * Repo-wide review history: every submitted review (batch) and every one-off thread, across all
 * reviews, newest first. Reads stored state only (no diff is computed), so it stays fast with
 * thousands of threads. Threads that have only pending messages (the review in progress) are left out.
 *
 * Query parameters (all optional):
 *   q       case-insensitive text; matches message bodies, the batch note and file paths.
 *           A batch entry matches when its note matches (all its threads are kept) or when some
 *           of its threads match (only those are kept).
 *   review  a review id.
 *   state   'open' | 'resolved' | 'all' (default 'all'): filters threads; an entry without
 *           matching threads is left out.
 *   mode    'ask' | 'discuss' | 'implement': batch entries by batch mode; 'ask' selects one-off threads.
 *   since   ISO date or time: entries at or after it.
 *   before  the `next` cursor of the previous page.
 *   limit   entries per page, 1..500, default 50.
 */
export interface HistoryPage {
  entries: HistoryEntry[];
  /** Cursor for the next page (pass as `before`), or null at the end. */
  next: string | null;
  /** Entries that match the filters, over all pages. */
  total: number;
}

export interface HistoryReviewRef {
  id: string;
  title: string;
  spec: ReviewSpec;
}

/**
 * - batch:  one submitted review. `threads` are the threads that got a message from it (filtered);
 *           each thread carries its whole conversation. A thread that took part in two reviews
 *           appears under both.
 * - thread: a thread that never took part in a submitted review (one-off comments, notes, agent findings).
 * `at` is the batch submit time or the thread creation time; entries are ordered by it, newest first.
 */
export type HistoryEntry =
  | { kind: 'batch'; at: string; review: HistoryReviewRef; batch: ReviewBatch; threads: Thread[]; counts: HistoryCounts }
  | { kind: 'thread'; at: string; review: HistoryReviewRef; thread: Thread };

/** Over all threads of the batch, not only the ones that matched the filters. */
export interface HistoryCounts {
  threads: number;
  /** Threads with an agent message after the batch's last message in that thread. */
  answered: number;
  resolved: number;
}

export interface Health {
  ok: true;
  name: 'margin';
  version: string;
  repo: RepoInfo;
  pid: number;
}

export interface OpenReviewRequest {
  spec: ReviewSpec;
}

export interface HunksRequest {
  /** New-side paths (DiffFileMeta.path). At most 200 per request. */
  paths: string[];
}

export interface FileContent {
  path: string;
  side: Side;
  /** False when that side does not exist (added/deleted file). */
  exists: boolean;
  binary: boolean;
  text: string;
}

/**
 * Incremental review. The server snapshots the file content when the user marks it viewed.
 * `file` is a diff from that snapshot (old side) to the current content (new side).
 * New-side line numbers match the new side of the main diff. `file` is null when the
 * server has no snapshot or nothing changed.
 */
export interface SinceViewed {
  path: string;
  file: DiffFile | null;
}

export interface SetViewedRequest {
  path: string;
  viewed: boolean;
}

export interface SubmitReviewRequest {
  mode: 'discuss' | 'implement';
  /** Optional overall note. */
  body?: string;
}

export interface CreateThreadRequest {
  anchor: Anchor;
  body: string;
  author: Author;
  /** Queue in the review in progress instead of sending now. Human authors only. */
  pending?: boolean;
  noteOnly?: boolean;
}

export interface UpdateThreadRequest {
  resolved?: boolean;
  noteOnly?: boolean;
}

export interface AddMessageRequest {
  body: string;
  author: Author;
  /** Queue in the review in progress instead of sending now. Human authors only. */
  pending?: boolean;
  /** Convenience: resolve the thread with this message. */
  resolve?: boolean;
}

export interface EditMessageRequest {
  body: string;
}

export interface ApiError {
  error: string;
}

/**
 * Pushed over SSE to every browser that has the review open. Thread payloads and
 * diff-changed are expressed in the scope given on the events URL.
 */
export type ServerEvent =
  | { type: 'thread'; thread: Thread } // created or changed in any way
  | { type: 'thread-deleted'; threadId: number }
  | { type: 'batch'; batch: ReviewBatch; pendingCount: number } // a review was submitted
  | { type: 'pending'; pendingCount: number } // the review in progress changed size
  | { type: 'viewed'; path: string; viewed: boolean }
  | { type: 'diff-changed'; diffFingerprint: string } // the UI refetches the review
  | { type: 'agents'; agents: AgentPresence[] };

// ------------------------------------------------------------- HTTP: agent

/**
 * The agent CLI is a thin client over these endpoints plus the thread
 * endpoints above (with author.kind = 'agent').
 *
 * GET  /api/agent/wait?agent=<name>&timeout=<seconds>&review=<id?>  -> WaitResponse
 *      Long poll. Returns at once when pending threads exist. Otherwise holds
 *      the request until a thread becomes pending or the timeout passes.
 *      Returned threads move to agentState 'working', claimed by this agent.
 * GET  /api/agent/threads?review=<id?>&state=<open|pending|all>     -> AgentThread[]
 * GET  /api/agent/threads/:tid                                      -> AgentThread
 * POST /api/agent/release  { agent: string }                        -> { ok: true }
 *      Gives claimed threads back (agentState 'pending'). Used when an agent stops.
 */

export interface WaitResponse {
  /** Empty when the wait timed out. The agent calls `wait` again. */
  threads: AgentThread[];
  /**
   * Batches that the returned threads belong to. All threads of one batch are delivered
   * together in one response, to one agent.
   */
  batches: ReviewBatch[];
  timedOut: boolean;
}

/** A thread plus the context an agent needs to answer without more lookups. */
export interface AgentThread {
  thread: Thread;
  review: { id: string; title: string; spec: ReviewSpec; from: string; to: string | null };
  /** Absolute path of the repo root. */
  repoRoot: string;
  /**
   * The diff hunk(s) around the anchor in unified diff text, with line numbers.
   * Null for outdated threads and file-level threads.
   */
  diffContext: string | null;
  /**
   * The batch that released the latest human message of this thread, or null when that message
   * was a one-off (mode 'ask'). Lets a client group a wait response by batch.
   */
  batchId: number | null;
}
