import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { discoverRepo, redeDir } from '../src/server/git.ts';
import { Rede, type RedeOptions } from '../src/server/service.ts';
import { Store } from '../src/server/store.ts';

export class TempRepo {
  readonly dir: string;
  constructor() {
    this.dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rede-test-')));
    this.git('init', '-q', '-b', 'main');
    this.git('config', 'user.email', 't@example.com');
    this.git('config', 'user.name', 'Test');
    this.git('config', 'commit.gpgsign', 'false');
  }
  git(...args: string[]): string {
    return execFileSync('git', args, { cwd: this.dir, encoding: 'utf8' });
  }
  write(p: string, content: string | Buffer): void {
    const f = path.join(this.dir, p);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, content);
  }
  read(p: string): string {
    return fs.readFileSync(path.join(this.dir, p), 'utf8');
  }
  rm(p: string): void {
    fs.rmSync(path.join(this.dir, p));
  }
  commit(msg = 'commit'): string {
    this.git('add', '-A');
    this.git('commit', '-q', '-m', msg, '--allow-empty');
    return this.git('rev-parse', 'HEAD').trim();
  }
  cleanup(): void {
    fs.rmSync(this.dir, { recursive: true, force: true });
  }
}

export function lines(n: number, prefix = 'line'): string {
  return Array.from({ length: n }, (_, i) => `${prefix} ${i + 1}`).join('\n') + '\n';
}

export async function makeRede(repo: TempRepo, opts: Partial<RedeOptions> = {}): Promise<Rede> {
  const paths = await discoverRepo(repo.dir);
  const store = await Store.open(path.join(redeDir(paths), 'rede.db'));
  return new Rede({ repo: paths, store, version: 'test', pollMs: 100, presenceLingerMs: 0, ...opts });
}

export const human = { kind: 'human' as const, name: 'you' };
export const agent = (name = 'claude') => ({ kind: 'agent' as const, name });
