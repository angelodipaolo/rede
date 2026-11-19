import { createHash } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { Dashboard, DashboardWorkspace, HubEvent, WorkspaceInfo } from '../shared/types.ts';
import { badRequest, notFound } from './errors.ts';
import { discoverRepo, redeDir, readHeadSync, type RepoPaths } from './git.ts';
import { Rede, type RedeOptions } from './service.ts';
import { Store } from './store.ts';

/** Rede's per-user directory: $REDE_HOME, else ~/.rede. */
export function redeHome(env: NodeJS.ProcessEnv = process.env): string {
  return path.resolve(env.REDE_HOME || path.join(os.homedir(), '.rede'));
}

/** "<dir name>-<6 hex of the root path>": stable, URL-safe, readable. */
export function workspaceId(root: string): string {
  const name = path.basename(root).replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'repo';
  return `${name}-${createHash('sha1').update(root).digest('hex').slice(0, 6)}`;
}

/** The repository a worktree belongs to: the directory around its common git dir. */
function repoOf(repo: RepoPaths): { name: string; commonDir: string } {
  const common = repo.commonDir;
  const base = path.basename(common);
  const dir = base === '.git' ? path.dirname(common) : common.replace(/\.git$/, '');
  return { name: path.basename(dir) || base, commonDir: common };
}

interface Entry {
  info: Omit<WorkspaceInfo, 'branch' | 'missing'>;
  repo: RepoPaths | null;
  rede: Rede | null;
  opening: Promise<Rede> | null;
}

export interface HubOptions extends Omit<RedeOptions, 'repo' | 'store'> {
  home: string;
}

/**
 * Holds one Rede service per worktree, opened on first use. The registry of worktrees
 * (workspaces.json in the home) survives restarts, so the dashboard lists every worktree that
 * ever ran rede, and review URLs keep working.
 */
export class Hub {
  readonly home: string;
  private readonly opts: HubOptions;
  private readonly entries = new Map<string, Entry>();
  private readonly listeners = new Set<(ev: HubEvent) => void>();
  private changeTimer: NodeJS.Timeout | null = null;
  private changed: { workspace: string | null; review: string | null } | null = null;
  private closed = false;
  /** Called on any activity of a workspace service (idle shutdown). */
  onActivity: () => void = () => {};

  constructor(opts: HubOptions) {
    this.opts = opts;
    this.home = opts.home;
    fs.mkdirSync(this.home, { recursive: true });
    for (const info of this.readRegistry()) this.entries.set(info.id, { info, repo: null, rede: null, opening: null });
  }

  private get registryFile(): string {
    return path.join(this.home, 'workspaces.json');
  }

  private readRegistry(): Entry['info'][] {
    try {
      const list = JSON.parse(fs.readFileSync(this.registryFile, 'utf8')) as Entry['info'][];
      return Array.isArray(list) ? list.filter((w) => w && typeof w.id === 'string' && typeof w.root === 'string') : [];
    } catch {
      return [];
    }
  }

  private writeRegistry(): void {
    const list = [...this.entries.values()].map((e) => e.info);
    const tmp = `${this.registryFile}.${process.pid}.tmp`;
    try {
      fs.writeFileSync(tmp, JSON.stringify(list, null, 2));
      fs.renameSync(tmp, this.registryFile);
    } catch (e) {
      console.error('rede: cannot write the workspace registry:', e);
    }
  }

  private publicInfo(e: Entry): WorkspaceInfo {
    const missing = !fs.existsSync(e.info.root);
    let branch: string | null = null;
    if (!missing && e.repo) branch = readHeadSync(e.repo).branch;
    return { ...e.info, branch, missing };
  }

  /** Registers the worktree that contains `dir` (or finds it). */
  async register(dir: string): Promise<WorkspaceInfo> {
    if (typeof dir !== 'string' || !path.isAbsolute(dir)) throw badRequest('root must be an absolute path.');
    // Fast path: the CLI sends the worktree root it found itself. A known, open worktree needs no git call.
    const known = this.entries.get(workspaceId(dir));
    if (known?.rede && known.info.root === dir && fs.existsSync(path.join(dir, '.git'))) {
      known.info = { ...known.info, lastUsedAt: new Date().toISOString() };
      this.writeRegistrySoon();
      return this.publicInfo(known);
    }
    let repo: RepoPaths;
    try {
      repo = await discoverRepo(dir);
    } catch (e) {
      throw badRequest(`${dir}: ${(e as Error).message}`);
    }
    const id = workspaceId(repo.root);
    const now = new Date().toISOString();
    let e = this.entries.get(id);
    if (!e) {
      e = { info: { id, root: repo.root, name: path.basename(repo.root), repo: repoOf(repo), addedAt: now, lastUsedAt: now }, repo, rede: null, opening: null };
      this.entries.set(id, e);
      this.writeRegistry();
      this.notify(id, null);
    } else {
      e.repo = repo;
      e.info = { ...e.info, repo: repoOf(repo), lastUsedAt: now };
      // Keep the file small in writes: lastUsedAt is a hint, written at most once a minute.
      this.writeRegistrySoon();
    }
    await this.rede(id);
    return this.publicInfo(e);
  }

  private registryTimer: NodeJS.Timeout | null = null;
  private writeRegistrySoon(): void {
    if (this.registryTimer) return;
    this.registryTimer = setTimeout(() => {
      this.registryTimer = null;
      this.writeRegistry();
    }, 60_000);
    this.registryTimer.unref();
  }

  forget(id: string): void {
    const e = this.entries.get(id);
    if (!e) throw notFound(`Workspace "${id}" not found.`);
    e.rede?.close();
    e.rede?.store.close();
    this.entries.delete(id);
    this.writeRegistry();
    this.notify(id, null);
  }

  workspace(id: string): WorkspaceInfo {
    const e = this.entries.get(id);
    if (!e) throw notFound(`Workspace "${id}" not found. Run rede in that worktree.`);
    return this.publicInfo(e);
  }

  list(): WorkspaceInfo[] {
    return [...this.entries.values()].map((e) => this.publicInfo(e));
  }

  /** The service of one workspace. Opens its database on first use. */
  rede(id: string): Promise<Rede> {
    const e = this.entries.get(id);
    if (!e) return Promise.reject(notFound(`Workspace "${id}" not found. Run rede in that worktree.`));
    if (e.rede) return Promise.resolve(e.rede);
    if (e.opening) return e.opening;
    e.opening = (async () => {
      if (this.closed) throw new Error('The Rede server is shutting down.');
      if (!fs.existsSync(e.info.root)) throw notFound(`The worktree ${e.info.root} no longer exists.`);
      const repo = e.repo ?? (await discoverRepo(e.info.root));
      e.repo = repo;
      const dir = redeDir(repo);
      fs.mkdirSync(dir, { recursive: true });
      await stopLegacyServer(repo);
      const store = await Store.open(path.join(dir, 'rede.db'));
      const { home: _home, ...rest } = this.opts;
      const rede = new Rede({ ...rest, repo, store });
      rede.workspaceId = id;
      rede.onActivity = () => this.onActivity();
      rede.onChange = (review) => this.notify(id, review);
      e.rede = rede;
      return rede;
    })();
    e.opening.catch(() => {}).finally(() => {
      if (e) e.opening = null;
    });
    return e.opening;
  }

  /** Services that are open now. */
  open(): Rede[] {
    return [...this.entries.values()].flatMap((e) => (e.rede ? [e.rede] : []));
  }

  get subscriberCount(): number {
    return this.open().reduce((n, r) => n + r.subscriberCount, 0) + this.listeners.size;
  }

  get waiterCount(): number {
    return this.open().reduce((n, r) => n + r.waiterCount, 0);
  }

  async dashboard(): Promise<Dashboard> {
    const workspaces: DashboardWorkspace[] = [];
    let awaiting = 0;
    for (const e of this.entries.values()) {
      const info = this.publicInfo(e);
      let rede: Rede | null = null;
      if (!info.missing) rede = await this.rede(info.id).catch(() => null);
      const reviews = rede ? rede.listReviews() : [];
      awaiting += reviews.filter((r) => r.awaiting).length;
      workspaces.push({ ...info, reviews, agents: rede ? rede.agents() : [] });
    }
    return { workspaces, awaiting };
  }

  /** Listens to dashboard changes. Returns the unsubscribe function. */
  listen(fn: (ev: HubEvent) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Coalesces changes into one dashboard event per 150 ms. */
  private notify(workspace: string | null, review: string | null): void {
    if (this.closed) return;
    this.changed = this.changed ? { workspace: this.changed.workspace === workspace ? workspace : null, review: this.changed.review === review ? review : null } : { workspace, review };
    if (this.changeTimer) return;
    this.changeTimer = setTimeout(() => {
      this.changeTimer = null;
      const c = this.changed ?? { workspace: null, review: null };
      this.changed = null;
      if (!this.listeners.size) return;
      void this.dashboard().then((d) => {
        const ev: HubEvent = { type: 'dashboard', awaiting: d.awaiting, workspace: c.workspace, review: c.review };
        for (const l of this.listeners) {
          try {
            l(ev);
          } catch {
            /* closed stream */
          }
        }
      });
    }, 150);
    this.changeTimer.unref();
  }

  close(): void {
    this.closed = true;
    if (this.changeTimer) clearTimeout(this.changeTimer);
    if (this.registryTimer) {
      clearTimeout(this.registryTimer);
      this.registryTimer = null;
      this.writeRegistry();
    }
    for (const e of this.entries.values()) e.rede?.close();
  }

  closeStores(): void {
    for (const e of this.entries.values()) {
      try {
        e.rede?.store.close();
      } catch {
        /* closed */
      }
    }
  }
}

/**
 * Rede before the hub ran one server per worktree (<git-dir>/rede/server.json). Two processes
 * snapshotting one worktree would fight over its private index, so the hub asks an old server
 * of this worktree to stop before it opens the worktree.
 */
async function stopLegacyServer(repo: RepoPaths): Promise<void> {
  const file = path.join(redeDir(repo), 'server.json');
  let info: { pid: number; port: number } | null = null;
  try {
    info = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return;
  }
  if (!info || info.pid === process.pid) return;
  const health = await new Promise<{ name?: string; pid?: number; repo?: { root?: string } } | null>((resolve) => {
    const req = http.get({ host: '127.0.0.1', port: info!.port, path: '/api/health', timeout: 1500 }, (res) => {
      let text = '';
      res.on('data', (c) => (text += c));
      res.on('end', () => {
        try {
          resolve(JSON.parse(text));
        } catch {
          resolve(null);
        }
      });
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(null));
  });
  if (health?.name === 'rede' && health.pid === info.pid && health.repo?.root === repo.root) {
    await new Promise<void>((resolve) => {
      const req = http.request({ host: '127.0.0.1', port: info!.port, method: 'POST', path: '/api/shutdown', timeout: 1500 }, (res) => {
        res.resume();
        res.on('end', () => resolve());
      });
      req.on('timeout', () => req.destroy());
      req.on('error', () => resolve());
      req.end();
    });
    for (let i = 0; i < 30; i++) {
      try {
        process.kill(info.pid, 0);
      } catch {
        break;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  try {
    fs.unlinkSync(file);
  } catch {
    /* gone */
  }
}
