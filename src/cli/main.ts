import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  AgentPresence,
  AgentThread,
  Review,
  ReviewScope,
  ReviewSpec,
  ReviewSummary,
  Thread,
  WaitResponse,
} from '../shared/types.ts';
import { VERSION } from '../server/errors.ts';
import { currentBranch, defaultBranch, discoverRepo, git, type RepoPaths } from '../server/git.ts';
import { ApiFailure, ensureServer, findServer, request, stopServer, streamTo } from './client.ts';
import { formatAgentThread, formatDiff, formatThreadLine, location } from './format.ts';
import { GUIDE, setup } from './guide.ts';

const CLI_PATH = fileURLToPath(import.meta.url);
const WEB_DIR = path.join(path.dirname(CLI_PATH), 'web');
const DEFAULT_WAIT_SECONDS = 100;

const USAGE = `margin ${VERSION}: local code review with coding agents

Open a review in the browser:
  margin                  uncommitted changes (or the branch vs. the default branch when clean)
  margin -w               uncommitted changes, always
  margin <base>           this branch against <base> (merge-base -> working tree)
  margin <a>..<b>         a range of commits
  margin -c <rev>         one commit (also: margin commit <rev>)
  --no-open               print the URL, do not open a browser

Server:
  margin status | list | stop

Agents (default output is markdown for an LLM; --json for raw JSON):
  margin wait [--timeout <sec>]          block until a comment needs an answer
  margin reply <id> [-m <text>] [--resolve]   (reads stdin when -m is absent)
  margin comment <path>[:<line>[-<end>]] [--old] [--staged|--unstaged] [-m <text>]
  margin threads [--all|--pending]
  margin show <id> | resolve <id> | release
  margin diff [--stat] [--staged|--unstaged]
  margin guide            print the agent instructions
  margin setup            install the guide as a Claude Code and Codex skill
Common: --as <agent name>, --review <review id>
`;

// ------------------------------------------------------------------ args

interface Args {
  pos: string[];
  flags: Map<string, string | true>;
}

const VALUE_FLAGS = new Set(['--as', '--review', '--timeout', '-m', '--message', '-c', '--commit']);

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

export function detectAgentName(env: NodeJS.ProcessEnv = process.env): string {
  if (env.MARGIN_AGENT?.trim()) return env.MARGIN_AGENT.trim();
  if (env.CLAUDECODE) return 'claude';
  const codexKeys = ['CODEX_SANDBOX', 'CODEX_SANDBOX_NETWORK_DISABLED', 'CODEX_SESSION_ID', 'CODEX_THREAD_ID', 'CODEX_TOOL_CALL_ID', 'CODEX_CI'];
  if (codexKeys.some((k) => env[k] !== undefined)) return 'codex';
  return 'agent';
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
}

async function connect(): Promise<Ctx> {
  const repo = await discoverRepo(process.cwd());
  const info = await ensureServer(repo, CLI_PATH);
  return { repo, port: info.port };
}

const api = <T>(c: Ctx, method: string, p: string, body?: unknown) => request<T>(c.port, method, p, body);
const enc = encodeURIComponent;

/** --review, else the most recently opened review, else the working review (created). */
async function pickReview(c: Ctx, args: Args): Promise<string> {
  const given = str(args, '--review');
  if (given) return given;
  const list = await api<ReviewSummary[]>(c, 'GET', '/api/reviews');
  if (list[0]) return list[0].id;
  const r = await api<ReviewSummary>(c, 'POST', '/api/reviews', { spec: { kind: 'working' } });
  return r.id;
}

// ------------------------------------------------------------------ commands

async function cmdOpen(args: Args, spec: ReviewSpec | null): Promise<void> {
  const repo = await discoverRepo(process.cwd());
  if (!spec) {
    spec = { kind: 'working' };
    if (!has(args, '-w', '--working')) {
      const status = await git(['status', '--porcelain', '--untracked-files=normal'], { cwd: repo.root });
      const branch = await currentBranch(repo.root);
      if (!status.trim() && branch) {
        const def = await defaultBranch(repo.root);
        if (def && def !== branch && def !== `origin/${branch}`) spec = { kind: 'branch', base: def, head: branch };
      }
    }
  }
  const info = await ensureServer(repo, CLI_PATH);
  const c = { repo, port: info.port };
  const r = await api<ReviewSummary>(c, 'POST', '/api/reviews', { spec });
  const url = `http://127.0.0.1:${info.port}/r/${enc(r.id)}`;
  if (!has(args, '--no-open')) openBrowser(url);
  out(`${r.title}\n${url}`);
}

async function cmdStatus(args: Args): Promise<void> {
  const repo = await discoverRepo(process.cwd());
  const info = await findServer(repo);
  if (!info) {
    if (has(args, '--json')) return out(JSON.stringify({ running: false }));
    return out(`Margin server: not running (${repo.root}).`);
  }
  const c = { repo, port: info.port };
  const [reviews, agents] = await Promise.all([api<ReviewSummary[]>(c, 'GET', '/api/reviews'), api<AgentPresence[]>(c, 'GET', '/api/agents')]);
  if (has(args, '--json')) return out(JSON.stringify({ running: true, server: info, reviews, agents }, null, 2));
  const lines = [`Margin server: running, pid ${info.pid}, http://127.0.0.1:${info.port}, since ${info.startedAt}`, `Repo: ${repo.root}`];
  lines.push(reviews.length ? 'Reviews:' : 'Reviews: none');
  for (const r of reviews) lines.push(`  ${r.id}  ${r.title}  (${r.threadCount} threads, ${r.unresolvedCount} open)  http://127.0.0.1:${info.port}/r/${enc(r.id)}`);
  lines.push(agents.length ? `Agents: ${agents.map((a) => `${a.name} (${a.state})`).join(', ')}` : 'Agents: none connected');
  out(lines.join('\n'));
}

async function cmdList(args: Args): Promise<void> {
  const c = await connect();
  const reviews = await api<ReviewSummary[]>(c, 'GET', '/api/reviews');
  if (has(args, '--json')) return out(JSON.stringify(reviews, null, 2));
  if (!reviews.length) return out('No reviews yet. Run `margin` to open one.');
  out(reviews.map((r) => `${r.id}  ${r.title}  (${r.threadCount} threads, ${r.unresolvedCount} open)  http://127.0.0.1:${c.port}/r/${enc(r.id)}`).join('\n'));
}

async function cmdStop(): Promise<void> {
  const repo = await discoverRepo(process.cwd());
  const info = await stopServer(repo);
  out(info ? `Stopped the Margin server (pid ${info.pid}).` : 'No Margin server is running for this repo.');
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
    r = await api<WaitResponse>(c, 'GET', `/api/agent/wait?${q}`);
  } catch (e) {
    // The server stopped or restarted (a newer margin build) while this wait was blocked.
    if (e instanceof ApiFailure) throw e;
    return out('The Margin server restarted while waiting. No new comments. Run `margin wait` again.');
  }
  if (has(args, '--json')) return out(JSON.stringify(r, null, 2));
  if (r.timedOut || !r.threads.length) return out('No new comments. Run `margin wait` again.');
  const n = r.threads.length;
  const head = `# ${n} thread${n > 1 ? 's' : ''} for you (${name})\nAnswer each one with \`margin reply <id>\`, then run \`margin wait\` again.`;
  out([head, ...r.threads.map((at) => formatAgentThread(at, name, { replyHint: true }))].join('\n\n'));
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
  const t = await api<Thread>(c, 'POST', `/api/threads/${id}/messages`, { body, author: { kind: 'agent', name }, resolve: has(args, '--resolve') });
  if (has(args, '--json')) return out(JSON.stringify(t, null, 2));
  out(`Replied to thread #${id} as ${name}${t.resolved ? ' and resolved it' : ''}. Next: margin wait`);
}

async function cmdComment(args: Args): Promise<void> {
  const target = args.pos[1];
  if (!target) throw new UserError('Usage: margin comment <path>[:<line>[-<end>]] [-m <text>]');
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
      const t = await api<Thread>(c, 'POST', `/api/reviews/${enc(reviewId)}/threads?scope=${scope}`, {
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
  const list = await api<AgentThread[]>(c, 'GET', `/api/agent/threads?state=${state}${review ? `&review=${enc(review)}` : ''}`);
  if (has(args, '--json')) return out(JSON.stringify(list, null, 2));
  if (!list.length) return out(`No ${state === 'all' ? '' : state + ' '}threads.`);
  out([`${list.length} ${state} thread(s). Show one with \`margin show <id>\`.`, ...list.map(formatThreadLine)].join('\n'));
}

async function cmdShow(args: Args): Promise<void> {
  const id = threadId(args.pos[1]);
  const c = await connect();
  const at = await api<AgentThread>(c, 'GET', `/api/agent/threads/${id}`);
  if (has(args, '--json')) return out(JSON.stringify(at, null, 2));
  out(formatAgentThread(at, agentName(args), { replyHint: true }));
}

async function cmdResolve(args: Args): Promise<void> {
  const id = threadId(args.pos[1]);
  const c = await connect();
  const t = await api<Thread>(c, 'PATCH', `/api/threads/${id}`, { resolved: true });
  if (has(args, '--json')) return out(JSON.stringify(t, null, 2));
  out(`Resolved thread #${id}.`);
}

async function cmdRelease(args: Args): Promise<void> {
  const name = agentName(args);
  const c = await connect();
  const r = await api<{ released: number }>(c, 'POST', '/api/agent/release', { agent: name });
  if (has(args, '--json')) return out(JSON.stringify(r));
  out(`Released ${r.released} thread(s) held by ${name}.`);
}

async function cmdDiff(args: Args): Promise<void> {
  const c = await connect();
  const id = await pickReview(c, args);
  const r = await api<Review>(c, 'GET', `/api/reviews/${enc(id)}?scope=${scopeOf(args)}&fresh=1`);
  if (has(args, '--json')) return out(JSON.stringify(r, null, 2));
  out(formatDiff(r, has(args, '--stat')));
  if (has(args, '--stat')) return;
  // The patch is streamed as git prints it: no per-file parsing, constant memory.
  await streamTo(c.port, `/api/reviews/${enc(id)}/patch?scope=${scopeOf(args)}`, process.stdout);
}

function cmdSetup(): void {
  const res = setup();
  out(res.map((r) => `${r.status.padEnd(9)} ${r.path}`).join('\n'));
  out('Claude Code: ask "connect to margin" or use /margin. Codex: ask it to use the margin skill.');
}

function rangeSpec(s: string): ReviewSpec | null {
  const m = /^(.+?)\.\.(\.)?(.+)$/.exec(s);
  if (!m || m[2]) return null;
  return { kind: 'range', from: m[1]!, to: m[3]! };
}

async function main(argv: string[]): Promise<void> {
  if (argv[0] === '__serve') {
    const { runServerProcess } = await import('../server/server.ts');
    await runServerProcess(process.cwd(), fs.existsSync(WEB_DIR) ? WEB_DIR : null);
    return;
  }
  const args = parseArgs(argv);
  const cmd = args.pos[0];
  if (has(args, '-h', '--help') || cmd === 'help') return out(USAGE);
  if (has(args, '-v', '--version') || cmd === 'version') return out(VERSION);
  const commit = str(args, '-c', '--commit');
  if (commit) return cmdOpen(args, { kind: 'commit', rev: commit });
  switch (cmd) {
    case undefined:
      return cmdOpen(args, null);
    case 'commit':
      if (!args.pos[1]) throw new UserError('Usage: margin commit <rev>');
      return cmdOpen(args, { kind: 'commit', rev: args.pos[1] });
    case 'status':
      return cmdStatus(args);
    case 'list':
      return cmdList(args);
    case 'stop':
      return cmdStop();
    case 'wait':
      return cmdWait(args);
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
      if (args.pos.length > 1) throw new UserError(`Unknown command "${args.pos.join(' ')}". Run margin --help.`);
      const range = rangeSpec(cmd);
      if (range) return cmdOpen(args, range);
      const branch = await currentBranch(process.cwd());
      return cmdOpen(args, { kind: 'branch', base: cmd, head: branch ?? 'HEAD' });
    }
  }
}

main(process.argv.slice(2)).catch((e: unknown) => {
  const msg = e instanceof Error ? e.message : String(e);
  process.stderr.write(`margin: ${msg}\n`);
  process.exit(e instanceof UserError || e instanceof ApiFailure ? 2 : 1);
});

