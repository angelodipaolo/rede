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
  agents: AgentPresence[];
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
   * True when the server cannot find the anchored code in the current diff
   * (the lines changed or the file left the diff). The UI shows such threads
   * at the top of the file, or in a review-level list, with the snippet.
   */
  outdated: boolean;
  resolved: boolean;
  /** A private note. Agents never receive it through `wait`. */
  noteOnly: boolean;
  agentState: AgentState;
  /** Name of the agent that holds the thread while agentState is 'working'. */
  claimedBy: string | null;
  messages: Message[];
  createdAt: string;
  updatedAt: string;
}

export interface Message {
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
 * GET  /api/reviews/:id/events             -> text/event-stream of ServerEvent (one JSON per `data:` line)
 */

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

export interface CreateThreadRequest {
  anchor: Anchor;
  body: string;
  author: Author;
  noteOnly?: boolean;
}

export interface UpdateThreadRequest {
  resolved?: boolean;
  noteOnly?: boolean;
}

export interface AddMessageRequest {
  body: string;
  author: Author;
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
}
