import type {
  AddMessageRequest,
  CreateThreadRequest,
  RepoInfo,
  WorkspaceInfo,
  Dashboard,
  DiffFile,
  FileContent,
  Health,
  HistoryPage,
  Review,
  ReviewBatch,
  ReviewScope,
  ReviewSummary,
  Side,
  SinceViewed,
  SubmitReviewRequest,
  Thread,
  UpdateThreadRequest,
} from '../../src/shared/types.ts';

export class ApiFailure extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

async function call<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) {
    let msg = `${res.status} ${res.statusText}`;
    try {
      const j = await res.json();
      if (j && typeof j.error === 'string') msg = j.error;
    } catch {
      /* not json */
    }
    throw new ApiFailure(res.status, msg);
  }
  return (await res.json()) as T;
}

const enc = encodeURIComponent;

/** The workspace (worktree) of the page: /w/<ws>/... */
let WS = '';
export function setWorkspace(id: string): void {
  WS = id;
}
export function workspace(): string {
  return WS;
}
const base = () => `/api/w/${enc(WS)}`;
/** A page path inside the current workspace. */
export const wsHref = (p: string, ws = WS) => `/w/${enc(ws)}${p}`;
/** The page of one review. */
export const reviewHref = (ws: string, id: string) => `/w/${enc(ws)}/r/${enc(id)}`;
const sc = (scope: ReviewScope) => `scope=${scope}`;

export const api = {
  reviews: () => call<ReviewSummary[]>('GET', `${base()}/reviews`),
  review: (id: string, scope: ReviewScope) => call<Review>('GET', `${base()}/reviews/${enc(id)}?${sc(scope)}`),
  hunks: (id: string, scope: ReviewScope, paths: string[]) =>
    call<DiffFile[]>('POST', `${base()}/reviews/${enc(id)}/hunks?${sc(scope)}`, { paths }),
  file: (id: string, scope: ReviewScope, path: string, side: Side) =>
    call<FileContent>('GET', `${base()}/reviews/${enc(id)}/file?path=${enc(path)}&side=${side}&${sc(scope)}`),
  sinceViewed: (id: string, scope: ReviewScope, path: string) =>
    call<SinceViewed>('GET', `${base()}/reviews/${enc(id)}/since-viewed?path=${enc(path)}&${sc(scope)}`),
  setViewed: (id: string, scope: ReviewScope, path: string, viewed: boolean) =>
    call<{ ok: true }>('PUT', `${base()}/reviews/${enc(id)}/viewed?${sc(scope)}`, { path, viewed }),
  createThread: (id: string, scope: ReviewScope, req: CreateThreadRequest) =>
    call<Thread>('POST', `${base()}/reviews/${enc(id)}/threads?${sc(scope)}`, req),
  updateThread: (tid: number, scope: ReviewScope, req: UpdateThreadRequest) =>
    call<Thread>('PATCH', `${base()}/threads/${tid}?${sc(scope)}`, req),
  deleteThread: (tid: number) => call<{ ok: true }>('DELETE', `${base()}/threads/${tid}`),
  addMessage: (tid: number, scope: ReviewScope, req: AddMessageRequest) =>
    call<Thread>('POST', `${base()}/threads/${tid}/messages?${sc(scope)}`, req),
  editMessage: (mid: number, scope: ReviewScope, body: string) =>
    call<Thread>('PATCH', `${base()}/messages/${mid}?${sc(scope)}`, { body }),
  deleteMessage: (mid: number, scope: ReviewScope) =>
    call<Thread | { ok: true; threadDeleted: true }>('DELETE', `${base()}/messages/${mid}?${sc(scope)}`),
  submitReview: (id: string, req: SubmitReviewRequest) => call<ReviewBatch>('POST', `${base()}/reviews/${enc(id)}/submit`, req),
  discardPending: (id: string) => call<{ ok: true }>('DELETE', `${base()}/reviews/${enc(id)}/pending`),
  eventsUrl: (id: string, scope: ReviewScope) => `${base()}/reviews/${enc(id)}/events?${sc(scope)}`,
  health: () => call<Health>('GET', '/api/health'),
  info: () => call<{ workspace: WorkspaceInfo; repo: RepoInfo }>('GET', `${base()}/info`),
  dashboard: () => call<Dashboard>('GET', '/api/dashboard'),
  forgetWorkspace: (ws: string) => call<{ ok: true }>('DELETE', `/api/workspaces/${enc(ws)}`),
  ack: (ws: string, id: string) => call<ReviewSummary>('POST', `/api/w/${enc(ws)}/reviews/${enc(id)}/ack`),
  hubEventsUrl: () => '/api/events',
  history: (q: { q?: string; review?: string; state?: string; mode?: string; before?: string; limit?: number }) => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(q)) if (v !== undefined && v !== '' && v !== null) p.set(k, String(v));
    return call<HistoryPage>('GET', `${base()}/history?${p}`);
  },
};
