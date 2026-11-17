import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { compareVersions, detectAgentName, sandboxAdvice, serverIsOlder } from '../src/cli/client.ts';
import { formatThreadLine, formatWait, MODE_INSTRUCTIONS } from '../src/cli/format.ts';
import { codexRules, GUIDE, setup, skillFile } from '../src/cli/guide.ts';
import type { AgentThread } from '../src/shared/types.ts';

describe('server replacement', () => {
  it('compares versions numerically', () => {
    expect(compareVersions('0.10.0', '0.9.1')).toBe(1);
    expect(compareVersions('0.1.0', '0.1.0')).toBe(0);
    expect(compareVersions('0.1', '0.1.0')).toBe(0);
    expect(compareVersions('1.0.0', '1.0.1')).toBe(-1);
  });

  it('replaces only a strictly older server, never in both directions', () => {
    const builds = [undefined, 1, 1000, 2000];
    const versions = ['0.1.0', '0.2.0'];
    const all = versions.flatMap((version) => builds.map((build) => ({ version, build })));
    for (const a of all) {
      for (const b of all) {
        // a runs the server, b is the CLI; then the other way round.
        const ab = serverIsOlder(a, b);
        const ba = serverIsOlder(b, a);
        expect(ab && ba, `${JSON.stringify(a)} vs ${JSON.stringify(b)}`).toBe(false);
      }
      expect(serverIsOlder(a, a)).toBe(false);
    }
    expect(serverIsOlder({ version: '0.1.0', build: 1000 }, { version: '0.1.0', build: 2000 })).toBe(true);
    expect(serverIsOlder({ version: '0.1.0', build: 2000 }, { version: '0.1.0', build: 1000 })).toBe(false);
    expect(serverIsOlder({ version: '0.2.0', build: 1 }, { version: '0.1.0', build: 2000 })).toBe(false);
    expect(serverIsOlder({ version: '0.1.0', build: 2000 }, { version: '0.2.0', build: 1 })).toBe(true);
    // A CLI that cannot read its own build replaces nothing of its own version.
    expect(serverIsOlder({ version: '0.1.0', build: 1 }, { version: '0.1.0', build: undefined })).toBe(false);
  });
});

describe('agent name', () => {
  const codexEnv = { CODEX_SANDBOX: 'seatbelt', CODEX_THREAD_ID: 'x', CODEX_CI: '1' };
  it('detects Codex and Claude Code from their environment', () => {
    expect(detectAgentName({ ...codexEnv }, () => [])).toBe('codex');
    expect(detectAgentName({ CODEX_THREAD_ID: 'x' }, () => [])).toBe('codex');
    expect(detectAgentName({ CLAUDECODE: '1' }, () => [])).toBe('claude');
    expect(detectAgentName({}, () => [])).toBe('agent');
    expect(detectAgentName({ REDE_AGENT: 'bob', CLAUDECODE: '1' }, () => [])).toBe('bob');
  });

  it('picks the nearest harness when one runs inside the other', () => {
    // Codex started from a Claude Code session: both markers are set.
    expect(detectAgentName({ CLAUDECODE: '1', ...codexEnv }, () => ['/bin/zsh', '/usr/local/lib/node_modules/@openai/codex/vendor/bin/codex', 'node', 'claude'])).toBe('codex');
    expect(detectAgentName({ CLAUDECODE: '1', ...codexEnv }, () => ['/bin/zsh', 'claude', 'codex'])).toBe('claude');
    expect(detectAgentName({ CLAUDECODE: '1', ...codexEnv }, () => [])).toBe('codex');
  });
});

describe('sandbox advice', () => {
  it('tells a missing Codex rule from a command the rule did not match', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'rede-codex-'));
    try {
      const env = { CODEX_SANDBOX: 'seatbelt', CODEX_HOME: home };
      expect(sandboxAdvice(env)).toContain('the rede rule is not installed');
      expect(sandboxAdvice(env)).toContain('escalated permissions');
      fs.mkdirSync(path.join(home, 'rules'));
      fs.writeFileSync(path.join(home, 'rules', 'rede.rules'), codexRules([]));
      expect(sandboxAdvice(env)).toContain('did not match the rede rule');
      expect(sandboxAdvice({})).toContain('outside the sandbox');
      for (const env2 of [env, {}]) expect(sandboxAdvice(env2).split('\n')).toHaveLength(2);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('setup', () => {
  it('installs the skills and the Codex rule idempotently', () => {
    const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rede-home-')));
    try {
      const bin = path.join(home, 'bin');
      fs.mkdirSync(bin);
      fs.writeFileSync(path.join(bin, 'rede'), '#!/bin/sh\n', { mode: 0o755 });
      const env = { PATH: `${bin}:/nonexistent`, CODEX_HOME: path.join(home, 'codex') };
      const first = setup(home, env);
      expect(first.map((r) => r.status)).toEqual(['created', 'created', 'created']);
      const rules = fs.readFileSync(path.join(home, 'codex', 'rules', 'rede.rules'), 'utf8');
      expect(rules).toContain('pattern = ["rede", ["inbox", "wait", "reply"');
      expect(rules).toContain('decision = "allow"');
      expect(rules).toContain(`host_executable(name = "rede", paths = ["${path.join(bin, 'rede')}"])`);
      expect(rules).not.toContain('"stop"');
      expect(fs.existsSync(path.join(home, '.claude', 'skills', 'rede', 'SKILL.md'))).toBe(true);
      expect(setup(home, env).map((r) => r.status)).toEqual(['unchanged', 'unchanged', 'unchanged']);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('writes no host_executable line when rede is not on PATH', () => {
    expect(codexRules([])).not.toContain('host_executable');
  });
});

describe('wait output with reviews', () => {
  const thread = (id: number, mode: 'ask' | 'discuss' | 'implement', batchId: number | null): AgentThread => ({
    thread: {
      id,
      reviewId: 'working',
      anchor: { path: 'a.ts', side: 'new', startLine: id, endLine: id },
      inScope: true,
      homeScope: 'all',
      snippet: [],
      outdated: false,
      resolved: false,
      noteOnly: false,
      agentState: 'working',
      mode,
      claimedBy: 'claude',
      messages: [{ id: id * 10, pending: false, batchId, author: { kind: 'human', name: 'you' }, body: `comment ${id}`, createdAt: '', editedAt: null }],
      createdAt: '',
      updatedAt: '',
    },
    review: { id: 'working', title: 'Uncommitted changes', spec: { kind: 'working' }, from: 'abc', to: null },
    repoRoot: '/repo',
    diffContext: null,
    batchId,
  });

  it('prints each batch under a header with its mode instruction, then one-off threads', () => {
    const batch = { id: 3, reviewId: 'working', mode: 'discuss' as const, body: 'Big picture first.', submittedAt: '2026-11-16T00:00:00Z', threadIds: [1, 2] };
    const text = formatWait({ threads: [thread(1, 'discuss', 3), thread(2, 'discuss', 3), thread(7, 'ask', null)], batches: [batch], timedOut: false }, 'claude', false);
    const header = text.indexOf('# REVIEW #3 · DISCUSS · 2 threads');
    expect(header).toBeGreaterThan(0);
    expect(text).toContain('> Big picture first.');
    expect(text).toContain(`INSTRUCTION (DISCUSS): ${MODE_INSTRUCTIONS.discuss}`);
    expect(text.indexOf('## Thread #1')).toBeGreaterThan(header);
    const oneOff = text.indexOf('# ONE-OFF COMMENTS · 1 thread');
    expect(oneOff).toBeGreaterThan(text.indexOf('## Thread #2'));
    expect(text.indexOf('## Thread #7')).toBeGreaterThan(oneOff);
    expect(text).toContain('Mode: DISCUSS (review #3). Do not change any code or files');
    expect(text).toContain(`Mode: ASK (one-off comment). ${MODE_INSTRUCTIONS.ask}`);
  });

  it('prints only the mode line for one-off threads', () => {
    const text = formatWait({ threads: [thread(7, 'ask', null)], batches: [], timedOut: false }, 'claude', false);
    expect(text).not.toContain('REVIEW #');
    expect(text).not.toContain('ONE-OFF COMMENTS');
    expect(text).toContain('Mode: ASK');
  });

  it('implement instruction and thread list line show the mode', () => {
    const batch = { id: 4, reviewId: 'working', mode: 'implement' as const, body: '', submittedAt: '', threadIds: [1] };
    const text = formatWait({ threads: [thread(1, 'implement', 4)], batches: [batch], timedOut: false }, 'claude', false);
    expect(text).toContain(`INSTRUCTION (IMPLEMENT): ${MODE_INSTRUCTIONS.implement}`);
    expect(text).not.toContain('Overall note');
    expect(formatThreadLine(thread(1, 'implement', 4))).toContain('[working, implement]');
  });

  it('the installed skill defers to rede guide, which explains the modes', () => {
    expect(skillFile()).toContain('Run `rede guide`');
    expect(skillFile()).not.toContain('## The loop');
    for (const m of ['ASK', 'DISCUSS', 'IMPLEMENT']) expect(GUIDE).toContain(`- ${m}:`);
  });
});
