import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import type { ReviewScope, ServerEvent } from '../shared/types.ts';
import { badRequest, HttpError, notFound } from './errors.ts';
import { patchArgs } from './diff.ts';
import { gitStream } from './git.ts';
import type { Rede } from './service.ts';

export interface HttpOptions {
  /** Directory of the built web UI (index.html + assets). */
  webDir: string | null;
  /** Extra allowed origins for state-changing requests (dev servers). */
  allowOrigins?: string[];
  /** Called on every request and SSE/wait start/end. */
  onActivity?: () => void;
  /** Called by POST /api/shutdown. */
  onShutdown?: () => void;
  keepAliveMs?: number;
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

const NOT_BUILT = `<!doctype html><meta charset="utf-8"><title>Rede</title>
<body style="font:15px system-ui;margin:3em;max-width:40em">
<h1>Rede</h1><p>The web UI is not built. Run <code>npm run build</code> in the Rede checkout, then reload.</p>
<p>The API is running at <code>/api</code>.</p></body>`;

const SCOPES: ReviewScope[] = ['all', 'staged', 'unstaged'];

function parseScope(v: string | null): ReviewScope {
  if (v === null || v === '') return 'all';
  if (!SCOPES.includes(v as ReviewScope)) throw badRequest(`Unknown scope "${v}". Use all, staged or unstaged.`);
  return v as ReviewScope;
}

function optScope(v: string | null): ReviewScope | undefined {
  return v === null || v === '' ? undefined : parseScope(v);
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(text),
  });
  res.end(text);
}

async function readJson(req: http.IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > 10_000_000) throw new HttpError(413, 'Request body too large.');
    chunks.push(c as Buffer);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw badRequest('Invalid JSON body.');
  }
}

function intParam(s: string | undefined): number {
  const n = Number(s);
  if (!Number.isInteger(n)) throw badRequest(`Invalid id "${s}".`);
  return n;
}

export function createHttpServer(rede: Rede, opts: HttpOptions): http.Server {
  let port = 0;
  const activity = () => opts.onActivity?.();
  const keepAliveMs = opts.keepAliveMs ?? 15_000;

  const server = http.createServer((req, res) => {
    activity();
    handle(req, res).catch((e: unknown) => {
      const status = e instanceof HttpError ? e.status : 500;
      const msg = e instanceof Error ? e.message : String(e);
      if (status === 500) console.error(e);
      if (!res.headersSent) sendJson(res, status, { error: msg });
      else res.end();
    });
  });
  server.on('listening', () => {
    const a = server.address();
    if (a && typeof a === 'object') port = a.port;
  });
  // Long polls and SSE streams stay open for minutes.
  server.requestTimeout = 0;
  server.headersTimeout = 60_000;

  function allowedOrigins(): Set<string> {
    return new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`, ...(opts.allowOrigins ?? [])]);
  }

  function checkSecurity(req: http.IncomingMessage): void {
    const host = (req.headers.host ?? '').toLowerCase();
    // Hosts of extra allowed origins (a dev proxy that keeps the Host header) are accepted too.
    const extraHosts = (opts.allowOrigins ?? []).map((o) => o.replace(/^https?:\/\//, '').toLowerCase());
    if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}` && !extraHosts.includes(host)) {
      throw new HttpError(403, 'Forbidden host.');
    }
    const origin = req.headers.origin;
    const method = req.method ?? 'GET';
    if (origin && !allowedOrigins().has(origin)) {
      if (method !== 'GET' && method !== 'HEAD') throw new HttpError(403, 'Forbidden origin.');
      if (req.url?.startsWith('/api/')) throw new HttpError(403, 'Forbidden origin.');
    }
    if (req.headers['sec-fetch-site'] === 'cross-site' && !(origin && allowedOrigins().has(origin))) {
      throw new HttpError(403, 'Cross-site request refused.');
    }
  }

  async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    checkSecurity(req);
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
    const p = url.pathname;
    const q = url.searchParams;
    const m = req.method ?? 'GET';
    if (!p.startsWith('/api/')) return serveStatic(p, res);

    const seg = p.slice(5).split('/').map(decodeURIComponent);
    const route = `${m} ${seg.map((s, i) => (i > 0 && ['reviews', 'threads', 'messages'].includes(seg[i - 1]!) ? ':id' : s)).join('/')}`;

    switch (route) {
      case 'GET health':
        return sendJson(res, 200, { ok: true, name: 'rede', version: rede.version, repo: await rede.repoInfo(), pid: process.pid });
      case 'POST shutdown':
        sendJson(res, 200, { ok: true });
        setTimeout(() => opts.onShutdown?.(), 50);
        return;
      case 'GET agents':
        return sendJson(res, 200, rede.agents());
      case 'GET reviews':
        return sendJson(res, 200, rede.listReviews());
      case 'GET history':
        return sendJson(
          res,
          200,
          rede.history({
            q: q.get('q') ?? undefined,
            review: q.get('review') || undefined,
            state: (q.get('state') || undefined) as 'open' | 'resolved' | 'all' | undefined,
            mode: (q.get('mode') || undefined) as 'ask' | 'discuss' | 'implement' | undefined,
            since: q.get('since') || undefined,
            before: q.get('before') || undefined,
            limit: q.get('limit') ? Number(q.get('limit')) : undefined,
          }),
        );
      case 'POST reviews': {
        const body = await readJson(req);
        return sendJson(res, 200, await rede.openReview(body?.spec));
      }
      case 'GET reviews/:id': {
        // While a browser has the review open, a state up to 1 s old is reused (the poller pushes
        // diff-changed for newer changes). `fresh=1` (the CLI) always recomputes.
        const maxAge = q.get('fresh') !== '1' && rede.isLive(seg[1]!) ? 1000 : 0;
        return sendJson(res, 200, await rede.getReview(seg[1]!, parseScope(q.get('scope')), maxAge));
      }
      case 'POST reviews/:id/hunks': {
        const body = await readJson(req);
        return sendJson(res, 200, await rede.hunks(seg[1]!, parseScope(q.get('scope')), body?.paths));
      }
      case 'GET reviews/:id/patch': {
        // Not part of the browser contract: the CLI streams the plain patch (`rede diff`).
        const [from, to] = await rede.scopeTreesOf(seg[1]!, parseScope(q.get('scope')));
        res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
        if (from === to) return void res.end();
        const child = gitStream(patchArgs(from, to), { cwd: rede.cwd });
        res.on('close', () => child.kill());
        child.stdout!.pipe(res);
        return;
      }
      case 'GET reviews/:id/file': {
        const fp = q.get('path');
        if (!fp) throw badRequest('Missing path.');
        return sendJson(res, 200, await rede.fileContent(seg[1]!, fp, (q.get('side') ?? 'new') as 'old' | 'new', parseScope(q.get('scope'))));
      }
      case 'GET reviews/:id/since-viewed': {
        const fp = q.get('path');
        if (!fp) throw badRequest('Missing path.');
        return sendJson(res, 200, await rede.sinceViewed(seg[1]!, parseScope(q.get('scope')), fp));
      }
      case 'PUT reviews/:id/viewed': {
        const body = await readJson(req);
        await rede.setViewed(seg[1]!, parseScope(q.get('scope')), body?.path, !!body?.viewed);
        return sendJson(res, 200, { ok: true });
      }
      case 'POST reviews/:id/threads': {
        const body = await readJson(req);
        return sendJson(res, 200, await rede.createThread(seg[1]!, parseScope(q.get('scope')), body));
      }
      case 'POST reviews/:id/submit': {
        const body = await readJson(req);
        return sendJson(res, 200, rede.submitReview(seg[1]!, body));
      }
      case 'DELETE reviews/:id/pending':
        rede.discardPending(seg[1]!);
        return sendJson(res, 200, { ok: true });
      case 'GET reviews/:id/events':
        return sse(seg[1]!, parseScope(q.get('scope')), req, res);
      case 'GET threads/:id':
        return sendJson(res, 200, await rede.getThread(intParam(seg[1]), optScope(q.get('scope'))));
      case 'PATCH threads/:id': {
        const body = await readJson(req);
        return sendJson(res, 200, await rede.updateThread(intParam(seg[1]), body, optScope(q.get('scope'))));
      }
      case 'DELETE threads/:id':
        await rede.deleteThread(intParam(seg[1]));
        return sendJson(res, 200, { ok: true });
      case 'POST threads/:id/messages': {
        const body = await readJson(req);
        return sendJson(res, 200, await rede.addMessage(intParam(seg[1]), body, optScope(q.get('scope'))));
      }
      case 'PATCH messages/:id': {
        const body = await readJson(req);
        return sendJson(res, 200, await rede.editMessage(intParam(seg[1]), body?.body, optScope(q.get('scope'))));
      }
      case 'DELETE messages/:id':
        return sendJson(res, 200, await rede.deleteMessage(intParam(seg[1]), optScope(q.get('scope'))));
      case 'GET agent/wait': {
        const agent = (q.get('agent') ?? '').trim();
        const timeout = Math.min(3600, Math.max(0, Number(q.get('timeout') ?? 100) || 0));
        const ac = new AbortController();
        res.on('close', () => ac.abort());
        opts.onActivity?.();
        try {
          const r = await rede.wait(agent, timeout * 1000, q.get('review') || null, ac.signal);
          if (!res.destroyed) sendJson(res, 200, r);
          else if (r.threads.length) rede.unclaim(agent, r.threads.map((t) => rede.store.getThread(t.thread.id)!).filter(Boolean));
        } finally {
          activity();
        }
        return;
      }
      case 'GET agent/threads': {
        const state = (q.get('state') ?? 'open') as 'open' | 'pending' | 'all';
        if (!['open', 'pending', 'all'].includes(state)) throw badRequest('state must be open, pending or all.');
        return sendJson(res, 200, await rede.agentThreads(q.get('review') || null, state));
      }
      case 'GET agent/threads/:id':
        return sendJson(res, 200, await rede.agentThreadById(intParam(seg[2])));
      case 'POST agent/release': {
        const body = await readJson(req);
        if (typeof body?.agent !== 'string' || !body.agent) throw badRequest('Missing agent.');
        const released = rede.release(body.agent);
        return sendJson(res, 200, { ok: true, released });
      }
      default:
        throw notFound(`No route for ${m} ${p}.`);
    }
  }

  async function sse(reviewId: string, scope: ReviewScope, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const send = (ev: ServerEvent) => {
      res.write(`data: ${JSON.stringify(ev)}\n\n`);
    };
    // Subscribe first so errors (unknown review, bad scope) become a JSON error response.
    const queued: ServerEvent[] = [];
    let ready = false;
    const unsubscribe = await rede.subscribe(reviewId, scope, (ev) => (ready ? send(ev) : queued.push(ev)));
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    res.write('retry: 2000\n\n');
    ready = true;
    for (const ev of queued) send(ev);
    const ka = setInterval(() => res.write(': keep-alive\n\n'), keepAliveMs);
    const close = () => {
      clearInterval(ka);
      unsubscribe();
      activity();
    };
    let closed = false;
    const once = () => {
      if (closed) return;
      closed = true;
      close();
    };
    req.on('close', once);
    res.on('close', once);
    if (res.destroyed) once();
  }

  function serveStatic(p: string, res: http.ServerResponse): void {
    const dir = opts.webDir;
    if (!dir || !fs.existsSync(path.join(dir, 'index.html'))) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(NOT_BUILT);
      return;
    }
    let rel: string;
    try {
      rel = decodeURIComponent(p);
    } catch {
      rel = '/';
    }
    const file = path.resolve(dir, '.' + path.posix.normalize(rel));
    let target = path.join(dir, 'index.html');
    if (file.startsWith(path.resolve(dir) + path.sep) && fs.existsSync(file) && fs.statSync(file).isFile()) target = file;
    const isIndex = target.endsWith('index.html');
    res.writeHead(200, {
      'content-type': MIME[path.extname(target)] ?? 'application/octet-stream',
      'cache-control': isIndex ? 'no-store' : 'public, max-age=31536000, immutable',
    });
    fs.createReadStream(target).pipe(res);
  }

  return server;
}
