import fs from 'node:fs';
import type http from 'node:http';
import path from 'node:path';
import { VERSION } from './errors.ts';
import { createHttpServer } from './http.ts';
import { Hub, redeHome } from './hub.ts';

export interface ServerInfo {
  pid: number;
  port: number;
  startedAt: string;
  version: string;
  /** Build stamp of the bundle that started the server (see buildId). A newer CLI restarts an older server. */
  build?: number;
  home?: string;
}

declare const __REDE_BUILD__: number | undefined;

/**
 * Build stamp of a CLI bundle. The bundle embeds the time it was built, so every copy of one
 * build (the CLI on PATH, the copy inside Rede.app) has the same stamp. Falls back to the file's
 * mtime when run from source.
 */
export function buildId(cliPath?: string): number | undefined {
  if (typeof __REDE_BUILD__ === 'number') return __REDE_BUILD__;
  if (!cliPath) return undefined;
  try {
    return Math.floor(fs.statSync(cliPath).mtimeMs);
  } catch {
    return undefined;
  }
}

export function serverInfoPath(home: string): string {
  return path.join(home, 'server.json');
}

export function readServerInfo(home: string): ServerInfo | null {
  try {
    return JSON.parse(fs.readFileSync(serverInfoPath(home), 'utf8')) as ServerInfo;
  } catch {
    return null;
  }
}

/** Port the hub tries first. The dev proxy (web/vite.config.ts) uses the same default. */
export const DEFAULT_PORT = 4319;

export interface StartOptions {
  /** $REDE_HOME. Default: redeHome(). */
  home?: string;
  /** Worktrees to register at start (tests). */
  workspaces?: string[];
  /** 0: a random free port. undefined: the last port, else DEFAULT_PORT, else a random one. */
  port?: number;
  /** Try this port first, fall back to a random one when it is taken (restart of an outdated server). */
  preferredPort?: number;
  build?: number;
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
  hub: Hub;
  server: http.Server;
  port: number;
  /** Workspace ids of opts.workspaces, in order. */
  workspaces: string[];
  close(): Promise<void>;
}

export async function startServer(opts: StartOptions): Promise<RunningServer> {
  const home = opts.home ?? redeHome();
  const hub = new Hub({
    home,
    version: VERSION,
    pollMs: opts.pollMs,
    claimTimeoutMs: opts.claimTimeoutMs,
    presenceLingerMs: opts.presenceLingerMs,
  });

  let lastActivity = Date.now();
  let closing: Promise<void> | null = null;
  hub.onActivity = () => (lastActivity = Date.now());
  const server = createHttpServer(hub, {
    webDir: opts.webDir,
    allowOrigins: opts.allowOrigins,
    build: opts.build,
    onActivity: () => (lastActivity = Date.now()),
    onShutdown: () => void close().then(() => opts.onExit?.()),
  });

  const listen = (port: number) =>
    new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', () => {
        server.off('error', reject);
        resolve();
      });
    });
  // Reuse the last port when it is free. An open browser tab then reconnects by itself after a
  // restart, and a review URL keeps working.
  const lastPortFile = path.join(home, 'last-port');
  let preferred = opts.preferredPort;
  if (!preferred && opts.port === undefined) {
    preferred = DEFAULT_PORT;
    try {
      const n = Number(fs.readFileSync(lastPortFile, 'utf8').trim());
      if (Number.isInteger(n) && n > 1023 && n < 65536) preferred = n;
    } catch {
      /* first start */
    }
  }
  if (!opts.port && preferred) {
    await listen(preferred).catch(() => listen(0));
  } else await listen(opts.port ?? 0);
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;

  const workspaces: string[] = [];
  for (const w of opts.workspaces ?? []) workspaces.push((await hub.register(w)).id);

  const infoFile = serverInfoPath(home);
  if (opts.writeInfo !== false) {
    try {
      fs.writeFileSync(lastPortFile, String(port));
    } catch {
      /* not fatal */
    }
    const info: ServerInfo = { pid: process.pid, port, startedAt: new Date().toISOString(), version: VERSION, build: opts.build, home };
    const tmp = `${infoFile}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(info, null, 2));
    fs.renameSync(tmp, infoFile);
  }

  let idleTimer: NodeJS.Timeout | null = null;
  const idleMs = opts.idleMs ?? 30 * 60_000;
  if (idleMs > 0) {
    idleTimer = setInterval(() => {
      if (hub.subscriberCount > 0 || hub.waiterCount > 0) {
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
      hub.close();
      if (opts.writeInfo !== false) {
        const cur = readServerInfo(home);
        if (cur?.pid === process.pid && cur.port === port) {
          try {
            fs.unlinkSync(infoFile);
          } catch {
            /* gone */
          }
        }
      }
      // hub.close() answered waiting agents ("timed out"); let those responses go out first.
      await new Promise((r) => setTimeout(r, 100));
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
      hub.closeStores();
    })();
    return closing;
  }

  return { hub, server, port, workspaces, close };
}

/** Entry point of the detached server process (`rede __serve`). */
export async function runServerProcess(webDir: string | null, cliPath?: string): Promise<void> {
  const envNum = (k: string) => (process.env[k] ? Number(process.env[k]) : undefined);
  const idleSec = envNum('REDE_IDLE_TIMEOUT');
  const running = await startServer({
    webDir,
    port: envNum('REDE_PORT'),
    preferredPort: envNum('REDE_PREFERRED_PORT'),
    build: buildId(cliPath),
    idleMs: idleSec === undefined ? undefined : idleSec * 1000,
    claimTimeoutMs: envNum('REDE_CLAIM_TIMEOUT') === undefined ? undefined : envNum('REDE_CLAIM_TIMEOUT')! * 1000,
    allowOrigins: (process.env.REDE_ALLOW_ORIGIN ?? '').split(',').map((s) => s.trim()).filter(Boolean),
    onExit: () => process.exit(0),
  });
  const stop = () => void running.close().then(() => process.exit(0));
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  process.on('SIGHUP', stop);
  console.log(`[${new Date().toISOString()}] rede ${VERSION} serving ${running.hub.home} on http://127.0.0.1:${running.port} (pid ${process.pid})`);
}
