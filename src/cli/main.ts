import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  AgentPresence,
  AgentThread,
  HistoryEntry,
  HistoryPage,
  Review,
  ReviewScope,
  ReviewSpec,
  ReviewSummary,
  PublishResponse,
  Thread,
  WaitResponse,
  WorkspaceInfo,
} from '../shared/types.ts';
import { VERSION } from '../server/errors.ts';
import { currentBranch, defaultBranch, discoverRepo, git, type RepoPaths } from '../server/git.ts';
import { appUrl, webUrl } from '../server/http.ts';
import { ApiFailure, detectAgentName, ensureServer, findServer, inCodex, request, stopServer, streamTo } from './client.ts';
import { formatAgentThread, formatDiff, formatThreadLine, formatWait, location } from './format.ts';
import { GUIDE, setup } from './guide.ts';
import { historyMarkdown } from '../shared/history-md.ts';

const CLI_PATH = fileURLToPath(import.meta.url);
const WEB_DIR = path.join(path.dirname(CLI_PATH), 'web');
const DEFAULT_WAIT_SECONDS = 100;

const USAGE = `rede ${VERSION}: local code review with coding agents

Open a review in the browser:
  rede                  uncommitted changes (or the branch vs. the default branch when clean)
  rede -w               uncommitted changes, always
  rede <base>           this branch against <base> (merge-base -> working tree)
  rede <a>..<b>         a range of commits
  rede -c <rev>         one commit (also: rede commit <rev>)
  --no-open               print the URL, do not open it
  --browser               open in the browser even when the Rede app is installed

Server:
  rede status | list | stop

Agents (default output is markdown for an LLM; --json for raw JSON):
  rede publish [-m <summary>] [<base>|<a>..<b>|-c <rev>|-w] [--review <id>] [--not-ready]
                                       give the change a short summary, mark it ready for
                                       human review, print the review URL (summary on stdin without -m)
  rede inbox                           print the feedback waiting for you now; never blocks
  rede wait [--timeout <sec>]          block until a comment needs an answer (watch mode)
  rede reply <id> [-m <text>] [--resolve]   (reads stdin when -m is absent)
  rede comment <path>[:<line>[-<end>]] [--old] [--staged|--unstaged] [-m <text>]
  rede threads [--all|--pending]
  rede show <id> | resolve <id> | release
  rede diff [--stat] [--staged|--unstaged]
  rede guide            print the agent instructions

History:
  rede export [--review <id>] [--since <date>] [-o <file>]
                          write past reviews and threads as Markdown (stdout without -o)
  rede setup            install the guide as a Claude Code and Codex skill, and a Codex
                          rule that runs rede agent commands outside the Codex sandbox
Common: --as <agent name>, --review <review id>
`;

// ------------------------------------------------------------------ args

interface Args {
  pos: string[];
  flags: Map<string, string | true>;
}

const VALUE_FLAGS = new Set(['--as', '--review', '--timeout', '-m', '--message', '-c', '--commit', '--since', '-o', '--output']);

function parseArgs(argv: string[]): Args {
  const pos: string[] = [];
  const flags = new Map<string, string | true>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--') {
      pos.push(...argv.slice(i + 1));
      break;
    }
    if (a.startsWith('--') && a.includes('=')) {
      const eq = a.indexOf('=');
      flags.set(a.slice(0, eq), a.slice(eq + 1));
    } else if (VALUE_FLAGS.has(a)) {
      const v = argv[i + 1];
      if (v === undefined) throw new UserError(`${a} needs a value.`);
      flags.set(a, v);
      i++;
    } else if (a.startsWith('-') && a.length > 1) {
      flags.set(a, true);
    } else pos.push(a);
  }
  return { pos, flags };
}

class UserError extends Error {}

function str(args: Args, ...names: string[]): string | undefined {
  for (const n of names) {
    const v = args.flags.get(n);
    if (typeof v === 'string') return v;
  }
  return undefined;
}

function has(args: Args, ...names: string[]): boolean {
  return names.some((n) => args.flags.has(n));
}

// ------------------------------------------------------------------ helpers

/**
 * Codex runs a command outside its sandbox (rule from `rede setup`) only when the command has no
 * heredoc or redirection, so Codex passes the reply with -m instead of on stdin.
 */
function argStyle(name: string): boolean {
  return name === 'codex' || inCodex();
}

function agentName(args: Args): string {
  return str(args, '--as')?.trim() || detectAgentName();
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

async function messageBody(args: Args): Promise<string> {
  const m = str(args, '-m', '--message');
  if (m !== undefined) return m;
  if (process.stdin.isTTY) throw new UserError('Give the message with -m "<text>" or on stdin (heredoc).');
  const body = await readStdin();
  if (!body.trim()) throw new UserError('The message is empty.');
  return body.replace(/\n+$/, '');
}

function out(text: string): void {
  process.stdout.write(text.endsWith('\n') ? text : text + '\n');
}

function scopeOf(args: Args): ReviewScope {
  if (has(args, '--staged')) return 'staged';
  if (has(args, '--unstaged')) return 'unstaged';
  return 'all';
}

function openBrowser(url: string): void {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const a = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  try {
    spawn(cmd, a, { detached: true, stdio: 'ignore' }).unref();
  } catch {
    /* the URL is printed anyway */
  }
}

interface Ctx {
  repo: RepoPaths;
  port: number;
  workspace: WorkspaceInfo;
  /** Path prefix of this worktree's API: /api/w/<workspace id>. */
  base: string;
}

/** Finds the worktree, makes sure the hub runs, and registers the worktree with it. */
async function connect(known?: RepoPaths): Promise<Ctx> {
  const repo = known ?? (await discoverRepo(process.cwd()));
  const info = await ensureServer(CLI_PATH);
  const workspace = await request<WorkspaceInfo>(info.port, 'POST', '/api/workspaces', { root: repo.root });
  return { repo, port: info.port, workspace, base: `/api/w/${encodeURIComponent(workspace.id)}` };
}

/** A request to this worktree's API. `p` is relative to the workspace, e.g. "/reviews". */
const api = <T>(c: Ctx, method: string, p: string, body?: unknown) => request<T>(c.port, method, c.base + p, body);

/** Where the review opens: the Rede app when it is installed, else the browser. */
function appInstalled(): boolean {
  if (process.env.REDE_OPEN === 'browser') return false;
  if (process.env.REDE_OPEN === 'app') return true;
  if (process.platform !== 'darwin') return false;
  return APP_PATHS().some((p) => fs.existsSync(p));
}

const APP_PATHS = () => ['/Applications/Rede.app', path.join(process.env.HOME ?? '', 'Applications', 'Rede.app')];

function reviewUrls(c: Ctx, id: string): { appUrl: string; webUrl: string } {
  return { appUrl: appUrl(c.workspace.id, id), webUrl: webUrl(c.port, c.workspace.id, id) };
}
const enc = encodeURIComponent;

/** --review, else the most recently opened review, else the working review (created). */
async function pickReview(c: Ctx, args: Args): Promise<string> {
  const given = str(args, '--review');
  if (given) return given;
  const list = await api<ReviewSummary[]>(c, 'GET', '/reviews');
  if (list[0]) return list[0].id;
  const r = await api<ReviewSummary>(c, 'POST', '/reviews', { spec: { kind: 'working' } });
  return r.id;
}

// ------------------------------------------------------------------ commands

async function cmdOpen(args: Args, spec: ReviewSpec | null): Promise<void> {
  const repo = await discoverRepo(process.cwd());
  if (!spec) {
    spec = { kind: 'working' };
    if (!has(args, '-w', '--working')) {
      // GIT_OPTIONAL_LOCKS=0: a plain `git status` refreshes the real index and takes
      // .git/index.lock to write it back, so a commit or checkout the user (or an agent) runs at
      // the same moment fails with "index.lock: File exists". Rede only reads here.
      const status = await git(['status', '--porcelain', '--untracked-files=normal'], { cwd: repo.root, env: { GIT_OPTIONAL_LOCKS: '0' } });
      const branch = await currentBranch(repo.root);
      if (!status.trim() && branch) {
        const def = await defaultBranch(repo.root);
        if (def && def !== branch && def !== `origin/${branch}`) spec = { kind: 'branch', base: def, head: branch };
      }
    }
  }
  const c = await connect(repo);
  const r = await api<ReviewSummary>(c, 'POST', '/reviews', { spec });
  const urls = reviewUrls(c, r.id);
  const inApp = !has(args, '--browser') && appInstalled();
  if (!has(args, '--no-open')) openBrowser(inApp ? urls.appUrl : urls.webUrl);
  out(`${r.title}\n${urls.webUrl}${inApp ? `\n${urls.appUrl}` : ''}`);
}

/**
 * The review an agent publishes by default: on a branch other than the default branch, the branch
 * against the default branch (it includes uncommitted changes, like a pull request with local
 * fixes); else the uncommitted changes.
 */
async function publishSpec(repo: RepoPaths, args: Args): Promise<ReviewSpec> {
  const commit = str(args, '-c', '--commit');
  if (commit) return { kind: 'commit', rev: commit };
  const pos = args.pos[1];
  if (pos) return rangeSpec(pos) ?? { kind: 'branch', base: pos, head: (await currentBranch(repo.root)) ?? 'HEAD' };
  if (has(args, '-w', '--working')) return { kind: 'working' };
  const branch = await currentBranch(repo.root);
  if (branch) {
    const def = await defaultBranch(repo.root);
    if (def && def !== branch && def !== `origin/${branch}`) return { kind: 'branch', base: def, head: branch };
  }
  return { kind: 'working' };
}

async function cmdPublish(args: Args): Promise<void> {
  const summary = await messageBody(args);
  const name = agentName(args);
  const repo = await discoverRepo(process.cwd());
  const c = await connect(repo);
  let id = str(args, '--review');
  if (!id) id = (await api<ReviewSummary>(c, 'POST', '/reviews', { spec: await publishSpec(repo, args) })).id;
  const r = await api<PublishResponse>(c, 'POST', `/reviews/${enc(id)}/publish`, { summary, author: { kind: 'agent', name }, ready: !has(args, '--not-ready') });
  if (has(args, '--json')) return out(JSON.stringify(r, null, 2));
  const primary = appInstalled() ? r.appUrl : r.webUrl;
  if (has(args, '--open')) openBrowser(primary);
  const lines = [
    r.review.awaiting ? `Published "${r.review.title}" (${c.workspace.name}) for human review as ${name}.` : `Updated the summary of "${r.review.title}" (${c.workspace.name}); it is not marked ready.`,
    `Review URL: ${primary}`,
  ];
  if (primary !== r.webUrl) lines.push(`Browser URL: ${r.webUrl}`);
  lines.push('Put the review URL in your final response. When the user has reviewed, `rede inbox` prints their feedback.');
  out(lines.join('\n'));
}

async function cmdStatus(args: Args): Promise<void> {
  const info = await findServer();
  let repo: RepoPaths | null = null;
  try {
    repo = await discoverRepo(process.cwd());
  } catch {
    /* outside a repository: hub status only */
  }
  if (!info) {
    if (has(args, '--json')) return out(JSON.stringify({ running: false }));
    return out('Rede server: not running.');
  }
  const workspaces = await request<WorkspaceInfo[]>(info.port, 'GET', '/api/workspaces');
  const mine = repo ? workspaces.find((w) => w.root === repo!.root) : undefined;
  let reviews: ReviewSummary[] = [];
  let agents: AgentPresence[] = [];
  if (mine) {
    const base = `/api/w/${enc(mine.id)}`;
    [reviews, agents] = await Promise.all([
      request<ReviewSummary[]>(info.port, 'GET', `${base}/reviews`),
      request<AgentPresence[]>(info.port, 'GET', `${base}/agents`),
    ]);
  }
  if (has(args, '--json')) return out(JSON.stringify({ running: true, server: info, workspaces, workspace: mine ?? null, reviews, agents }, null, 2));
  const lines = [
    `Rede server: running, pid ${info.pid}, http://127.0.0.1:${info.port}, since ${info.startedAt}`,
    `Workspaces: ${workspaces.length} (${info.home ?? ''})`,
  ];
  if (repo) lines.push(`This worktree: ${repo.root}${mine ? ` (workspace ${mine.id})` : ' (not registered yet; run rede)'}`);
  if (mine) {
    lines.push(reviews.length ? 'Reviews:' : 'Reviews: none');
    for (const r of reviews) lines.push(`  ${r.id}  ${r.title}  (${r.threadCount} threads, ${r.unresolvedCount} open${r.awaiting ? ', ready for review' : ''})  ${webUrl(info.port, mine.id, r.id)}`);
    lines.push(agents.length ? `Agents: ${agents.map((a) => `${a.name} (${a.state})`).join(', ')}` : 'Agents: none connected');
  }
  out(lines.join('\n'));
}

async function cmdList(args: Args): Promise<void> {
  const c = await connect();
  const reviews = await api<ReviewSummary[]>(c, 'GET', '/reviews');
  if (has(args, '--json')) return out(JSON.stringify(reviews, null, 2));
  if (!reviews.length) return out('No reviews yet. Run `rede` to open one.');
  out(reviews.map((r) => `${r.id}  ${r.title}  (${r.threadCount} threads, ${r.unresolvedCount} open)  ${reviewUrls(c, r.id).webUrl}`).join('\n'));
}

async function cmdStop(): Promise<void> {
  const info = await stopServer();
  out(info ? `Stopped the Rede server (pid ${info.pid}).` : 'No Rede server is running.');
}

async function cmdWait(args: Args): Promise<void> {
  const name = agentName(args);
  const t = Number(str(args, '--timeout') ?? DEFAULT_WAIT_SECONDS);
  if (!Number.isFinite(t) || t < 0) throw new UserError('--timeout must be a number of seconds.');
  const c = await connect();
  const review = str(args, '--review');
  const q = `agent=${enc(name)}&timeout=${Math.floor(t)}${review ? `&review=${enc(review)}` : ''}`;
  let r: WaitResponse;
  try {
    r = await api<WaitResponse>(c, 'GET', `/agent/wait?${q}`);
  } catch (e) {
    // The server stopped or restarted (a newer rede build) while this wait was blocked.
    if (e instanceof ApiFailure) throw e;
    return out('The Rede server restarted while waiting. No new comments. Run `rede wait` again.');
  }
  if (has(args, '--json')) return out(JSON.stringify(r, null, 2));
  if (r.timedOut || !r.threads.length) return out('No new comments. Run `rede wait` again.');
  out(formatWait(r, name, argStyle(name)));
}

/** `rede inbox`: the same delivery and claiming as `wait`, without blocking (timeout 0). */
async function cmdInbox(args: Args): Promise<void> {
  const name = agentName(args);
  const c = await connect();
  const review = str(args, '--review');
  const r = await api<WaitResponse>(c, 'GET', `/agent/wait?agent=${enc(name)}&timeout=0${review ? `&review=${enc(review)}` : ''}`);
  if (has(args, '--json')) return out(JSON.stringify(r, null, 2));
  if (!r.threads.length) return out('No feedback is waiting.');
  out(formatWait(r, name, argStyle(name), 'inbox'));
}

async function cmdExport(args: Args): Promise<void> {
  const c = await connect();
  const review = str(args, '--review');
  const since = str(args, '--since');
  const entries: HistoryEntry[] = [];
  let before: string | null = null;
  do {
    const q = new URLSearchParams({ limit: '500' });
    if (review) q.set('review', review);
    if (since) q.set('since', since);
    if (before) q.set('before', before);
    const page: HistoryPage = await api<HistoryPage>(c, 'GET', `/history?${q}`);
    entries.push(...page.entries);
    before = page.next;
  } while (before);
  const filter = [review ? `review ${review}` : null, since ? `since ${since}` : null].filter(Boolean).join(', ');
  const text = historyMarkdown(entries, { repo: path.basename(c.repo.root), exportedAt: new Date().toISOString(), filter: filter || undefined });
  const file = str(args, '-o', '--output');
  if (!file) return out(text);
  fs.writeFileSync(path.resolve(process.cwd(), file), text);
  out(`Wrote ${entries.length} entr${entries.length === 1 ? 'y' : 'ies'} to ${file}.`);
}

function threadId(s: string | undefined): number {
  const n = Number(String(s ?? '').replace(/^#/, ''));
  if (!Number.isInteger(n) || n <= 0) throw new UserError(`Expected a thread id, got "${s ?? ''}".`);
  return n;
}

async function cmdReply(args: Args): Promise<void> {
  const id = threadId(args.pos[1]);
  const body = await messageBody(args);
  const name = agentName(args);
  const c = await connect();
  const t = await api<Thread>(c, 'POST', `/threads/${id}/messages`, { body, author: { kind: 'agent', name }, resolve: has(args, '--resolve') });
  if (has(args, '--json')) return out(JSON.stringify(t, null, 2));
  out(`Replied to thread #${id} as ${name}${t.resolved ? ' and resolved it' : ''}.`);
}

async function cmdComment(args: Args): Promise<void> {
  const target = args.pos[1];
  if (!target) throw new UserError('Usage: rede comment <path>[:<line>[-<end>]] [-m <text>]');
  const m = /^(.*?):(\d+)(?:-(\d+))?$/s.exec(target);
  const rawPath = m ? m[1]! : target;
  const start = m ? Number(m[2]) : null;
  const end = m ? Number(m[3] ?? m[2]) : null;
  const body = await messageBody(args);
  const name = agentName(args);
  const c = await connect();
  const reviewId = await pickReview(c, args);
  const scope = scopeOf(args);
  const side = has(args, '--old') ? 'old' : 'new';
  // Accept repo-relative paths, paths relative to the current directory, and absolute paths.
  const candidates = new Set<string>();
  const abs = path.resolve(process.cwd(), rawPath);
  if (path.isAbsolute(rawPath) || process.cwd() !== c.repo.root) candidates.add(path.relative(c.repo.root, abs).split(path.sep).join('/'));
  candidates.add(rawPath.replace(/^\.\//, ''));
  let lastErr: unknown = null;
  for (const p of candidates) {
    try {
      const t = await api<Thread>(c, 'POST', `/reviews/${enc(reviewId)}/threads?scope=${scope}`, {
        anchor: { path: p, side, startLine: start, endLine: end },
        body,
        author: { kind: 'agent', name },
      });
      if (has(args, '--json')) return out(JSON.stringify(t, null, 2));
      return out(`Created thread #${t.id} on ${location(t)} in review ${reviewId}.`);
    } catch (e) {
      lastErr = e;
      if (!(e instanceof ApiFailure && e.status === 400 && e.message.includes('is not in the diff'))) throw e;
    }
  }
  throw lastErr;
}

async function cmdThreads(args: Args): Promise<void> {
  const state = has(args, '--all') ? 'all' : has(args, '--pending') ? 'pending' : 'open';
  const c = await connect();
  const review = str(args, '--review');
  const list = await api<AgentThread[]>(c, 'GET', `/agent/threads?state=${state}${review ? `&review=${enc(review)}` : ''}`);
  if (has(args, '--json')) return out(JSON.stringify(list, null, 2));
  if (!list.length) return out(`No ${state === 'all' ? '' : state + ' '}threads.`);
  out([`${list.length} ${state} thread(s). Show one with \`rede show <id>\`.`, ...list.map(formatThreadLine)].join('\n'));
}

async function cmdShow(args: Args): Promise<void> {
  const id = threadId(args.pos[1]);
  const c = await connect();
  const at = await api<AgentThread>(c, 'GET', `/agent/threads/${id}`);
  if (has(args, '--json')) return out(JSON.stringify(at, null, 2));
  out(formatAgentThread(at, agentName(args), { replyHint: true, argStyle: argStyle(agentName(args)) }));
}

async function cmdResolve(args: Args): Promise<void> {
  const id = threadId(args.pos[1]);
  const c = await connect();
  const t = await api<Thread>(c, 'PATCH', `/threads/${id}`, { resolved: true });
  if (has(args, '--json')) return out(JSON.stringify(t, null, 2));
  out(`Resolved thread #${id}.`);
}

async function cmdRelease(args: Args): Promise<void> {
  const name = agentName(args);
  const c = await connect();
  const r = await api<{ released: number }>(c, 'POST', '/agent/release', { agent: name });
  if (has(args, '--json')) return out(JSON.stringify(r));
  out(`Released ${r.released} thread(s) held by ${name}.`);
}

async function cmdDiff(args: Args): Promise<void> {
  const c = await connect();
  const id = await pickReview(c, args);
  const r = await api<Review>(c, 'GET', `/reviews/${enc(id)}?scope=${scopeOf(args)}&fresh=1`);
  if (has(args, '--json')) return out(JSON.stringify(r, null, 2));
  out(formatDiff(r, has(args, '--stat')));
  if (has(args, '--stat')) return;
  // The patch is streamed as git prints it: no per-file parsing, constant memory.
  await streamTo(c.port, `${c.base}/reviews/${enc(id)}/patch?scope=${scopeOf(args)}`, process.stdout);
}

function cmdSetup(): void {
  const lines: string[] = [];
  for (const r of setup()) {
    lines.push(`${r.status.padEnd(9)} ${r.path}  (${r.what})`);
    if ((r.status === 'created' || r.status === 'updated') && r.path.endsWith('.rules')) lines.push(...r.content.trimEnd().split('\n').map((l) => `          ${l}`));
  }
  out(lines.join('\n'));
  out('Next: after you submit a review in Rede, tell your agent "Address the Rede feedback." To have it answer comments live, say "Watch Rede and answer my comments live."');
  out('To have agents publish finished work for review, add one line to your AGENTS.md or CLAUDE.md: "When you finish a task, run `rede publish` with a short summary and include the review URL in your final response."');
  out('Codex: start a new Codex session so it loads the rule. Run `rede setup` again after you update Rede: the rule lists the rede subcommands Codex may run.');
}

function rangeSpec(s: string): ReviewSpec | null {
  const m = /^(.+?)\.\.(\.)?(.+)$/.exec(s);
  if (!m || m[2]) return null;
  return { kind: 'range', from: m[1]!, to: m[3]! };
}

async function main(argv: string[]): Promise<void> {
  if (argv[0] === '__serve') {
    const { runServerProcess } = await import('../server/server.ts');
    await runServerProcess(fs.existsSync(WEB_DIR) ? WEB_DIR : null, CLI_PATH);
    return;
  }
  const args = parseArgs(argv);
  const cmd = args.pos[0];
  if (has(args, '-h', '--help') || cmd === 'help') return out(USAGE);
  if (has(args, '-v', '--version') || cmd === 'version') return out(VERSION);
  const commit = str(args, '-c', '--commit');
  if (cmd === 'publish') return cmdPublish(args);
  if (commit) return cmdOpen(args, { kind: 'commit', rev: commit });
  switch (cmd) {
    case undefined:
      return cmdOpen(args, null);
    case 'commit':
      if (!args.pos[1]) throw new UserError('Usage: rede commit <rev>');
      return cmdOpen(args, { kind: 'commit', rev: args.pos[1] });
    case 'status':
      return cmdStatus(args);
    case 'list':
      return cmdList(args);
    case 'stop':
      return cmdStop();
    case 'wait':
      return cmdWait(args);
    case 'inbox':
      return cmdInbox(args);
    case 'export':
      return cmdExport(args);
    case 'reply':
      return cmdReply(args);
    case 'comment':
      return cmdComment(args);
    case 'threads':
      return cmdThreads(args);
    case 'show':
      return cmdShow(args);
    case 'resolve':
      return cmdResolve(args);
    case 'release':
      return cmdRelease(args);
    case 'diff':
      return cmdDiff(args);
    case 'guide':
      return out(GUIDE);
    case 'setup':
      return cmdSetup();
    default: {
      if (args.pos.length > 1) throw new UserError(`Unknown command "${args.pos.join(' ')}". Run rede --help.`);
      const range = rangeSpec(cmd);
      if (range) return cmdOpen(args, range);
      const branch = await currentBranch(process.cwd());
      return cmdOpen(args, { kind: 'branch', base: cmd, head: branch ?? 'HEAD' });
    }
  }
}

main(process.argv.slice(2)).catch((e: unknown) => {
  const msg = e instanceof Error ? e.message : String(e);
  process.stderr.write(`rede: ${msg}\n`);
  process.exit(e instanceof UserError || e instanceof ApiFailure ? 2 : 1);
});

