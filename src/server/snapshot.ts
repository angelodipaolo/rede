import fs from 'node:fs';
import path from 'node:path';
import { gitBuffer, gitLine } from './git.ts';

/**
 * Copies an index file and keeps its mtime. git treats an entry as "racily clean" (and
 * compares content) when the file's mtime is not older than the index file's mtime. A copy
 * with a fresh mtime would hide edits made in the same second as the last write of the real
 * index when the size did not change.
 */
export function copyIndex(from: string, to: string): void {
  const st = fs.statSync(from);
  fs.copyFileSync(from, to);
  fs.utimesSync(to, st.atime, st.mtime);
}

/** One promise chain per index file, so two snapshots never race on the same index lock. */
const chains = new Map<string, Promise<unknown>>();

function serialize<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = chains.get(key) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  chains.set(
    key,
    next.catch(() => {}),
  );
  return next;
}

/**
 * Builds a git tree that represents the working tree: tracked files with their
 * working-tree content, plus untracked files that are not ignored.
 *
 * It uses a private index file (GIT_INDEX_FILE) that lives in Margin's directory and
 * is reused between runs, so git's stat cache makes repeated snapshots cheap. The real
 * index and the working tree are never written.
 */
export class WorkingSnapshotter {
  readonly indexFile: string;

  constructor(
    private readonly root: string,
    private readonly gitDir: string,
    dir: string,
  ) {
    this.indexFile = path.join(dir, 'snapshot.index');
  }

  snapshot(): Promise<string> {
    return serialize(this.indexFile, async () => {
      try {
        return await this.run();
      } catch {
        // A damaged private index: start over once from scratch.
        try {
          fs.unlinkSync(this.indexFile);
        } catch {
          /* already gone */
        }
        return this.run();
      }
    });
  }

  /** Drops the private index. The next snapshot starts from a copy of the real index. */
  reset(): Promise<void> {
    return serialize(this.indexFile, async () => {
      try {
        fs.unlinkSync(this.indexFile);
      } catch {
        /* already gone */
      }
    });
  }

  private async run(): Promise<string> {
    fs.mkdirSync(path.dirname(this.indexFile), { recursive: true });
    this.clearStaleLock();
    if (!fs.existsSync(this.indexFile)) {
      // Start from a copy of the real index: its stat data lets git skip
      // hashing files that did not change. git replaces the index atomically,
      // so a plain copy reads a consistent file.
      const real = path.join(this.gitDir, 'index');
      try {
        copyIndex(real, this.indexFile);
      } catch {
        /* no index yet (new repo): git add starts from empty */
      }
    }
    const env = { GIT_INDEX_FILE: this.indexFile };
    // --ignore-errors: an unreadable file must not abort the whole snapshot.
    // Exit code 1 then means "some files were skipped".
    await gitBuffer(['add', '--all', '--ignore-errors', '--', '.'], { cwd: this.root, env, okCodes: [0, 1] });
    return gitLine(['write-tree'], { cwd: this.root, env });
  }

  private clearStaleLock(): void {
    const lock = this.indexFile + '.lock';
    try {
      const st = fs.statSync(lock);
      if (Date.now() - st.mtimeMs > 30_000) fs.unlinkSync(lock);
    } catch {
      /* no lock */
    }
  }
}

/**
 * Reads the tree of the real index (the staged content) without writing the real index.
 * `git write-tree` updates the cache-tree extension of the index it reads, so it runs on a
 * private copy. The result is cached while the index file does not change.
 */
export class IndexTreeReader {
  private readonly copyFile: string;
  private last: { key: string; tree: string } | null = null;

  constructor(
    private readonly root: string,
    private readonly gitDir: string,
    dir: string,
  ) {
    this.copyFile = path.join(dir, 'staged.index');
  }

  /** @param headTree tree used for conflicted paths and when there is no index. */
  read(headTree: string): Promise<string> {
    return serialize(this.copyFile, () => this.run(headTree));
  }

  private async run(headTree: string): Promise<string> {
    const real = path.join(this.gitDir, 'index');
    let st: fs.Stats;
    try {
      st = fs.statSync(real);
    } catch {
      return headTree;
    }
    const key = `${st.ino}:${st.size}:${st.mtimeMs}:${st.ctimeMs}:${headTree}`;
    if (this.last?.key === key) return this.last.tree;
    fs.mkdirSync(path.dirname(this.copyFile), { recursive: true });
    copyIndex(real, this.copyFile);
    const env = { GIT_INDEX_FILE: this.copyFile };
    let tree: string;
    try {
      tree = await gitLine(['write-tree'], { cwd: this.root, env });
    } catch {
      // Unmerged entries: show conflicted paths as they are in HEAD (nothing staged yet).
      const unmerged = (await gitBuffer(['ls-files', '-u', '-z'], { cwd: this.root, env }))
        .toString('utf8')
        .split('\0')
        .filter(Boolean)
        .map((l) => l.slice(l.indexOf('\t') + 1));
      const paths = [...new Set(unmerged)];
      const lines: string[] = [];
      const inHead = new Map<string, string>();
      if (paths.length) {
        const ls = (await gitBuffer(['ls-tree', '-z', headTree, '--', ...paths], { cwd: this.root }))
          .toString('utf8')
          .split('\0')
          .filter(Boolean);
        for (const l of ls) {
          const tab = l.indexOf('\t');
          const [mode, , id] = l.slice(0, tab).split(' ');
          inHead.set(l.slice(tab + 1), `${mode} ${id}`);
        }
      }
      for (const p of paths) {
        lines.push(`0 ${'0'.repeat(40)}\t${p}`);
        const h = inHead.get(p);
        if (h) lines.push(`${h}\t${p}`);
      }
      await gitBuffer(['update-index', '-z', '--index-info'], {
        cwd: this.root,
        env,
        input: lines.map((l) => l + '\0').join(''),
      });
      tree = await gitLine(['write-tree'], { cwd: this.root, env });
    }
    this.last = { key, tree };
    return tree;
  }
}
