import fs from 'node:fs';
import type http from 'node:http';
import path from 'node:path';
import { VERSION } from './errors.ts';
import { discoverRepo, marginDir, type RepoPaths } from './git.ts';
import { createHttpServer } from './http.ts';
import { Margin } from './service.ts';
import { Store } from './store.ts';

export interface ServerInfo {
  pid: number;
  port: number;
  startedAt: string;
  version: string;
}

export function serverInfoPath(repo: RepoPaths): string {
  return path.join(marginDir(repo), 'server.json');
}

export function readServerInfo(repo: RepoPaths): ServerInfo | null {
  try {
    return JSON.parse(fs.readFileSync(serverInfoPath(repo), 'utf8')) as ServerInfo;
  } catch {
    return null;
  }
}

export interface StartOptions {
  cwd: string;
  /** 0 or undefined: a random free port. */
  port?: number;
  webDir: string | null;
  /** Exit after this long with no browser, no waiting agent and no request. 0 disables. */
  idleMs?: number;
  pollMs?: number;
  claimTimeoutMs?: number;
  presenceLingerMs?: number;
  /** Write server.json (default true). */
  writeInfo?: boolean;
  allowOrigins?: string[];
  /** Called after the server closed itself (idle or /api/shutdown). */
  onExit?: () => void;
}

export interface RunningServer {
  margin: Margin;
  server: http.Server;
  port: number;
  repo: RepoPaths;
  close(): Promise<void>;
}

export async function startServer(opts: StartOptions): Promise<RunningServer> {
  const repo = await discoverRepo(opts.cwd);
  const dir = marginDir(repo);
  fs.mkdirSync(dir, { recursive: true });
  const store = await Store.open(path.join(dir, 'margin.db'));
  const margin = new Margin({
    repo,
    store,
    version: VERSION,
    pollMs: opts.pollMs,
    claimTimeoutMs: opts.claimTimeoutMs,
    presenceLingerMs: opts.presenceLingerMs,
  });

  let lastActivity = Date.now();
  let closing: Promise<void> | null = null;
  const server = createHttpServer(margin, {
    webDir: opts.webDir,
    allowOrigins: opts.allowOrigins,
    onActivity: () => (lastActivity = Date.now()),
    onShutdown: () => void close().then(() => opts.onExit?.()),
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port ?? 0, '127.0.0.1', () => resolve());
  });
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  const infoFile = serverInfoPath(repo);
  if (opts.writeInfo !== false) {
    const info: ServerInfo = { pid: process.pid, port, startedAt: new Date().toISOString(), version: VERSION };
    const tmp = `${infoFile}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(info, null, 2));
    fs.renameSync(tmp, infoFile);
  }

  let idleTimer: NodeJS.Timeout | null = null;
  const idleMs = opts.idleMs ?? 30 * 60_000;
  if (idleMs > 0) {
    idleTimer = setInterval(() => {
      if (margin.subscriberCount > 0 || margin.waiterCount > 0) {
        lastActivity = Date.now();
        return;
      }
      if (Date.now() - lastActivity >= idleMs) void close().then(() => opts.onExit?.());
    }, Math.max(100, Math.min(30_000, Math.floor(idleMs / 4))));
    idleTimer.unref();
  }

  function close(): Promise<void> {
    if (closing) return closing;
    closing = (async () => {
      if (idleTimer) clearInterval(idleTimer);
      margin.close();
      if (opts.writeInfo !== false) {
        const cur = (() => {
          try {
            return JSON.parse(fs.readFileSync(infoFile, 'utf8')) as ServerInfo;
          } catch {
            return null;
          }
        })();
        if (cur?.pid === process.pid && cur.port === port) {
          try {
            fs.unlinkSync(infoFile);
          } catch {
            /* gone */
          }
        }
      }
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
      store.close();
    })();
    return closing;
  }

  return { margin, server, port, repo, close };
}

/** Entry point of the detached server process (`margin __serve`). */
export async function runServerProcess(cwd: string, webDir: string | null): Promise<void> {
  const envNum = (k: string) => (process.env[k] ? Number(process.env[k]) : undefined);
  const idleSec = envNum('MARGIN_IDLE_TIMEOUT');
  const running = await startServer({
    cwd,
    webDir,
    port: envNum('MARGIN_PORT'),
    idleMs: idleSec === undefined ? undefined : idleSec * 1000,
    claimTimeoutMs: envNum('MARGIN_CLAIM_TIMEOUT') === undefined ? undefined : envNum('MARGIN_CLAIM_TIMEOUT')! * 1000,
    allowOrigins: (process.env.MARGIN_ALLOW_ORIGIN ?? '').split(',').map((s) => s.trim()).filter(Boolean),
    onExit: () => process.exit(0),
  });
  const stop = () => void running.close().then(() => process.exit(0));
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  process.on('SIGHUP', stop);
  console.log(`[${new Date().toISOString()}] margin ${VERSION} serving ${running.repo.root} on http://127.0.0.1:${running.port} (pid ${process.pid})`);
}
