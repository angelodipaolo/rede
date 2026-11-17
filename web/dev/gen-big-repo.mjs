#!/usr/bin/env node
/**
 * Dev tool: builds a scratch git repo with a very large uncommitted diff, for
 * testing Rede at scale against the real server.
 *
 *   node web/dev/gen-big-repo.mjs <dir> [--files 1500] [--seed 7]
 *   node web/dev/gen-big-repo.mjs <dir> --churn [--every 3] [--count 3]
 *
 * Default: ~1,500 changed files, about +13k / -9k lines, mixed languages, part
 * staged and part unstaged, plus a few added, deleted and renamed files.
 * --churn keeps editing random tracked files until stopped (Ctrl-C).
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const dir = args.find((a) => !a.startsWith('--'));
if (!dir) {
  console.error('usage: gen-big-repo.mjs <dir> [--files N] [--churn] [--every S] [--count N]');
  process.exit(1);
}
const opt = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? Number(args[i + 1]) : def;
};
const FILES = opt('files', 1500);
let seed = opt('seed', 7);
const rnd = () => {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed / 0x7fffffff;
};
const pick = (a) => a[Math.floor(rnd() * a.length)];
const int = (a, b) => a + Math.floor(rnd() * (b - a + 1));
const git = (...a) => execFileSync('git', a, { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1 << 28 }).toString();

const WORDS = ['user', 'order', 'cart', 'price', 'token', 'cache', 'session', 'invoice', 'ledger', 'report', 'queue', 'job', 'event', 'audit', 'config', 'tenant', 'refund', 'webhook', 'schedule', 'profile'];
const VERBS = ['load', 'save', 'build', 'parse', 'merge', 'sync', 'resolve', 'format', 'apply', 'compute'];
const cap = (s) => s[0].toUpperCase() + s.slice(1);
const ident = () => pick(VERBS) + cap(pick(WORDS));

const LANGS = {
  ts: () => [
    `export function ${ident()}(input: ${cap(pick(WORDS))}): number {`,
    `  const ${pick(WORDS)} = input.${pick(WORDS)} ?? ${int(0, 99)};`,
    `  if (${pick(WORDS)} > ${int(1, 50)}) return ${pick(WORDS)} * 2;`,
    '  /* multi-line',
    `     comment about ${pick(WORDS)} */`,
    `  return \`${pick(WORDS)}-\${${pick(WORDS)}}\`.length;`,
    '}',
    '',
  ],
  py: () => [
    `def ${pick(VERBS)}_${pick(WORDS)}(rows, limit=${int(1, 100)}):`,
    '    """Docstring that',
    `    spans lines about ${pick(WORDS)}."""`,
    `    total = sum(r["${pick(WORDS)}"] for r in rows if r)`,
    `    return min(total, limit)`,
    '',
  ],
  go: () => [
    `func ${cap(ident())}(ctx context.Context, id string) (*${cap(pick(WORDS))}, error) {`,
    `\tv, err := store.Get(ctx, "${pick(WORDS)}", id)`,
    '\tif err != nil {',
    `\t\treturn nil, fmt.Errorf("${pick(VERBS)}: %w", err)`,
    '\t}',
    '\treturn v, nil',
    '}',
    '',
  ],
  rs: () => [
    `pub fn ${pick(VERBS)}_${pick(WORDS)}(items: &[u32]) -> u32 {`,
    `    items.iter().filter(|x| **x > ${int(1, 9)}).sum()`,
    '}',
    '',
  ],
  css: () => [`.${pick(WORDS)}-${pick(WORDS)} {`, `  padding: ${int(0, 16)}px ${int(0, 24)}px;`, `  color: #${int(0x100000, 0xffffff).toString(16)};`, '}', ''],
  md: () => [`## ${cap(pick(WORDS))} ${pick(WORDS)}`, '', `The ${pick(WORDS)} ${pick(VERBS)}s the ${pick(WORDS)} when the ${pick(WORDS)} changes.`, ''],
  java: () => [`  public int ${ident()}(int ${pick(WORDS)}) {`, `    return ${pick(WORDS)} + ${int(1, 9)};`, '  }', ''],
  json: () => [`  "${pick(WORDS)}_${int(1, 999)}": ${int(0, 9999)},`],
  yaml: () => [`${pick(WORDS)}_${int(1, 999)}:`, `  enabled: ${rnd() > 0.5}`, `  replicas: ${int(1, 9)}`],
  sh: () => [`${pick(VERBS)}_${pick(WORDS)}() {`, `  echo "${pick(WORDS)}" | grep -q "${pick(WORDS)}" && return 0`, '}', ''],
};
const EXTS = Object.keys(LANGS);
const DIRS = ['src', 'lib', 'pkg', 'app', 'services', 'web', 'scripts', 'docs', 'config'];

function genFile(ext, blocks) {
  const out = [];
  if (ext === 'json') out.push('{');
  if (ext === 'go') out.push('package main', '', 'import (', '\t"context"', '\t"fmt"', ')', '');
  if (ext === 'java') out.push(`public class ${cap(pick(WORDS))} {`);
  for (let i = 0; i < blocks; i++) out.push(...LANGS[ext]());
  if (ext === 'json') out.push('  "end": true', '}');
  if (ext === 'java') out.push('}');
  return out;
}

function edit(lines, ext, opsCount) {
  for (let k = 0; k < opsCount; k++) {
    const at = int(0, Math.max(0, lines.length - 1));
    const kind = rnd();
    if (kind < 0.5) lines.splice(at, int(1, 2), ...LANGS[ext]().slice(0, int(1, 5)));
    else if (kind < 0.85) lines.splice(at, 0, ...LANGS[ext]().slice(0, int(2, 6)));
    else lines.splice(at, int(2, 5));
  }
  return lines;
}

function churn() {
  const every = opt('every', 3) * 1000;
  const count = opt('count', 3);
  const tracked = git('ls-files').split('\n').filter((f) => f && !f.endsWith('.png'));
  console.log(`churn: editing ${count} files every ${every / 1000}s in ${dir}`);
  setInterval(() => {
    for (let i = 0; i < count; i++) {
      const f = pick(tracked);
      const p = path.join(dir, f);
      if (!fs.existsSync(p)) continue;
      const ext = path.extname(f).slice(1);
      if (!LANGS[ext]) continue;
      const lines = fs.readFileSync(p, 'utf8').split('\n');
      fs.writeFileSync(p, edit(lines, ext, 1).join('\n'));
      console.log(`  edited ${f}`);
    }
  }, every);
}

if (args.includes('--churn')) {
  churn();
} else {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  git('init', '-q');
  git('config', 'user.email', 'dev@example.invalid');
  git('config', 'user.name', 'dev');
  const files = [];
  const total = Math.round(FILES * 1.1);
  for (let i = 0; i < total; i++) {
    const ext = pick(EXTS);
    const depth = int(1, 4);
    const parts = [pick(DIRS)];
    for (let d = 1; d < depth; d++) parts.push(pick(WORDS));
    const name = `${pick(VERBS)}_${pick(WORDS)}_${i}.${ext}`;
    const rel = path.join(...parts, name);
    const lines = genFile(ext, int(6, 40));
    fs.mkdirSync(path.join(dir, path.dirname(rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), lines.join('\n') + '\n');
    files.push({ rel, ext });
  }
  git('add', '-A');
  git('commit', '-qm', 'base');
  // Change ~FILES files: edits, plus some deletes and renames, plus added files.
  const changed = files.slice(0, FILES - 60);
  const toStage = [];
  for (const f of changed) {
    const p = path.join(dir, f.rel);
    const lines = fs.readFileSync(p, 'utf8').split('\n');
    fs.writeFileSync(p, edit(lines, f.ext, int(2, 6)).join('\n'));
    if (rnd() < 0.45) toStage.push(f.rel);
  }
  for (const f of files.slice(FILES - 60, FILES - 30)) fs.rmSync(path.join(dir, f.rel));
  for (const f of files.slice(FILES - 30, FILES - 20)) {
    const to = f.rel.replace(/(\.\w+)$/, '_renamed$1');
    git('mv', f.rel, to);
  }
  for (let i = 0; i < 20; i++) {
    const ext = pick(EXTS);
    const rel = path.join('src', 'added', `${ident()}_${i}.${ext}`);
    fs.mkdirSync(path.join(dir, path.dirname(rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), genFile(ext, int(3, 12)).join('\n') + '\n');
    if (i % 2) toStage.push(rel);
  }
  for (let i = 0; i < toStage.length; i += 200) git('add', '--', ...toStage.slice(i, i + 200));
  // Some staged files get further unstaged edits.
  for (const rel of toStage.slice(0, 80)) {
    const p = path.join(dir, rel);
    if (!fs.existsSync(p)) continue;
    const ext = path.extname(rel).slice(1);
    fs.writeFileSync(p, edit(fs.readFileSync(p, 'utf8').split('\n'), ext, 1).join('\n'));
  }
  const stat = git('diff', 'HEAD', '--shortstat');
  console.log(`repo: ${dir}\n${stat.trim()}`);
}
