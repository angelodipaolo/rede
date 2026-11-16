import type {
  AddMessageRequest,
  CreateThreadRequest,
  DiffFile,
  FileContent,
  Review,
  ReviewScope,
  ReviewSummary,
  Side,
  SinceViewed,
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
const sc = (scope: ReviewScope) => `scope=${scope}`;

export const api = {
  reviews: () => call<ReviewSummary[]>('GET', '/api/reviews'),
  review: (id: string, scope: ReviewScope) => call<Review>('GET', `/api/reviews/${enc(id)}?${sc(scope)}`),
  hunks: (id: string, scope: ReviewScope, paths: string[]) =>
    call<DiffFile[]>('POST', `/api/reviews/${enc(id)}/hunks?${sc(scope)}`, { paths }),
  file: (id: string, scope: ReviewScope, path: string, side: Side) =>
    call<FileContent>('GET', `/api/reviews/${enc(id)}/file?path=${enc(path)}&side=${side}&${sc(scope)}`),
  sinceViewed: (id: string, scope: ReviewScope, path: string) =>
    call<SinceViewed>('GET', `/api/reviews/${enc(id)}/since-viewed?path=${enc(path)}&${sc(scope)}`),
  setViewed: (id: string, scope: ReviewScope, path: string, viewed: boolean) =>
    call<{ ok: true }>('PUT', `/api/reviews/${enc(id)}/viewed?${sc(scope)}`, { path, viewed }),
  createThread: (id: string, scope: ReviewScope, req: CreateThreadRequest) =>
    call<Thread>('POST', `/api/reviews/${enc(id)}/threads?${sc(scope)}`, req),
  updateThread: (tid: number, scope: ReviewScope, req: UpdateThreadRequest) =>
    call<Thread>('PATCH', `/api/threads/${tid}?${sc(scope)}`, req),
  deleteThread: (tid: number) => call<{ ok: true }>('DELETE', `/api/threads/${tid}`),
  addMessage: (tid: number, scope: ReviewScope, req: AddMessageRequest) =>
    call<Thread>('POST', `/api/threads/${tid}/messages?${sc(scope)}`, req),
  editMessage: (mid: number, scope: ReviewScope, body: string) =>
    call<Thread>('PATCH', `/api/messages/${mid}?${sc(scope)}`, { body }),
  deleteMessage: (mid: number, scope: ReviewScope) =>
    call<Thread | { ok: true; threadDeleted: true }>('DELETE', `/api/messages/${mid}?${sc(scope)}`),
  eventsUrl: (id: string, scope: ReviewScope) => `/api/reviews/${enc(id)}/events?${sc(scope)}`,
};
