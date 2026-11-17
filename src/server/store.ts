import fs from 'node:fs';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { AuthorKind, ReviewMode, ReviewScope, ReviewSpec, ThreadOriginal } from '../shared/types.ts';

/** Which content a thread was written on. 'index' exists only in working reviews. */
export type Target = 'old' | 'index' | 'new';

export interface ReviewRow {
  id: string;
  spec: ReviewSpec;
  title: string;
  createdAt: string;
  updatedAt: string;
  openedAt: string;
}

export interface ThreadRow {
  id: number;
  reviewId: string;
  target: Target;
  homeScope: ReviewScope;
  /** Path of the file on the target content. */
  path: string;
  /** Another path the file had (rename) the last time it was anchored. */
  pathHint: string | null;
  startLine: number | null;
  endLine: number | null;
  snippet: string[];
  ctxBefore: string[];
  ctxAfter: string[];
  outdated: boolean;
  outdatedReason: 'changed' | 'file-gone' | null;
  resolved: boolean;
  noteOnly: boolean;
  /** The code when the thread was created. Null for threads stored before Margin kept it. */
  original: ThreadOriginal | null;
  /** Mode of the latest submitted human message. */
  mode: ReviewMode;
  claimedBy: string | null;
  claimedAt: number | null;
  deliveredUpTo: number;
  createdAt: string;
  updatedAt: string;
}

export interface MessageRow {
  id: number;
  threadId: number;
  authorKind: AuthorKind;
  authorName: string;
  body: string;
  createdAt: string;
  editedAt: string | null;
  pending: boolean;
  batchId: number | null;
}

export interface BatchRow {
  id: number;
  reviewId: string;
  mode: 'discuss' | 'implement';
  body: string;
  submittedAt: string;
  threadIds: number[];
  head: string | null;
  branch: string | null;
}

export interface ViewedRow {
  path: string;
  fingerprint: string;
  blobId: string | null;
}

let sqliteModule: typeof import('node:sqlite') | null = null;

/** Loads node:sqlite without printing the ExperimentalWarning. */
export async function loadSqlite(): Promise<typeof import('node:sqlite')> {
  if (sqliteModule) return sqliteModule;
  const original = process.emitWarning;
  process.emitWarning = function (warning: string | Error, ...rest: unknown[]) {
    const msg = typeof warning === 'string' ? warning : warning?.message;
    if (typeof msg === 'string' && msg.includes('SQLite')) return;
    return (original as (...a: unknown[]) => void).call(process, warning, ...rest);
  } as typeof process.emitWarning;
  try {
    sqliteModule = await import('node:sqlite');
  } finally {
    process.emitWarning = original;
  }
  return sqliteModule;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS reviews (
  id TEXT PRIMARY KEY,
  spec TEXT NOT NULL,
  title TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  opened_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS threads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  review_id TEXT NOT NULL,
  target TEXT NOT NULL,
  home_scope TEXT NOT NULL,
  path TEXT NOT NULL,
  path_hint TEXT,
  start_line INTEGER,
  end_line INTEGER,
  snippet TEXT NOT NULL,
  ctx_before TEXT NOT NULL,
  ctx_after TEXT NOT NULL,
  outdated INTEGER NOT NULL DEFAULT 0,
  outdated_reason TEXT,
  resolved INTEGER NOT NULL DEFAULT 0,
  note_only INTEGER NOT NULL DEFAULT 0,
  original TEXT,
  mode TEXT NOT NULL DEFAULT 'ask',
  claimed_by TEXT,
  claimed_at INTEGER,
  delivered_upto INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS threads_review ON threads(review_id);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  thread_id INTEGER NOT NULL,
  author_kind TEXT NOT NULL,
  author_name TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL,
  edited_at TEXT,
  pending INTEGER NOT NULL DEFAULT 0,
  batch_id INTEGER
);
CREATE INDEX IF NOT EXISTS messages_thread ON messages(thread_id);
CREATE TABLE IF NOT EXISTS batches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  review_id TEXT NOT NULL,
  mode TEXT NOT NULL,
  body TEXT NOT NULL,
  submitted_at TEXT NOT NULL,
  thread_ids TEXT NOT NULL,
  head TEXT,
  branch TEXT
);
CREATE INDEX IF NOT EXISTS batches_review ON batches(review_id);
CREATE TABLE IF NOT EXISTS viewed (
  review_id TEXT NOT NULL,
  scope TEXT NOT NULL,
  path TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  blob_id TEXT,
  viewed_at TEXT NOT NULL,
  PRIMARY KEY (review_id, scope, path)
);
CREATE TABLE IF NOT EXISTS blobs (id TEXT PRIMARY KEY, content BLOB NOT NULL);
`;

type Row = Record<string, unknown>;

function threadFromRow(r: Row): ThreadRow {
  return {
    id: Number(r.id),
    reviewId: String(r.review_id),
    target: r.target as Target,
    homeScope: r.home_scope as ReviewScope,
    path: String(r.path),
    pathHint: (r.path_hint as string | null) ?? null,
    startLine: r.start_line === null ? null : Number(r.start_line),
    endLine: r.end_line === null ? null : Number(r.end_line),
    snippet: JSON.parse(String(r.snippet)) as string[],
    ctxBefore: JSON.parse(String(r.ctx_before)) as string[],
    ctxAfter: JSON.parse(String(r.ctx_after)) as string[],
    outdated: Number(r.outdated) === 1,
    outdatedReason: Number(r.outdated) === 1 ? (((r.outdated_reason as string | null) ?? 'changed') as ThreadRow['outdatedReason']) : null,
    resolved: Number(r.resolved) === 1,
    noteOnly: Number(r.note_only) === 1,
    original: parseOriginal(r.original),
    mode: ((r.mode as string | null) ?? 'ask') as ReviewMode,
    claimedBy: (r.claimed_by as string | null) ?? null,
    claimedAt: r.claimed_at === null ? null : Number(r.claimed_at),
    deliveredUpTo: Number(r.delivered_upto),
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
  };
}

function parseOriginal(v: unknown): ThreadOriginal | null {
  if (typeof v !== 'string' || !v) return null;
  try {
    return JSON.parse(v) as ThreadOriginal;
  } catch {
    return null;
  }
}

function messageFromRow(r: Row): MessageRow {
  return {
    id: Number(r.id),
    threadId: Number(r.thread_id),
    authorKind: r.author_kind as AuthorKind,
    authorName: String(r.author_name),
    body: String(r.body),
    createdAt: String(r.created_at),
    editedAt: (r.edited_at as string | null) ?? null,
    pending: Number(r.pending) === 1,
    batchId: r.batch_id === null || r.batch_id === undefined ? null : Number(r.batch_id),
  };
}

function batchFromRow(r: Row): BatchRow {
  return {
    id: Number(r.id),
    reviewId: String(r.review_id),
    mode: r.mode as BatchRow['mode'],
    body: String(r.body),
    submittedAt: String(r.submitted_at),
    threadIds: JSON.parse(String(r.thread_ids)) as number[],
    head: (r.head as string | null | undefined) ?? null,
    branch: (r.branch as string | null | undefined) ?? null,
  };
}

/**
 * Columns added after the first release. Databases created before them get the columns in place
 * (ALTER TABLE ADD COLUMN keeps every row). Old messages become submitted one-off messages.
 */
const ADDED_COLUMNS: Array<[table: string, column: string, ddl: string]> = [
  ['threads', 'mode', "mode TEXT NOT NULL DEFAULT 'ask'"],
  ['messages', 'pending', 'pending INTEGER NOT NULL DEFAULT 0'],
  ['messages', 'batch_id', 'batch_id INTEGER'],
  // Review history: the code snapshot of a thread, why it is outdated, and where a batch was submitted.
  ['threads', 'original', 'original TEXT'],
  ['threads', 'outdated_reason', 'outdated_reason TEXT'],
  ['batches', 'head', 'head TEXT'],
  ['batches', 'branch', 'branch TEXT'],
];

function reviewFromRow(r: Row): ReviewRow {
  return {
    id: String(r.id),
    spec: JSON.parse(String(r.spec)) as ReviewSpec,
    title: String(r.title),
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
    openedAt: String(r.opened_at),
  };
}

/** All persistent state. Synchronous (node:sqlite), so each method is atomic in the event loop. */
export class Store {
  constructor(private readonly db: DatabaseSync) {
    db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;');
    db.exec(SCHEMA);
    this.migrate();
  }

  private migrate(): void {
    for (const [table, column, ddl] of ADDED_COLUMNS) {
      const cols = (this.db.prepare(`PRAGMA table_info(${table})`).all() as Row[]).map((c) => String(c.name));
      if (!cols.includes(column)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
    }
    this.db.exec('CREATE INDEX IF NOT EXISTS messages_pending ON messages(pending) WHERE pending = 1');
  }

  static async open(file: string): Promise<Store> {
    const { DatabaseSync } = await loadSqlite();
    if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
    return new Store(new DatabaseSync(file));
  }

  close(): void {
    this.db.close();
  }

  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const r = fn();
      this.db.exec('COMMIT');
      return r;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  // ------------------------------------------------------------ reviews

  getReview(id: string): ReviewRow | null {
    const r = this.db.prepare('SELECT * FROM reviews WHERE id = ?').get(id) as Row | undefined;
    return r ? reviewFromRow(r) : null;
  }

  /** Most recently opened first. */
  listReviews(): ReviewRow[] {
    return (this.db.prepare('SELECT * FROM reviews ORDER BY opened_at DESC, id').all() as Row[]).map(reviewFromRow);
  }

  upsertReview(id: string, spec: ReviewSpec, title: string, now: string): ReviewRow {
    this.db
      .prepare(
        `INSERT INTO reviews (id, spec, title, created_at, updated_at, opened_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET spec = excluded.spec, title = excluded.title, opened_at = excluded.opened_at`,
      )
      .run(id, JSON.stringify(spec), title, now, now, now);
    return this.getReview(id)!;
  }

  touchReviewOpened(id: string, now: string): void {
    this.db.prepare('UPDATE reviews SET opened_at = ? WHERE id = ?').run(now, id);
  }

  touchReviewUpdated(id: string, now: string): void {
    this.db.prepare('UPDATE reviews SET updated_at = ? WHERE id = ?').run(now, id);
  }

  threadCounts(reviewId: string): { threadCount: number; unresolvedCount: number } {
    const r = this.db
      .prepare('SELECT COUNT(*) AS n, COALESCE(SUM(CASE WHEN resolved = 0 THEN 1 ELSE 0 END), 0) AS u FROM threads WHERE review_id = ?')
      .get(reviewId) as Row;
    return { threadCount: Number(r.n), unresolvedCount: Number(r.u) };
  }

  // ------------------------------------------------------------ threads

  insertThread(
    t: Omit<ThreadRow, 'id' | 'outdated' | 'outdatedReason' | 'resolved' | 'claimedBy' | 'claimedAt' | 'deliveredUpTo' | 'pathHint' | 'mode'> & { pathHint: string | null },
  ): number {
    const r = this.db
      .prepare(
        `INSERT INTO threads (review_id, target, home_scope, path, path_hint, start_line, end_line, snippet, ctx_before, ctx_after, note_only, original, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        t.reviewId,
        t.target,
        t.homeScope,
        t.path,
        t.pathHint,
        t.startLine,
        t.endLine,
        JSON.stringify(t.snippet),
        JSON.stringify(t.ctxBefore),
        JSON.stringify(t.ctxAfter),
        t.noteOnly ? 1 : 0,
        t.original ? JSON.stringify(t.original) : null,
        t.createdAt,
        t.updatedAt,
      );
    return Number(r.lastInsertRowid);
  }

  getThread(id: number): ThreadRow | null {
    const r = this.db.prepare('SELECT * FROM threads WHERE id = ?').get(id) as Row | undefined;
    return r ? threadFromRow(r) : null;
  }

  threadsOfReview(reviewId: string): ThreadRow[] {
    return (this.db.prepare('SELECT * FROM threads WHERE review_id = ? ORDER BY id').all(reviewId) as Row[]).map(threadFromRow);
  }

  allThreads(): ThreadRow[] {
    return (this.db.prepare('SELECT * FROM threads ORDER BY id').all() as Row[]).map(threadFromRow);
  }

  /** Updates the given columns. Keys are ThreadRow field names. */
  updateThread(id: number, patch: Partial<ThreadRow>): void {
    const cols: Record<string, string> = {
      path: 'path',
      pathHint: 'path_hint',
      startLine: 'start_line',
      endLine: 'end_line',
      outdated: 'outdated',
      outdatedReason: 'outdated_reason',
      resolved: 'resolved',
      noteOnly: 'note_only',
      mode: 'mode',
      claimedBy: 'claimed_by',
      claimedAt: 'claimed_at',
      deliveredUpTo: 'delivered_upto',
      updatedAt: 'updated_at',
    };
    const sets: string[] = [];
    const vals: Array<string | number | null> = [];
    for (const [k, v] of Object.entries(patch)) {
      const col = cols[k];
      if (!col) continue;
      sets.push(`${col} = ?`);
      vals.push(typeof v === 'boolean' ? (v ? 1 : 0) : (v as string | number | null));
    }
    if (!sets.length) return;
    this.db.prepare(`UPDATE threads SET ${sets.join(', ')} WHERE id = ?`).run(...vals, id);
  }

  deleteThread(id: number): void {
    this.db.prepare('DELETE FROM messages WHERE thread_id = ?').run(id);
    this.db.prepare('DELETE FROM threads WHERE id = ?').run(id);
  }

  // ------------------------------------------------------------ messages

  insertMessage(threadId: number, kind: AuthorKind, name: string, body: string, now: string, pending = false): number {
    const r = this.db
      .prepare('INSERT INTO messages (thread_id, author_kind, author_name, body, created_at, pending) VALUES (?, ?, ?, ?, ?, ?)')
      .run(threadId, kind, name, body, now, pending ? 1 : 0);
    return Number(r.lastInsertRowid);
  }

  /** Pending messages of one review, oldest first. */
  pendingMessages(reviewId: string): MessageRow[] {
    return (
      this.db
        .prepare('SELECT m.* FROM messages m JOIN threads t ON t.id = m.thread_id WHERE t.review_id = ? AND m.pending = 1 ORDER BY m.id')
        .all(reviewId) as Row[]
    ).map(messageFromRow);
  }

  pendingCount(reviewId: string): number {
    const r = this.db
      .prepare('SELECT COUNT(*) AS n FROM messages m JOIN threads t ON t.id = m.thread_id WHERE t.review_id = ? AND m.pending = 1')
      .get(reviewId) as Row;
    return Number(r.n);
  }

  /**
   * Marks messages as submitted by a batch. They get new ids and the submit time, so each one
   * comes after every message already in its thread (an agent may have replied while it was
   * pending): a submitted message is the latest word of the human.
   */
  releaseMessages(ids: number[], batchId: number, now: string): void {
    const copy = this.db.prepare(
      `INSERT INTO messages (thread_id, author_kind, author_name, body, created_at, edited_at, pending, batch_id)
       SELECT thread_id, author_kind, author_name, body, ?, edited_at, 0, ? FROM messages WHERE id = ?`,
    );
    const del = this.db.prepare('DELETE FROM messages WHERE id = ?');
    for (const id of ids) {
      copy.run(now, batchId, id);
      del.run(id);
    }
  }

  // ------------------------------------------------------------ batches

  insertBatch(b: Omit<BatchRow, 'id'>): number {
    const r = this.db
      .prepare('INSERT INTO batches (review_id, mode, body, submitted_at, thread_ids, head, branch) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(b.reviewId, b.mode, b.body, b.submittedAt, JSON.stringify(b.threadIds), b.head, b.branch);
    return Number(r.lastInsertRowid);
  }

  getBatch(id: number): BatchRow | null {
    const r = this.db.prepare('SELECT * FROM batches WHERE id = ?').get(id) as Row | undefined;
    return r ? batchFromRow(r) : null;
  }

  batchesOf(reviewId: string): BatchRow[] {
    return (this.db.prepare('SELECT * FROM batches WHERE review_id = ? ORDER BY id').all(reviewId) as Row[]).map(batchFromRow);
  }

  allBatches(): BatchRow[] {
    return (this.db.prepare('SELECT * FROM batches ORDER BY id').all() as Row[]).map(batchFromRow);
  }

  /** Every message of the repo, grouped by thread, oldest first. One query for History. */
  messagesByThread(): Map<number, MessageRow[]> {
    const out = new Map<number, MessageRow[]>();
    for (const r of this.db.prepare('SELECT * FROM messages ORDER BY id').all() as Row[]) {
      const m = messageFromRow(r);
      let arr = out.get(m.threadId);
      if (!arr) out.set(m.threadId, (arr = []));
      arr.push(m);
    }
    return out;
  }

  messagesOf(threadId: number): MessageRow[] {
    return (this.db.prepare('SELECT * FROM messages WHERE thread_id = ? ORDER BY id').all(threadId) as Row[]).map(messageFromRow);
  }

  getMessage(id: number): MessageRow | null {
    const r = this.db.prepare('SELECT * FROM messages WHERE id = ?').get(id) as Row | undefined;
    return r ? messageFromRow(r) : null;
  }

  editMessage(id: number, body: string, now: string): void {
    this.db.prepare('UPDATE messages SET body = ?, edited_at = ? WHERE id = ?').run(body, now, id);
  }

  deleteMessage(id: number): void {
    this.db.prepare('DELETE FROM messages WHERE id = ?').run(id);
  }

  // ------------------------------------------------------------ viewed

  viewedOf(reviewId: string, scope: ReviewScope): Map<string, ViewedRow> {
    const rows = this.db
      .prepare('SELECT path, fingerprint, blob_id FROM viewed WHERE review_id = ? AND scope = ?')
      .all(reviewId, scope) as Row[];
    return new Map(rows.map((r) => [String(r.path), { path: String(r.path), fingerprint: String(r.fingerprint), blobId: (r.blob_id as string | null) ?? null }]));
  }

  setViewed(reviewId: string, scope: ReviewScope, p: string, fingerprint: string, blobId: string | null, now: string): void {
    this.db
      .prepare(
        `INSERT INTO viewed (review_id, scope, path, fingerprint, blob_id, viewed_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(review_id, scope, path) DO UPDATE SET fingerprint = excluded.fingerprint, blob_id = excluded.blob_id, viewed_at = excluded.viewed_at`,
      )
      .run(reviewId, scope, p, fingerprint, blobId, now);
  }

  clearViewed(reviewId: string, scope: ReviewScope, p: string): void {
    this.db.prepare('DELETE FROM viewed WHERE review_id = ? AND scope = ? AND path = ?').run(reviewId, scope, p);
  }

  // ------------------------------------------------------------ blobs

  putBlob(id: string, content: Buffer): void {
    this.db.prepare('INSERT OR IGNORE INTO blobs (id, content) VALUES (?, ?)').run(id, content);
  }

  getBlob(id: string): Buffer | null {
    const r = this.db.prepare('SELECT content FROM blobs WHERE id = ?').get(id) as Row | undefined;
    return r ? Buffer.from(r.content as Uint8Array) : null;
  }
}
