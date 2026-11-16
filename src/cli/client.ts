import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import type { Health } from '../shared/types.ts';
import { marginDir, type RepoPaths } from '../server/git.ts';
import { VERSION } from '../server/errors.ts';
import { buildId, readServerInfo, serverInfoPath, type ServerInfo } from '../server/server.ts';

export class ApiFailure extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** One HTTP request to the local server. Uses node:http: no client-side timeouts on long polls. */
export function request<T>(port: number, method: string, urlPath: string, body?: unknown, timeoutMs = 0): Promise<T> {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        method,
        path: urlPath,
        headers: data ? { 'content-type': 'application/json', 'content-length': data.length } : {},
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json: unknown = null;
          try {
            json = text ? JSON.parse(text) : null;
          } catch {
            /* not JSON */
          }
          if ((res.statusCode ?? 500) >= 400) {
            const msg = (json as { error?: string } | null)?.error ?? (text || `HTTP ${res.statusCode}`);
            reject(new ApiFailure(res.statusCode ?? 500, msg));
          } else resolve(json as T);
        });
      },
    );
    if (timeoutMs > 0) req.setTimeout(timeoutMs, () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    if (data) req.end(data);
    else req.end();
  });
}

/** GET that pipes the response body to a writable stream (for large plain-text responses). */
export function streamTo(port: number, urlPath: string, out: NodeJS.WritableStream): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method: 'GET', path: urlPath }, (res) => {
      if ((res.statusCode ?? 500) >= 400) {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let msg = text || `HTTP ${res.statusCode}`;
          try {
            msg = (JSON.parse(text) as { error?: string }).error ?? msg;
          } catch {
            /* not JSON */
          }
          reject(new ApiFailure(res.statusCode ?? 500, msg));
        });
        return;
      }
      res.on('error', reject);
      res.on('end', () => resolve());
      res.pipe(out, { end: false });
    });
    req.on('error', reject);
    req.end();
  });
}

// ------------------------------------------------------------------ server lifecycle

/** A failure the agent or the user must act on. main() prints the message as is. */
export class MarginError extends Error {}

const CODEX_ENV_KEYS = ['CODEX_SANDBOX', 'CODEX_SANDBOX_NETWORK_DISABLED', 'CODEX_THREAD_ID', 'CODEX_SESSION_ID', 'CODEX_TOOL_CALL_ID', 'CODEX_CI'];

export function inCodex(env: NodeJS.ProcessEnv = process.env): boolean {
  return CODEX_ENV_KEYS.some((k) => env[k] !== undefined);
}

/**
 * The agent's name from its environment. Codex and Claude Code both export markers to the commands
 * they run. When both are present (one harness started the other), the nearest ancestor process wins.
 */
export function detectAgentName(env: NodeJS.ProcessEnv = process.env, ancestors: () => string[] = processAncestors): string {
  if (env.MARGIN_AGENT?.trim()) return env.MARGIN_AGENT.trim();
  const claude = !!env.CLAUDECODE;
  const codex = inCodex(env);
  if (claude && codex) {
    for (const name of ancestors()) {
      const base = path.basename(name).toLowerCase();
      if (base.startsWith('codex')) return 'codex';
      if (base === 'claude') return 'claude';
    }
    return 'codex';
  }
  if (claude) return 'claude';
  if (codex) return 'codex';
  return 'agent';
}

/** Command names of the parent process chain, nearest first. Empty when ps is unavailable. */
function processAncestors(): string[] {
  try {
    const table = new Map<number, { ppid: number; comm: string }>();
    const text = execFileSync('ps', ['-A', '-o', 'pid=,ppid=,comm='], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 2000 });
    for (const line of text.split('\n')) {
      const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
      if (m) table.set(Number(m[1]), { ppid: Number(m[2]), comm: m[3]!.trim() });
    }
    const names: string[] = [];
    for (let pid = process.ppid, i = 0; pid > 1 && i < 64; i++) {
      const p = table.get(pid);
      if (!p) break;
      names.push(p.comm);
      pid = p.ppid;
    }
    return names;
  } catch {
    return [];
  }
}

/** Why a sandbox blocks margin and what to do, as "<reason>\n<fix>". */
export function sandboxAdvice(env: NodeJS.ProcessEnv = process.env): string {
  if (inCodex(env)) {
    return (
      'You are probably in the Codex sandbox.\n' +
      'Fix: run margin as one plain command (no pipe, redirection, heredoc or VAR= prefix), so the rule from `margin setup` runs it outside the sandbox. ' +
      'Without that rule: rerun it with escalated permissions, or ask the user to run `margin setup` and start a new Codex session.'
    );
  }
  return 'You are probably in a sandbox.\nFix: run margin commands outside the sandbox (allow the margin command, or approve escalation).';
}

const errCode = (e: unknown): string | undefined => (e as NodeJS.ErrnoException | null)?.code;
const BLOCKED_CONNECT = new Set(['EPERM', 'EACCES']);
const NO_WRITE = new Set(['EPERM', 'EACCES', 'EROFS']);

type Probe = { state: 'up' } | { state: 'down' } | { state: 'blocked'; code: string } | { state: 'hung' };

/**
 * Asks the server in server.json whether it runs. "down" only for a real not-running reason:
 * no server.json, connection refused or reset, or a different process on the port.
 */
async function probe(repo: RepoPaths, info: ServerInfo | null): Promise<Probe> {
  if (!info) return { state: 'down' };
  try {
    const h = await request<Health>(info.port, 'GET', '/api/health', undefined, 3000);
    return h.name === 'margin' && h.pid === info.pid && h.repo.root === repo.root ? { state: 'up' } : { state: 'down' };
  } catch (e) {
    const code = errCode(e);
    if (code && BLOCKED_CONNECT.has(code)) return { state: 'blocked', code };
    if (e instanceof Error && e.message === 'timeout' && alive(info.pid)) return { state: 'hung' };
    return { state: 'down' };
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return errCode(e) === 'EPERM'; // exists, but we may not signal it
  }
}

/** Returns the running server for this repo, or null when none runs. Never starts one. */
export async function findServer(repo: RepoPaths): Promise<ServerInfo | null> {
  const info = readServerInfo(repo);
  const p = await probe(repo, info);
  if (p.state === 'up') return info;
  if (p.state === 'down') return null;
  if (p.state === 'blocked') {
    throw new MarginError(
      `cannot reach the Margin server on 127.0.0.1:${info!.port} (connection blocked: ${p.code}). ${sandboxAdvice()}`,
    );
  }
  throw new MarginError(
    `the Margin server (pid ${info!.pid}, 127.0.0.1:${info!.port}) does not answer. If it stays stuck, stop it with \`kill ${info!.pid}\` and run margin again.`,
  );
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Compares dotted version strings numerically ("0.10.0" > "0.9.1"). */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(/[.+-]/);
  const pb = b.split(/[.+-]/);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? '0';
    const y = pb[i] ?? '0';
    const nx = Number(x);
    const ny = Number(y);
    const c = Number.isFinite(nx) && Number.isFinite(ny) ? nx - ny : x.localeCompare(y);
    if (c !== 0) return Math.sign(c);
  }
  return 0;
}

/**
 * True only when the server is strictly older than this CLI: a lower version, or the same version
 * and an older (or unknown) build. Never true in both directions for two CLIs, so two installs
 * cannot restart each other in turn.
 */
export function serverIsOlder(server: Pick<ServerInfo, 'version' | 'build'>, cli: { version: string; build: number | undefined }): boolean {
  const v = compareVersions(server.version, cli.version);
  if (v !== 0) return v < 0;
  if (cli.build === undefined) return false;
  return server.build === undefined || server.build < cli.build;
}

function cannotWrite(dir: string, code: string): MarginError {
  return new MarginError(
    `no Margin server runs for this repo, and this command may not start one: it cannot write ${dir} (${code}). ${sandboxAdvice()}`,
  );
}

function lockOwner(lock: string): number | null {
  try {
    const pid = Number(fs.readFileSync(lock, 'utf8').trim());
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

/**
 * Takes the start lock. Returns true when taken, or the server another command started meanwhile.
 * A lock whose owner process is gone is removed at once. Write errors (sandbox) are thrown.
 */
async function takeLock(repo: RepoPaths, lock: string, isCurrent: (i: ServerInfo) => boolean, waitMs: number): Promise<true | ServerInfo | null> {
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      fs.writeFileSync(lock, String(process.pid), { flag: 'wx' });
      return true;
    } catch (e) {
      if (errCode(e) !== 'EEXIST') throw e;
    }
    const info = await findServer(repo);
    if (info && isCurrent(info)) return info;
    const owner = lockOwner(lock);
    let stale = owner !== null && !alive(owner);
    if (owner === null) {
      try {
        // Longer than a start can take (15 s), so a slow start is never broken into.
        stale = Date.now() - fs.statSync(lock).mtimeMs > 30_000;
      } catch {
        /* gone: retry at once */
      }
    }
    if (stale) {
      try {
        fs.unlinkSync(lock);
      } catch {
        /* gone */
      }
      continue;
    }
    if (Date.now() >= deadline) return null;
    await sleep(100);
  }
}

/**
 * Returns the running server, starting a detached one when none runs. A server started by an
 * older build is stopped and replaced on the same port (an open browser tab reconnects), but only
 * when this command can take the start lock: a sandboxed command keeps using the running server.
 */
export async function ensureServer(repo: RepoPaths, cliPath: string): Promise<ServerInfo> {
  const cli = { version: VERSION, build: buildId(cliPath) };
  const isCurrent = (i: ServerInfo) => !serverIsOlder(i, cli);
  const existing = await findServer(repo);
  if (existing && isCurrent(existing)) return existing;
  const dir = marginDir(repo);
  const lock = path.join(dir, 'start.lock');
  let got: true | ServerInfo | null;
  try {
    fs.mkdirSync(dir, { recursive: true });
    got = await takeLock(repo, lock, isCurrent, 20_000);
  } catch (e) {
    const code = errCode(e);
    if (!code || !NO_WRITE.has(code)) throw e;
    if (existing) return existing; // older, but it works; leave the upgrade to an unsandboxed command
    throw cannotWrite(dir, code);
  }
  if (got !== true) {
    if (got) return got;
    if (existing) return existing;
    const owner = lockOwner(lock);
    throw new MarginError(
      `another margin command${owner ? ` (pid ${owner})` : ''} is starting the Margin server and still holds ${lock} after 20 s. Run margin again in a moment. If no margin command runs, delete that file.`,
    );
  }
  try {
    const again = await findServer(repo);
    if (again && isCurrent(again)) return again;
    let preferredPort: number | undefined;
    if (again) {
      preferredPort = again.port;
      await stopServer(repo);
    }
    const stale = readServerInfo(repo);
    if (stale) {
      try {
        fs.unlinkSync(serverInfoPath(repo));
      } catch {
        /* gone */
      }
    }
    const logFile = path.join(dir, 'server.log');
    const log = fs.openSync(logFile, 'a');
    const env = { ...process.env };
    if (preferredPort) env.MARGIN_PREFERRED_PORT = String(preferredPort);
    const child = spawn(process.execPath, [cliPath, '__serve'], {
      cwd: repo.root,
      detached: true,
      stdio: ['ignore', log, log],
      env,
    });
    child.unref();
    fs.closeSync(log);
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      await sleep(80);
      const info = readServerInfo(repo);
      if (info && info.pid === child.pid && (await probe(repo, info)).state === 'up') return info;
      if (child.exitCode !== null) break;
    }
    throw new MarginError(`the Margin server did not start. ${lastLine(logFile)}See ${logFile}.`);
  } finally {
    try {
      fs.unlinkSync(lock);
    } catch {
      /* gone */
    }
  }
}

function lastLine(file: string): string {
  try {
    const line = fs.readFileSync(file, 'utf8').trimEnd().split('\n').pop()?.trim();
    return line ? `Last log line: ${line.slice(0, 300)}\n` : '';
  } catch {
    return '';
  }
}

export async function stopServer(repo: RepoPaths): Promise<ServerInfo | null> {
  const info = await findServer(repo);
  if (!info) return null;
  try {
    await request(info.port, 'POST', '/api/shutdown', {}, 3000);
  } catch {
    /* fall back to a signal */
  }
  for (let i = 0; i < 50; i++) {
    if (!alive(info.pid)) return info;
    await sleep(100);
  }
  try {
    process.kill(info.pid, 'SIGTERM');
  } catch {
    /* gone */
  }
  return info;
}
