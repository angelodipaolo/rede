import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import type { Health } from '../shared/types.ts';
import { marginDir, type RepoPaths } from '../server/git.ts';
import { readServerInfo, serverInfoPath, type ServerInfo } from '../server/server.ts';

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

async function healthy(repo: RepoPaths, info: ServerInfo | null): Promise<boolean> {
  if (!info) return false;
  try {
    const h = await request<Health>(info.port, 'GET', '/api/health', undefined, 1500);
    return h.name === 'margin' && h.pid === info.pid && h.repo.root === repo.root;
  } catch {
    return false;
  }
}

/** Returns the running server for this repo, or null. Never starts one. */
export async function findServer(repo: RepoPaths): Promise<ServerInfo | null> {
  const info = readServerInfo(repo);
  return (await healthy(repo, info)) ? info : null;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Returns the running server, starting a detached one when none runs. */
export async function ensureServer(repo: RepoPaths, cliPath: string): Promise<ServerInfo> {
  const existing = await findServer(repo);
  if (existing) return existing;
  const dir = marginDir(repo);
  fs.mkdirSync(dir, { recursive: true });
  const lock = path.join(dir, 'start.lock');
  let haveLock = false;
  for (let i = 0; i < 100 && !haveLock; i++) {
    try {
      fs.writeFileSync(lock, String(process.pid), { flag: 'wx' });
      haveLock = true;
    } catch {
      // Someone else is starting it. Use theirs once it is up; break a stale lock.
      const info = await findServer(repo);
      if (info) return info;
      try {
        if (Date.now() - fs.statSync(lock).mtimeMs > 10_000) fs.unlinkSync(lock);
      } catch {
        /* gone */
      }
      await sleep(100);
    }
  }
  try {
    const again = await findServer(repo);
    if (again) return again;
    const stale = readServerInfo(repo);
    if (stale) {
      try {
        fs.unlinkSync(serverInfoPath(repo));
      } catch {
        /* gone */
      }
    }
    const log = fs.openSync(path.join(dir, 'server.log'), 'a');
    const child = spawn(process.execPath, [cliPath, '__serve'], {
      cwd: repo.root,
      detached: true,
      stdio: ['ignore', log, log],
      env: process.env,
    });
    child.unref();
    fs.closeSync(log);
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      await sleep(80);
      const info = readServerInfo(repo);
      if (info && info.pid === child.pid && (await healthy(repo, info))) return info;
      if (child.exitCode !== null) break;
    }
    throw new Error(`The Margin server did not start. See ${path.join(dir, 'server.log')}.`);
  } finally {
    if (haveLock) {
      try {
        fs.unlinkSync(lock);
      } catch {
        /* gone */
      }
    }
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
    try {
      process.kill(info.pid, 0);
    } catch {
      return info;
    }
    await sleep(100);
  }
  try {
    process.kill(info.pid, 'SIGTERM');
  } catch {
    /* gone */
  }
  return info;
}
