import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { discoverRepo, redeDir } from '../src/server/git.ts';
import { TempRepo } from './helpers.ts';

describe('rename from Margin', () => {
  let repo: TempRepo;
  afterEach(() => repo?.cleanup());

  it('moves .git/margin and its database to .git/rede once', async () => {
    repo = new TempRepo();
    repo.write('a.txt', 'a\n');
    repo.commit();
    const legacy = path.join(repo.dir, '.git', 'margin');
    fs.mkdirSync(legacy);
    fs.writeFileSync(path.join(legacy, 'margin.db'), 'db');
    fs.writeFileSync(path.join(legacy, 'margin.db-wal'), 'wal');
    fs.writeFileSync(path.join(legacy, 'last-port'), '4100');

    const dir = redeDir(await discoverRepo(repo.dir));

    expect(dir).toBe(path.join(fs.realpathSync(repo.dir), '.git', 'rede'));
    expect(fs.existsSync(legacy)).toBe(false);
    expect(fs.readFileSync(path.join(dir, 'rede.db'), 'utf8')).toBe('db');
    expect(fs.readFileSync(path.join(dir, 'rede.db-wal'), 'utf8')).toBe('wal');
    expect(fs.readFileSync(path.join(dir, 'last-port'), 'utf8')).toBe('4100');
  });

  it('leaves .git/margin alone when .git/rede already exists', async () => {
    repo = new TempRepo();
    repo.write('a.txt', 'a\n');
    repo.commit();
    fs.mkdirSync(path.join(repo.dir, '.git', 'margin'));
    fs.mkdirSync(path.join(repo.dir, '.git', 'rede'));

    redeDir(await discoverRepo(repo.dir));

    expect(fs.existsSync(path.join(repo.dir, '.git', 'margin'))).toBe(true);
  });
});
