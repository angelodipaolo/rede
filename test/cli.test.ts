import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { compareVersions, detectAgentName, sandboxAdvice, serverIsOlder } from '../src/cli/client.ts';
import { codexRules, setup } from '../src/cli/guide.ts';

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
    expect(detectAgentName({ MARGIN_AGENT: 'bob', CLAUDECODE: '1' }, () => [])).toBe('bob');
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
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'margin-codex-'));
    try {
      const env = { CODEX_SANDBOX: 'seatbelt', CODEX_HOME: home };
      expect(sandboxAdvice(env)).toContain('the margin rule is not installed');
      expect(sandboxAdvice(env)).toContain('escalated permissions');
      fs.mkdirSync(path.join(home, 'rules'));
      fs.writeFileSync(path.join(home, 'rules', 'margin.rules'), codexRules([]));
      expect(sandboxAdvice(env)).toContain('did not match the margin rule');
      expect(sandboxAdvice({})).toContain('outside the sandbox');
      for (const env2 of [env, {}]) expect(sandboxAdvice(env2).split('\n')).toHaveLength(2);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('setup', () => {
  it('installs the skills and the Codex rule idempotently', () => {
    const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'margin-home-')));
    try {
      const bin = path.join(home, 'bin');
      fs.mkdirSync(bin);
      fs.writeFileSync(path.join(bin, 'margin'), '#!/bin/sh\n', { mode: 0o755 });
      const env = { PATH: `${bin}:/nonexistent`, CODEX_HOME: path.join(home, 'codex') };
      const first = setup(home, env);
      expect(first.map((r) => r.status)).toEqual(['created', 'created', 'created']);
      const rules = fs.readFileSync(path.join(home, 'codex', 'rules', 'margin.rules'), 'utf8');
      expect(rules).toContain('pattern = ["margin", ["wait", "reply"');
      expect(rules).toContain('decision = "allow"');
      expect(rules).toContain(`host_executable(name = "margin", paths = ["${path.join(bin, 'margin')}"])`);
      expect(rules).not.toContain('"stop"');
      expect(fs.existsSync(path.join(home, '.claude', 'skills', 'margin', 'SKILL.md'))).toBe(true);
      expect(setup(home, env).map((r) => r.status)).toEqual(['unchanged', 'unchanged', 'unchanged']);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('writes no host_executable line when margin is not on PATH', () => {
    expect(codexRules([])).not.toContain('host_executable');
  });
});
