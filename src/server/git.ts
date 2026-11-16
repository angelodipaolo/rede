import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';

/** The empty tree. Used as the old side of a root commit or a repo without commits. */
export const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

export interface GitOptions {
  cwd: string;
  env?: Record<string, string>;
  input?: string | Buffer;
  /** Exit codes that are not errors. Default: [0]. */
  okCodes?: number[];
}

export class GitError extends Error {
  constructor(
    message: string,
    public readonly code: number | null,
    public readonly stderr: string,
  ) {
    super(message);
  }
}

/**
 * Config that keeps git output stable no matter what the user configured.
 * quotepath=off keeps unicode paths readable in patch headers.
 */
const BASE_CONFIG = [
  '-c', 'core.quotepath=off',
  '-c', 'diff.noprefix=false',
  '-c', 'diff.mnemonicPrefix=false',
  '-c', 'diff.relative=false',
  '-c', 'color.ui=false',
  '-c', 'core.pager=cat',
];

/**
 * Extra environment per repository root. Margin uses it to send the objects that snapshots
 * write to a private object directory (see useObjectStore).
 */
const repoEnv = new Map<string, Record<string, string>>();

/**
 * Makes every git command that runs in `root` write new objects to `objectsDir` and read
 * the repository's own objects as an alternate. Snapshots then never add loose objects to
 * the user's object store. Pass null to undo.
 */
export function useObjectStore(root: string, objectsDir: string | null, repoObjects?: string): void {
  if (!objectsDir) {
    repoEnv.delete(root);
    return;
  }
  repoEnv.set(root, { GIT_OBJECT_DIRECTORY: objectsDir, GIT_ALTERNATE_OBJECT_DIRECTORIES: repoObjects ?? path.join(root, '.git', 'objects') });
}

function envFor(opts: GitOptions): NodeJS.ProcessEnv {
  return { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C', ...repoEnv.get(opts.cwd), ...opts.env };
}

/** Starts git with stdout piped, for streaming. */
export function gitStream(args: string[], opts: GitOptions): ChildProcess {
  const child = spawn('git', [...BASE_CONFIG, ...args], { cwd: opts.cwd, env: envFor(opts), stdio: ['ignore', 'pipe', 'ignore'] });
  child.on('error', () => {});
  return child;
}

/** Runs git and returns stdout as a Buffer. */
export function gitBuffer(args: string[], opts: GitOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', [...BASE_CONFIG, ...args], {
      cwd: opts.cwd,
      env: envFor(opts),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on('data', (d: Buffer) => out.push(d));
    child.stderr.on('data', (d: Buffer) => err.push(d));
    child.on('error', reject);
    child.on('close', (code) => {
      const ok = opts.okCodes ?? [0];
      if (code !== null && ok.includes(code)) resolve(Buffer.concat(out));
      else {
        const stderr = Buffer.concat(err).toString('utf8').trim();
        reject(new GitError(`git ${args.join(' ')} failed (${code}): ${stderr}`, code, stderr));
      }
    });
    child.stdin.on('error', () => {});
    if (opts.input !== undefined) child.stdin.end(opts.input);
    else child.stdin.end();
  });
}

export async function git(args: string[], opts: GitOptions): Promise<string> {
  return (await gitBuffer(args, opts)).toString('utf8');
}

/** Like git() but trims the trailing newline. */
export async function gitLine(args: string[], opts: GitOptions): Promise<string> {
  return (await git(args, opts)).replace(/\n$/, '');
}

export interface RepoPaths {
  /** Absolute worktree root. */
  root: string;
  /** Absolute git dir of this worktree. */
  gitDir: string;
  /** Absolute common git dir (shared by linked worktrees). */
  commonDir: string;
}

export async function discoverRepo(cwd: string): Promise<RepoPaths> {
  let out: string;
  try {
    out = await git(
      ['rev-parse', '--path-format=absolute', '--show-toplevel', '--absolute-git-dir', '--git-common-dir'],
      { cwd },
    );
  } catch {
    throw new Error('Not inside a git repository (or git is not installed).');
  }
  const [root, gitDir, commonRaw] = out.split('\n');
  if (!root || !gitDir || !commonRaw) throw new Error('Cannot read the repository layout (bare repository?).');
  return { root, gitDir, commonDir: path.resolve(cwd, commonRaw) };
}

/** Margin's private directory: <git-dir>/margin. For a normal repo this is <git-common-dir>/margin. */
export function marginDir(repo: RepoPaths): string {
  return path.join(repo.gitDir, 'margin');
}

export async function currentBranch(cwd: string): Promise<string | null> {
  try {
    return await gitLine(['symbolic-ref', '--quiet', '--short', 'HEAD'], { cwd });
  } catch {
    return null;
  }
}

/** Resolves a revision to a full commit id, or null. */
export async function resolveCommit(cwd: string, rev: string): Promise<string | null> {
  try {
    return await gitLine(['rev-parse', '--verify', '--quiet', '--end-of-options', `${rev}^{commit}`], { cwd });
  } catch {
    return null;
  }
}

/** HEAD commit, or null in a repo without commits. */
export function headCommit(cwd: string): Promise<string | null> {
  return resolveCommit(cwd, 'HEAD');
}

/** HEAD commit and its tree in one call. A repo without commits gives null and the empty tree. */
export async function headAndTree(cwd: string): Promise<{ head: string | null; tree: string }> {
  try {
    const [head, tree] = (await git(['rev-parse', 'HEAD^{commit}', 'HEAD^{tree}'], { cwd })).split('\n');
    if (head && tree) return { head, tree };
  } catch {
    /* unborn HEAD */
  }
  return { head: null, tree: EMPTY_TREE };
}

export async function treeOf(cwd: string, commit: string): Promise<string> {
  return gitLine(['rev-parse', '--verify', `${commit}^{tree}`], { cwd });
}

export async function mergeBase(cwd: string, a: string, b: string): Promise<string | null> {
  try {
    return await gitLine(['merge-base', a, b], { cwd });
  } catch {
    return null;
  }
}

/** Default branch: origin/HEAD, else main, else master. Returns a ref name usable as a revision. */
export async function defaultBranch(cwd: string): Promise<string | null> {
  try {
    const ref = await gitLine(['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'], { cwd });
    if (ref) {
      // "origin/main": prefer the local branch when it exists.
      const local = ref.replace(/^origin\//, '');
      if (await resolveCommit(cwd, `refs/heads/${local}`)) return local;
      return ref;
    }
  } catch {
    /* no origin/HEAD */
  }
  for (const name of ['main', 'master']) {
    if (await resolveCommit(cwd, `refs/heads/${name}`)) return name;
  }
  return null;
}

/**
 * Reads many objects at once with `git cat-file --batch`.
 * Missing objects are absent from the result.
 */
export async function catFileBatch(cwd: string, ids: string[]): Promise<Map<string, Buffer>> {
  const result = new Map<string, Buffer>();
  const unique = [...new Set(ids)];
  if (unique.length === 0) return result;
  const buf = await gitBuffer(['cat-file', '--batch'], { cwd, input: unique.join('\n') + '\n' });
  let pos = 0;
  while (pos < buf.length) {
    const nl = buf.indexOf(0x0a, pos);
    if (nl < 0) break;
    const header = buf.subarray(pos, nl).toString('utf8');
    pos = nl + 1;
    const parts = header.split(' ');
    if (parts[1] === 'missing' || parts.length < 3) continue;
    const id = parts[0]!;
    const size = Number(parts[2]);
    result.set(id, buf.subarray(pos, pos + size));
    pos += size + 1; // content + trailing LF
  }
  return result;
}

/** Returns the ids that do not exist in the object store. */
export async function missingObjects(cwd: string, ids: string[]): Promise<string[]> {
  const unique = [...new Set(ids)];
  if (!unique.length) return [];
  const out = await git(['cat-file', '--batch-check'], { cwd, input: unique.join('\n') + '\n' });
  return out
    .split('\n')
    .filter((l) => l.endsWith(' missing'))
    .map((l) => l.slice(0, l.indexOf(' ')));
}

export async function hashObject(cwd: string, content: string | Buffer): Promise<string> {
  return gitLine(['hash-object', '-w', '--stdin'], { cwd, input: content });
}
