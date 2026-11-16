#!/usr/bin/env node
/**
 * Margin dev mock server. Dev-only: lets the web UI run without the real server.
 *
 * Implements the HTTP contract in src/shared/types.ts with in-memory state and a
 * deterministic generated fixture. Plain Node 22 ESM, node:http only, no dependencies.
 *
 * Usage:
 *   node web/dev/mock-server.mjs [--port 4319] [--files 300] [--small] [--seed 42]
 *                                [--no-agent] [--change-every <seconds>]
 *
 * Mock-only endpoints (all POST, optional ?review=<id>, default "working"):
 *   /__mock/change               mutate 3 working-tree files (+ maybe add/remove one), broadcast diff-changed
 *   /__mock/agent-reply?thread=N force an immediate claude reply on thread N
 *   /__mock/agents               body AgentPresence[] sets presence ([] = no agent)
 *   /__mock/clear                empty diff (no files)
 *   /__mock/restore              bring the files back
 */

import http from 'node:http';
import crypto from 'node:crypto';

// ------------------------------------------------------------------ options

function parseArgs(argv) {
  const o = {
    port: Number(process.env.MARGIN_PORT) || 4319,
    files: 300,
    small: false,
    seed: 42,
    agent: true,
    changeEvery: 0,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`missing value for ${a}`);
      return v;
    };
    if (a === '--port') o.port = Number(next());
    else if (a === '--files') o.files = Math.max(1, Number(next()) | 0);
    else if (a === '--small') o.small = true;
    else if (a === '--seed') o.seed = Number(next()) | 0;
    else if (a === '--no-agent') o.agent = false;
    else if (a === '--change-every') o.changeEvery = Number(next());
    else if (a === '--help' || a === '-h') {
      console.log('node web/dev/mock-server.mjs [--port 4319] [--files 300] [--small] [--seed 42] [--no-agent] [--change-every <s>]');
      process.exit(0);
    } else throw new Error(`unknown argument ${a}`);
  }
  return o;
}

const OPTS = parseArgs(process.argv.slice(2));

// ------------------------------------------------------------------ PRNG

function mulberry32(a) {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

class Rng {
  constructor(seed) {
    this.f = mulberry32(seed);
  }
  next() {
    return this.f();
  }
  int(lo, hi) {
    return lo + Math.floor(this.f() * (hi - lo + 1));
  }
  pick(arr) {
    return arr[Math.floor(this.f() * arr.length)];
  }
  chance(p) {
    return this.f() < p;
  }
  weighted(pairs) {
    let total = 0;
    for (const [, w] of pairs) total += w;
    let x = this.f() * total;
    for (const [v, w] of pairs) {
      x -= w;
      if (x < 0) return v;
    }
    return pairs[pairs.length - 1][0];
  }
}

// ------------------------------------------------------------------ words

const NOUNS = ['invoice', 'customer', 'account', 'order', 'payment', 'session', 'token', 'user', 'report', 'ledger', 'cart', 'item', 'price', 'discount', 'webhook', 'event', 'queue', 'job', 'cache', 'config', 'tenant', 'plan', 'subscription', 'refund', 'shipment', 'address', 'profile', 'metric', 'request', 'response', 'balance', 'charge', 'coupon', 'receipt', 'schedule', 'export', 'filter', 'widget', 'alert', 'audit'];
const VERBS = ['get', 'load', 'fetch', 'build', 'create', 'update', 'delete', 'parse', 'validate', 'render', 'compute', 'apply', 'resolve', 'sync', 'format', 'normalize', 'emit', 'handle', 'merge', 'schedule', 'reconcile', 'refresh', 'collect', 'serialize', 'persist'];
const ADJ = ['pending', 'active', 'stale', 'primary', 'default', 'cached', 'remote', 'local', 'draft', 'final', 'archived', 'partial', 'expired', 'verified'];
const FILLER = ['the', 'when', 'and', 'before', 'after', 'with', 'for', 'is', 'are', 'should', 'not', 'only', 'every', 'once', 'this', 'that', 'we', 'it', 'because', 'until', 'a', 'to', 'of', 'in'];
const SUFFIX = ['Service', 'Repository', 'Record', 'Options', 'State', 'Result', 'Payload', 'Client', 'Store', 'Event', 'Summary', 'Snapshot'];
const FEATURES = ['billing', 'auth', 'onboarding', 'search', 'notifications', 'reports', 'settings', 'checkout', 'inventory', 'analytics'];
const SUBS = ['invoices', 'payments', 'subscriptions', 'sessions', 'tokens', 'filters', 'exports', 'alerts', 'widgets', 'profiles'];

const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const camel = (...w) => w[0] + w.slice(1).map(cap).join('');
const pascal = (...w) => w.map(cap).join('');
const snake = (...w) => w.join('_');
const kebab = (...w) => w.join('-');

function sentence(r, n) {
  const w = [];
  for (let i = 0; i < n; i++) w.push(r.chance(0.45) ? r.pick(FILLER) : r.pick(r.chance(0.6) ? NOUNS : r.chance(0.5) ? VERBS : ADJ));
  return cap(w.join(' '));
}
const noun = (r) => r.pick(NOUNS);
const verb = (r) => r.pick(VERBS);
const fnName = (r) => camel(verb(r), noun(r), ...(r.chance(0.4) ? [noun(r)] : []));
const varName = (r) => (r.chance(0.5) ? camel(noun(r), noun(r)) : camel(r.pick(ADJ), noun(r)));
const typeName = (r) => pascal(noun(r), r.pick(SUFFIX));
const snakeFn = (r) => snake(verb(r), noun(r), ...(r.chance(0.4) ? [noun(r)] : []));
const snakeVar = (r) => snake(r.pick(ADJ), noun(r));
function longList(r, quote = "'") {
  const n = r.int(22, 34);
  const items = [];
  for (let i = 0; i < n; i++) items.push(`${quote}${noun(r)}_${r.pick(ADJ)}${quote}`);
  return items.join(', ');
}

// ------------------------------------------------------------------ language generators
// Each language: { u: indent unit, header(r), footer(r), block(r), stmt(r, ind) } -> arrays of lines.

function tsFamily(typed, jsx) {
  const T = (t) => (typed ? t : '');
  const stmt = (r, ind, depth = 0) => {
    const v = varName(r);
    const f = fnName(r);
    const roll = r.int(0, 99);
    if (roll < 14) return [`${ind}const ${v} = await ${f}(${varName(r)}Id);`];
    if (roll < 24)
      return [`${ind}if (!${v}) {`, `${ind}  throw new Error(\`${cap(noun(r))} not found: \${${v}Id}\`);`, `${ind}}`];
    if (roll < 34) return [`${ind}${v}.${noun(r)} = ${f}(${v}, { strict: ${r.chance(0.5)}, retries: ${r.int(1, 9)} });`];
    if (roll < 44) return [`${ind}logger.info('${f}: ${sentence(r, 4).toLowerCase()}', { ${v}, durationMs: Date.now() - startedAt });`];
    if (roll < 52 && depth < 2) {
      const it = noun(r);
      return [`${ind}for (const ${it} of ${v}s) {`, ...stmt(r, ind + '  ', depth + 1), ...stmt(r, ind + '  ', depth + 1), `${ind}}`];
    }
    if (roll < 60) return [`${ind}// ${sentence(r, r.int(5, 12))}.`];
    if (roll < 66) {
      const tbl = snake(noun(r), 's');
      return [
        `${ind}const ${v}Query = \``,
        `${ind}  SELECT id, ${snakeVar(r)}, created_at`,
        `${ind}  FROM ${tbl}`,
        `${ind}  WHERE tenant_id = \${tenantId}`,
        `${ind}    AND status = '${r.pick(ADJ)}'`,
        `${ind}  ORDER BY created_at DESC`,
        `${ind}  LIMIT ${r.int(10, 500)}`,
        `${ind}\`;`,
      ];
    }
    if (roll < 70) return [`${ind}const ${v}Keys${T(': readonly string[]')} = [${longList(r)}];`];
    if (roll < 78) return [`${ind}const ${v}Total = ${v}s.reduce((sum, item) => sum + item.${noun(r)}Amount, 0);`];
    if (roll < 84) return [`${ind}let ${v}${T(`: ${typeName(r)} | undefined`)};`];
    if (roll < 90) return [`${ind}await ${f}(${v}).catch((error) => logger.warn('${f} failed', { error, attempt: ${r.int(1, 5)} }));`];
    if (roll < 95) return [`${ind}const ${v}Map = new Map${T(`<string, ${typeName(r)}>`)}();`];
    return [`${ind}return ${v};`];
  };
  const body = (r, ind, min, max) => {
    const out = [];
    const n = r.int(min, max);
    for (let i = 0; i < n; i++) out.push(...stmt(r, ind));
    return out;
  };
  const jsdoc = (r, ind) => {
    const out = [`${ind}/**`];
    const n = r.int(1, 4);
    for (let i = 0; i < n; i++) out.push(`${ind} * ${sentence(r, r.int(6, 14))}.`);
    out.push(`${ind} * @param ${varName(r)} ${sentence(r, 5).toLowerCase()}`);
    out.push(`${ind} */`);
    return out;
  };
  const component = (r) => {
    const C = pascal(noun(r), r.pick(['Panel', 'Table', 'Card', 'Dialog', 'List', 'Summary']));
    const p1 = varName(r);
    const s = varName(r);
    const V = cap(verb(r));
    const f = fnName(r);
    const cls = kebab(noun(r), r.pick(['panel', 'card', 'row']));
    const out = [];
    if (typed) out.push(`interface ${C}Props {`, `  ${p1}: ${typeName(r)};`, `  on${V}?: (${s}: ${typeName(r)}) => void;`, `}`, '');
    out.push(
      `export function ${C}({ ${p1}, on${V} }${T(`: ${C}Props`)}) {`,
      `  const [${s}, set${cap(s)}] = useState${T(`<${typeName(r)} | null>`)}(null);`,
      `  const ${f} = useCallback(async () => {`,
      `    const startedAt = Date.now();`,
      ...body(r, '    ', 1, 4),
      `  }, [${p1}]);`,
      '',
      `  useEffect(() => {`,
      `    void ${f}();`,
      `  }, [${f}]);`,
      '',
      `  return (`,
      `    <div className="${cls}">`,
      `      <header className="${cls}__header">`,
      `        <h2>{${p1}.title}</h2>`,
      `        <button type="button" onClick={() => on${V}?.(${p1})}>`,
      `          ${sentence(r, 2)}`,
      `        </button>`,
      `      </header>`,
    );
    const rows = r.int(1, 5);
    for (let i = 0; i < rows; i++) out.push(`      <p className="${cls}__${noun(r)}">{${s}?.${noun(r)} ?? '${r.pick(ADJ)}'}</p>`);
    if (r.chance(0.2)) out.push(`      <p className="${cls}__hint">${sentence(r, 60)}.</p>`);
    out.push(`    </div>`, `  );`, `}`, '');
    return out;
  };
  const block = (r) => {
    if (jsx && r.chance(0.45)) return component(r);
    const kind = r.int(0, 9);
    const Tn = typeName(r);
    const f = fnName(r);
    const v = varName(r);
    if (kind <= 3)
      return [
        ...jsdoc(r, ''),
        `export async function ${f}(${v}Id${T(': string')}, options${T(`: ${Tn}Options`)} = {})${T(`: Promise<${Tn}>`)} {`,
        `  const startedAt = Date.now();`,
        ...body(r, '  ', 2, 8),
        `  return ${v};`,
        `}`,
        '',
      ];
    if (kind <= 5) {
      const out = [`export class ${Tn} {`, `  private readonly cache = new Map${T(`<string, ${typeName(r)}>`)}();`, ''];
      if (typed) out.push(`  constructor(private readonly client: ${typeName(r)}) {}`, '');
      else out.push(`  constructor(client) {`, `    this.client = client;`, `  }`, '');
      const m = r.int(1, 4);
      for (let i = 0; i < m; i++)
        out.push(`  async ${fnName(r)}(${varName(r)}Id${T(': string')})${T(': Promise<void>')} {`, `    const startedAt = Date.now();`, ...body(r, '    ', 1, 6), `  }`, '');
      out.push(`}`, '');
      return out;
    }
    if (kind === 6 && typed) {
      const out = [`export interface ${Tn} {`];
      const n = r.int(2, 9);
      for (let i = 0; i < n; i++) out.push(`  ${varName(r)}${r.chance(0.3) ? '?' : ''}: ${r.pick(['string', 'number', 'boolean', 'Date', typeName(r), `${typeName(r)}[]`])};`);
      out.push(`}`, '');
      return out;
    }
    if (kind === 7) {
      const out = ['/*'];
      const n = r.int(2, 6);
      for (let i = 0; i < n; i++) out.push(` * ${sentence(r, r.int(8, 16))}.`);
      out.push(' */');
      return out;
    }
    return [`export const ${f} = (${v}${T(`: ${Tn}`)}) => {`, ...body(r, '  ', 1, 5), `  return ${v};`, `};`, ''];
  };
  const header = (r) => {
    const out = [];
    if (jsx) out.push(`import { useCallback, useEffect, useState } from 'preact/hooks';`);
    const n = r.int(2, 6);
    for (let i = 0; i < n; i++) out.push(`import { ${fnName(r)}, ${fnName(r)} } from '${r.pick(['../', './', '@acme/'])}${kebab(noun(r), noun(r))}';`);
    if (typed) out.push(`import type { ${typeName(r)}, ${typeName(r)} } from '@acme/core';`);
    out.push(`import { logger } from '@acme/logger';`, '');
    return out;
  };
  return { u: '  ', header, footer: () => [], block, stmt };
}

const LANGS = {
  ts: tsFamily(true, false),
  tsx: tsFamily(true, true),
  js: tsFamily(false, false),
  py: {
    u: '    ',
    header: (r) => [`"""${sentence(r, 8)}.`, '', `${sentence(r, 14)}.`, `"""`, '', 'from __future__ import annotations', '', 'import logging', 'from dataclasses import dataclass, field', 'from typing import Any, Optional', '', `from acme.${noun(r)} import ${snakeFn(r)}, ${snakeFn(r)}`, '', 'logger = logging.getLogger(__name__)', '', ''],
    footer: () => [],
    stmt(r, ind, depth = 0) {
      const v = snakeVar(r);
      const roll = r.int(0, 99);
      if (roll < 18) return [`${ind}${v} = ${snakeFn(r)}(${snakeVar(r)}, strict=${r.chance(0.5) ? 'True' : 'False'})`];
      if (roll < 30) return [`${ind}if not ${v}:`, `${ind}    raise ValueError(f"${noun(r)} not found: {${v}!r}")`];
      if (roll < 40 && depth < 2) return [`${ind}for ${noun(r)} in ${v}s:`, ...this.stmt(r, ind + '    ', depth + 1)];
      if (roll < 52) return [`${ind}logger.info("${snakeFn(r)}: %s ${r.pick(ADJ)}", ${v})`];
      if (roll < 60) return [`${ind}# ${sentence(r, r.int(5, 12))}.`];
      if (roll < 64) return [`${ind}${v}_keys = [${longList(r, '"')}]`];
      if (roll < 76) return [`${ind}${v}.${noun(r)}_count += ${r.int(1, 99)}`];
      if (roll < 86) return [`${ind}${v} = {k: v for k, v in ${snakeVar(r)}.items() if v is not None}`];
      return [`${ind}return ${v}`];
    },
    block(r) {
      const f = snakeFn(r);
      const T = typeName(r);
      if (r.chance(0.6)) {
        const out = [`def ${f}(${snakeVar(r)}: ${T}, *, strict: bool = False) -> Optional[${typeName(r)}]:`, `    """${sentence(r, 8)}.`, '', `    ${sentence(r, 14)}.`, '', '    Args:', `        strict: ${sentence(r, 6).toLowerCase()}.`, '    """'];
        const n = r.int(2, 7);
        for (let i = 0; i < n; i++) out.push(...this.stmt(r, '    '));
        out.push(`    return None`, '', '');
        return out;
      }
      const out = ['@dataclass', `class ${T}:`, `    """${sentence(r, 10)}."""`, ''];
      const nf = r.int(2, 5);
      for (let i = 0; i < nf; i++) out.push(`    ${snakeVar(r)}: ${r.pick(['str', 'int', 'float', 'bool', 'Optional[str]'])} = ${r.pick(['""', '0', 'None', 'False'])}`);
      out.push('');
      const m = r.int(1, 3);
      for (let i = 0; i < m; i++) {
        out.push(`    def ${snakeFn(r)}(self, ${snakeVar(r)}: Any) -> None:`);
        const n = r.int(1, 5);
        for (let j = 0; j < n; j++) out.push(...this.stmt(r, '        '));
        out.push('');
      }
      out.push('');
      return out;
    },
  },
  go: {
    u: '\t',
    header: (r) => [`package ${r.pick(FEATURES)}`, '', 'import (', '\t"context"', '\t"errors"', '\t"fmt"', '\t"time"', '', `\t"github.com/acme/app/internal/${noun(r)}"`, ')', ''],
    footer: () => [],
    stmt(r, ind, depth = 0) {
      const v = varName(r);
      const roll = r.int(0, 99);
      if (roll < 25) return [`${ind}${v}, err := s.${cap(fnName(r))}(ctx, ${varName(r)})`, `${ind}if err != nil {`, `${ind}\treturn nil, fmt.Errorf("${fnName(r)}: %w", err)`, `${ind}}`];
      if (roll < 35 && depth < 2) return [`${ind}for _, ${noun(r)} := range ${v}s {`, ...this.stmt(r, ind + '\t', depth + 1), `${ind}}`];
      if (roll < 50) return [`${ind}s.log.Info("${fnName(r)}", "${noun(r)}", ${v}, "elapsed", time.Since(start))`];
      if (roll < 60) return [`${ind}// ${sentence(r, r.int(5, 12))}.`];
      if (roll < 64) return [`${ind}${v}Keys := []string{${longList(r, '"')}}`];
      if (roll < 80) return [`${ind}${v}.${cap(noun(r))} = ${r.int(1, 500)}`];
      if (roll < 90) return [`${ind}if errors.Is(err, ${noun(r)}.Err${cap(r.pick(ADJ))}) {`, `${ind}\treturn nil, nil`, `${ind}}`];
      return [`${ind}defer s.mu.Unlock()`];
    },
    block(r) {
      const T = typeName(r);
      if (r.chance(0.3)) {
        const out = [`// ${T} ${sentence(r, 9).toLowerCase()}.`, `type ${T} struct {`];
        const n = r.int(2, 7);
        for (let i = 0; i < n; i++) out.push(`\t${pascal(noun(r), noun(r))} ${r.pick(['string', 'int64', 'bool', 'time.Time', '*' + typeName(r)])} \`json:"${snakeVar(r)}"\``);
        out.push('}', '');
        return out;
      }
      const F = cap(fnName(r));
      const out = [`// ${F} ${sentence(r, 10).toLowerCase()}.`, `func (s *${typeName(r)}) ${F}(ctx context.Context, id string) (*${T}, error) {`, '\tstart := time.Now()'];
      const n = r.int(2, 7);
      for (let i = 0; i < n; i++) out.push(...this.stmt(r, '\t'));
      out.push('\treturn nil, nil', '}', '');
      return out;
    },
  },
  rs: {
    u: '    ',
    header: (r) => [`//! ${sentence(r, 9)}.`, '', 'use std::collections::HashMap;', `use crate::${noun(r)}::{${typeName(r)}, ${typeName(r)}};`, 'use crate::error::Error;', ''],
    footer: () => [],
    stmt(r, ind, depth = 0) {
      const v = snakeVar(r);
      const roll = r.int(0, 99);
      if (roll < 22) return [`${ind}let ${v} = ${snakeFn(r)}(&${snakeVar(r)})?;`];
      if (roll < 32) return [`${ind}if ${v}.is_empty() {`, `${ind}    return Err(Error::${pascal(r.pick(ADJ), noun(r))});`, `${ind}}`];
      if (roll < 42 && depth < 2) return [`${ind}match ${v} {`, `${ind}    Some(value) => {`, ...this.stmt(r, ind + '        ', depth + 1), `${ind}    }`, `${ind}    None => {}`, `${ind}}`];
      if (roll < 54) return [`${ind}tracing::debug!(${v} = ?${v}, "${snakeFn(r)}");`];
      if (roll < 62) return [`${ind}// ${sentence(r, r.int(5, 12))}.`];
      if (roll < 66) return [`${ind}let ${v}_keys = [${longList(r, '"')}];`];
      return [`${ind}${v}.insert("${noun(r)}".to_string(), ${r.int(0, 999)});`];
    },
    block(r) {
      const T = typeName(r);
      const k = r.int(0, 4);
      if (k === 0) {
        const out = ['#[derive(Debug, Clone, PartialEq)]', `pub struct ${T} {`];
        const n = r.int(2, 6);
        for (let i = 0; i < n; i++) out.push(`    pub ${snakeVar(r)}: ${r.pick(['String', 'u64', 'bool', 'Option<String>', 'Vec<u8>'])},`);
        out.push('}', '');
        return out;
      }
      if (k === 1) {
        const out = ['/*'];
        const n = r.int(2, 5);
        for (let i = 0; i < n; i++) out.push(` * ${sentence(r, 12)}.`);
        out.push(' */');
        return out;
      }
      const f = snakeFn(r);
      const out = [`/// ${sentence(r, 10)}.`, `pub fn ${f}(${snakeVar(r)}: &${T}) -> Result<${typeName(r)}, Error> {`, '    let mut cache: HashMap<String, u64> = HashMap::new();'];
      const n = r.int(2, 7);
      for (let i = 0; i < n; i++) out.push(...this.stmt(r, '    '));
      out.push('    todo!()', '}', '');
      return out;
    },
  },
  java: {
    u: '    ',
    header: (r) => [`package com.acme.app.${r.pick(FEATURES)};`, '', 'import java.time.Instant;', 'import java.util.List;', 'import java.util.Optional;', `import com.acme.app.core.${typeName(r)};`, ''],
    footer: () => ['}'],
    stmt(r, ind, depth = 0) {
      const v = varName(r);
      const roll = r.int(0, 99);
      if (roll < 25) return [`${ind}var ${v} = ${fnName(r)}(${varName(r)});`];
      if (roll < 35) return [`${ind}if (${v} == null) {`, `${ind}    throw new IllegalStateException("${noun(r)} missing: " + ${varName(r)});`, `${ind}}`];
      if (roll < 45 && depth < 2) return [`${ind}for (var ${noun(r)} : ${v}s) {`, ...this.stmt(r, ind + '    ', depth + 1), `${ind}}`];
      if (roll < 58) return [`${ind}log.info("${fnName(r)} {} ${r.pick(ADJ)}", ${v});`];
      if (roll < 66) return [`${ind}// ${sentence(r, r.int(5, 12))}.`];
      if (roll < 70) return [`${ind}var ${v}Keys = List.of(${longList(r, '"')});`];
      return [`${ind}${v}.set${pascal(noun(r))}(${r.int(0, 999)});`];
    },
    block(r) {
      const out = ['    /**'];
      const n = r.int(1, 3);
      for (let i = 0; i < n; i++) out.push(`     * ${sentence(r, 10)}.`);
      out.push('     */', `    public Optional<${typeName(r)}> ${fnName(r)}(String ${varName(r)}Id) {`);
      const s = r.int(2, 7);
      for (let i = 0; i < s; i++) out.push(...this.stmt(r, '        '));
      out.push('        return Optional.empty();', '    }', '');
      return out;
    },
  },
  swift: {
    u: '    ',
    header: (r) => ['import Foundation', 'import SwiftUI', '', `/// ${sentence(r, 9)}.`, `struct ${pascal(noun(r))}View: View {`, `    @State private var ${varName(r)}: ${typeName(r)}?`, ''],
    footer: () => ['}'],
    stmt(r, ind, depth = 0) {
      const v = varName(r);
      const roll = r.int(0, 99);
      if (roll < 25) return [`${ind}let ${v} = try await ${fnName(r)}(${varName(r)})`];
      if (roll < 38) return [`${ind}guard let ${v} = ${varName(r)} else {`, `${ind}    return nil`, `${ind}}`];
      if (roll < 46 && depth < 2) return [`${ind}for ${noun(r)} in ${v}s {`, ...this.stmt(r, ind + '    ', depth + 1), `${ind}}`];
      if (roll < 58) return [`${ind}logger.debug("${fnName(r)}: \\(${v})")`];
      if (roll < 66) return [`${ind}// ${sentence(r, r.int(5, 12))}.`];
      return [`${ind}${v}.${noun(r)}Count += ${r.int(1, 99)}`];
    },
    block(r) {
      const out = [`    /// ${sentence(r, 10)}.`, `    func ${fnName(r)}(_ ${varName(r)}: ${typeName(r)}) async throws -> ${typeName(r)}? {`];
      const s = r.int(2, 6);
      for (let i = 0; i < s; i++) out.push(...this.stmt(r, '        '));
      out.push('        return nil', '    }', '');
      return out;
    },
  },
  css: {
    u: '  ',
    header: (r) => [`/* ${sentence(r, 8)}. */`, '', ':root {', `  --${kebab(noun(r), 'color')}: #${r.int(0x100000, 0xffffff).toString(16)};`, `  --${kebab(noun(r), 'gap')}: ${r.int(2, 24)}px;`, '}', ''],
    footer: () => [],
    stmt: (r, ind) => [`${ind || '  '}${r.pick(['margin', 'padding', 'gap', 'border-radius', 'font-size', 'line-height', 'width', 'max-width'])}: ${r.int(0, 64)}px;`],
    block(r) {
      if (r.chance(0.12)) {
        const out = ['/*'];
        for (let i = r.int(2, 4); i > 0; i--) out.push(`  ${sentence(r, 12)}.`);
        out.push('*/');
        return out;
      }
      const out = [`.${kebab(noun(r), r.pick(['panel', 'card', 'row', 'list']))}${r.chance(0.5) ? `__${noun(r)}` : ''}${r.chance(0.2) ? ':hover' : ''} {`];
      const n = r.int(2, 8);
      for (let i = 0; i < n; i++) out.push(...this.stmt(r, '  '));
      if (r.chance(0.3)) out.push(`  color: var(--${kebab(noun(r), 'color')});`);
      out.push('}', '');
      return out;
    },
  },
  json: {
    u: '  ',
    header: () => ['{'],
    footer: () => ['  "version": 3', '}'],
    stmt: (r, ind) => [`${ind || '  '}"${camel(noun(r), noun(r))}": ${r.pick([String(r.int(0, 9999)), 'true', 'false', `"${r.pick(ADJ)}"`, 'null'])},`],
    block(r) {
      const out = [`  "${camel(noun(r), r.pick(ADJ))}": {`];
      const n = r.int(2, 8);
      for (let i = 0; i < n; i++) out.push(...this.stmt(r, '    '));
      out.push(`    "enabled": ${r.chance(0.5)}`, '  },');
      return out;
    },
  },
  md: {
    u: '',
    header: (r) => [`# ${sentence(r, 4)}`, '', `${sentence(r, r.int(30, 70))}.`, ''],
    footer: () => [],
    stmt: (r) => [r.chance(0.5) ? `- ${sentence(r, r.int(4, 12))}.` : `${sentence(r, r.int(10, 30))}.`],
    block(r) {
      const out = [`## ${sentence(r, r.int(2, 5))}`, '', `${sentence(r, r.int(20, 80))}.`, ''];
      if (r.chance(0.5)) {
        for (let i = r.int(2, 6); i > 0; i--) out.push(`- ${sentence(r, r.int(4, 12))}.`);
        out.push('');
      }
      if (r.chance(0.35)) out.push('```ts', `const ${varName(r)} = await ${fnName(r)}('${noun(r)}');`, `console.log(${varName(r)});`, '```', '');
      return out;
    },
  },
  yaml: {
    u: '  ',
    header: (r) => ['apiVersion: apps/v1', 'kind: Deployment', 'metadata:', `  name: ${kebab(noun(r), 'api')}`, '  labels:', `    app: ${kebab(noun(r), noun(r))}`, 'spec:'],
    footer: () => [],
    stmt: (r, ind) => [`${ind || '  '}${snakeVar(r)}: ${r.pick([String(r.int(1, 99)), 'true', 'false', `"${r.pick(ADJ)}"`])}`],
    block(r) {
      const out = [`  ${snake(noun(r), 'config')}:`, `    enabled: ${r.chance(0.5)}`, `    replicas: ${r.int(1, 12)}`, '    env:'];
      for (let i = r.int(1, 4); i > 0; i--) out.push(`      - name: ${snake(noun(r), r.pick(ADJ)).toUpperCase()}`, `        value: "${r.pick(ADJ)}"`);
      if (r.chance(0.2)) out.push(`    # ${sentence(r, 10)}.`);
      return out;
    },
  },
  sh: {
    u: '  ',
    header: () => ['#!/usr/bin/env bash', 'set -euo pipefail', '', 'ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"', ''],
    footer: () => ['', 'main "$@"'],
    stmt(r, ind) {
      ind = ind || '  ';
      const v = snakeVar(r);
      const roll = r.int(0, 9);
      if (roll < 3) return [`${ind}local ${v}="\${1:-${r.pick(ADJ)}}"`];
      if (roll < 5) return [`${ind}if [[ -z "\${${v}:-}" ]]; then`, `${ind}  echo "${noun(r)} is required" >&2`, `${ind}  exit ${r.int(1, 3)}`, `${ind}fi`];
      if (roll < 7) return [`${ind}curl -fsSL "https://internal.acme.test/${noun(r)}/\${${v}}" -o "$ROOT_DIR/tmp/${noun(r)}.json"`];
      if (roll < 8) return [`${ind}# ${sentence(r, 9)}.`];
      return [`${ind}echo "==> ${sentence(r, 4).toLowerCase()}"`];
    },
    block(r) {
      const out = [`${snakeFn(r)}() {`];
      for (let i = r.int(2, 5); i > 0; i--) out.push(...this.stmt(r, '  '));
      out.push('}', '');
      return out;
    },
  },
  sql: {
    u: '  ',
    header: (r) => [`-- Migration: ${sentence(r, 6).toLowerCase()}.`, 'BEGIN;', ''],
    footer: () => ['COMMIT;'],
    stmt: (r, ind) => [`${ind || '  '}AND ${snakeVar(r)} = '${r.pick(ADJ)}'`],
    block(r) {
      const t = snake(noun(r), noun(r), 's');
      const k = r.int(0, 3);
      if (k === 0) {
        const out = [`CREATE TABLE IF NOT EXISTS ${t} (`, '  id BIGSERIAL PRIMARY KEY,'];
        for (let i = r.int(2, 7); i > 0; i--) out.push(`  ${snakeVar(r)} ${r.pick(['TEXT', 'INTEGER', 'BOOLEAN', 'TIMESTAMPTZ', 'NUMERIC(12, 2)'])} NOT NULL,`);
        out.push('  created_at TIMESTAMPTZ NOT NULL DEFAULT now()', ');', '', `CREATE INDEX ${t}_created_idx ON ${t} (created_at);`, '');
        return out;
      }
      if (k === 1) return ['/*', ` * ${sentence(r, 12)}.`, ` * ${sentence(r, 12)}.`, ' */'];
      return [`SELECT id, ${snakeVar(r)}, ${snakeVar(r)}`, `FROM ${t}`, `WHERE tenant_id = $1`, ...this.stmt(r, '  '), 'ORDER BY created_at DESC;', ''];
    },
  },
  html: {
    u: '  ',
    header: (r) => ['<!doctype html>', '<html lang="en">', '<head>', '  <meta charset="utf-8">', `  <title>${sentence(r, 3)}</title>`, '</head>', '<body>'],
    footer: () => ['</body>', '</html>'],
    stmt: (r, ind) => [`${ind || '    '}<p class="${kebab(noun(r), 'text')}">${sentence(r, r.chance(0.1) ? 60 : r.int(4, 14))}.</p>`],
    block(r) {
      const out = [`  <section class="${kebab(noun(r), 'section')}">`, `    <h2>${sentence(r, 3)}</h2>`];
      for (let i = r.int(1, 5); i > 0; i--) out.push(...this.stmt(r, '    '));
      out.push('  </section>');
      return out;
    },
  },
};

function genLines(lang, r, target, withHeader = true) {
  const L = LANGS[lang];
  const out = withHeader ? L.header(r) : [];
  while (out.length < target) out.push(...L.block(r));
  if (withHeader) out.push(...L.footer(r));
  return out;
}

const indentOf = (line) => (line ? /^\s*/.exec(line)[0] : '');

function tweakLine(line, r) {
  if (/\d+/.test(line) && r.chance(0.6)) return line.replace(/\d+/, String(r.int(0, 9999)));
  for (const n of NOUNS) {
    const i = line.indexOf(n);
    if (i >= 0) return line.slice(0, i) + noun(r) + line.slice(i + n.length);
  }
  return null;
}

/** Apply `edits` random edits to a copy of `lines`. */
function mutate(lines, lang, r, edits, { topEdit = false } = {}) {
  const L = LANGS[lang];
  const out = lines.slice();
  const positions = [];
  for (let i = 0; i < edits; i++) positions.push(r.int(0, Math.max(0, out.length - 1)));
  if (topEdit) positions.push(r.int(0, Math.min(8, out.length)));
  positions.sort((a, b) => b - a);
  for (const pos of positions) {
    const ind = indentOf(out[pos] ?? out[pos - 1]);
    const k = r.int(0, 9);
    const stmts = (n) => {
      const s = [];
      for (let i = 0; i < n; i++) s.push(...L.stmt(r, ind || L.u));
      return s;
    };
    if (k <= 3) {
      const n = Math.min(r.int(1, 3), out.length - pos);
      for (let i = pos; i < pos + n; i++) {
        const t = tweakLine(out[i], r);
        out[i] = t ?? L.stmt(r, indentOf(out[i]) || L.u)[0];
      }
    } else if (k <= 6) {
      out.splice(pos, 0, ...stmts(r.int(1, 3)));
    } else if (k === 7) {
      out.splice(pos, r.int(1, 5));
    } else if (k === 8) {
      out.splice(pos, 0, ...L.block(r));
    } else {
      out.splice(pos, r.int(1, 2), ...stmts(r.int(1, 2)));
    }
  }
  return out;
}

const join = (lines, trailingNewline = true) => (lines.length ? lines.join('\n') + (trailingNewline ? '\n' : '') : '');

// ------------------------------------------------------------------ paths

function genPath(r, lang) {
  const f = r.pick(FEATURES);
  const s = r.pick(SUBS);
  const n1 = noun(r);
  const n2 = noun(r);
  switch (lang) {
    case 'ts':
      return r.weighted([
        [`src/features/${f}/${s}/${r.pick(['hooks', 'api', 'utils', 'state'])}/${camel(verb(r), n1, n2)}.ts`, 5],
        [`src/features/${f}/${s}/components/internal/helpers/${camel(n1, n2)}.ts`, 1],
        [`packages/core/src/${f}/${camel(n1, n2)}.ts`, 3],
        [`src/lib/${camel(n1, n2)}.ts`, 2],
        [`src/features/${f}/${s}/use${pascal(n1, n2, noun(r))}StateMachineWithOptimisticUpdates.ts`, 0.4],
        [`tools/codegen/templates/internal/v2/generated/${camel(n1, n2)}Schema.ts`, 0.15],
      ]);
    case 'tsx':
      return r.weighted([
        [`src/features/billing/invoices/components/${pascal(n1, n2)}.tsx`, 2],
        [`web/src/components/${kebab(n1)}/${pascal(n1, n2)}.tsx`, 3],
        [`src/features/${f}/${s}/components/${pascal(n1, n2, r.pick(['Panel', 'Table', 'Card', 'Dialog']))}.tsx`, 4],
      ]);
    case 'js':
      return r.pick([`scripts/build/${kebab(verb(r), n1)}.js`, `web/public/js/${kebab(n1, n2)}.js`, `tools/eslint-rules/no-${kebab(r.pick(ADJ), n1)}.js`]);
    case 'py':
      return r.pick([`services/ml/${f}/${snake(n1, n2)}.py`, `services/ml/${f}/pipelines/${n1}/${snake(verb(r), n2)}.py`, `services/ml/tests/test_${snake(n1, n2)}.py`]);
    case 'go':
      return r.pick([`cmd/server/${snake(n1, n2)}.go`, `internal/${f}/${snake(n1, n2)}.go`, `internal/platform/storage/postgres/${snake(n1)}_store.go`]);
    case 'rs':
      return r.pick([`crates/engine/src/${snake(n1, n2)}.rs`, `crates/${f}-core/src/${s}/${snake(n1)}.rs`]);
    case 'java':
      return r.weighted([
        [`android/app/src/main/java/com/acme/app/${f}/${pascal(n1, n2)}.java`, 5],
        [`android/app/src/main/java/com/acme/app/${f}/${pascal(n1, n2, noun(r))}RepositoryImplementationFactory.java`, 1],
      ]);
    case 'swift':
      return r.pick([`ios/AcmeApp/Features/${cap(f)}/${pascal(n1, n2)}View.swift`, `ios/AcmeApp/Core/${pascal(n1, n2)}.swift`]);
    case 'css':
      return r.pick([`web/src/styles/${kebab(n1, n2)}.css`, `src/features/${f}/${s}/components/${kebab(n1, n2)}.module.css`]);
    case 'json':
      return r.pick([`config/${kebab(n1, n2)}.json`, `packages/${f}/package.json`, `src/features/${f}/locales/${r.pick(['en', 'de', 'fr', 'ja'])}.json`]);
    case 'md':
      return r.pick([`docs/${kebab(n1, n2)}.md`, `docs/adr/00${r.int(10, 99)}-${kebab(verb(r), n1, n2)}.md`, `packages/${f}/README.md`]);
    case 'yaml':
      return r.pick([`infra/k8s/${f}/${kebab(n1, 'deployment')}.yaml`, `.github/workflows/${kebab(verb(r), n1)}.yml`]);
    case 'sh':
      return r.pick([`scripts/${kebab(verb(r), n1)}.sh`, `scripts/ci/${kebab(verb(r), n1, n2)}.sh`]);
    case 'sql':
      return `db/migrations/${String(r.int(1, 9999)).padStart(4, '0')}_${snake(verb(r), n1, n2)}.sql`;
    case 'html':
      return r.pick([`web/public/${kebab(n1, n2)}.html`, `web/templates/emails/${kebab(n1, verb(r))}.html`]);
  }
  throw new Error(lang);
}

const LANG_WEIGHTS = [
  ['ts', 25], ['tsx', 15], ['py', 10], ['go', 8], ['js', 5], ['rs', 6], ['java', 5], ['swift', 5],
  ['css', 5], ['json', 4], ['md', 4], ['yaml', 4], ['sh', 2], ['sql', 2], ['html', 2],
];

const langOf = (path) => {
  const ext = path.slice(path.lastIndexOf('.') + 1);
  return { yml: 'yaml' }[ext] ?? (LANGS[ext] ? ext : 'ts');
};

// ------------------------------------------------------------------ fixture

/**
 * File entry: three contents. null = absent.
 *   head  : committed content (at oldPath for renames)
 *   index : staged content
 *   work  : working-tree content
 */
function entry(e) {
  return { binary: false, tooLarge: false, oldPath: undefined, ...e, diffs: {} };
}

function buildFixture(seed, nFiles, small) {
  const r = new Rng(seed);
  const used = new Set();
  const out = [];
  const add = (e) => {
    used.add(e.path);
    if (e.oldPath) used.add(e.oldPath);
    out.push(entry(e));
  };
  const freshPath = (lang) => {
    for (;;) {
      const p = genPath(r, lang);
      if (!used.has(p)) return p;
    }
  };
  /** Choose the index content: staged, unstaged, or a midpoint. */
  const stage = (head, work, mid) => {
    const k = r.next();
    if (mid && k < 0.2) return mid;
    return k < 0.6 ? work : head;
  };
  const modified = (lang, size, edits, opts = {}) => {
    const path = opts.path ?? freshPath(lang);
    const head = genLines(lang, r, size);
    let index;
    let work;
    if (opts.work) {
      work = opts.work(head);
      index = r.chance(0.6) ? work : head;
    } else {
      const k1 = Math.max(1, Math.floor(edits / 2));
      const mid = mutate(head, lang, r, k1);
      work = mutate(mid, lang, r, Math.max(1, edits - k1));
      index = opts.partial ? mid : stage(head, work, mid);
    }
    const nl = opts.noTrailingNewline ?? false;
    const headText = join(head, opts.headNoNewline ? false : true);
    const workText = join(work, !nl);
    const indexText = index === work ? workText : index === head ? headText : join(index);
    add({ path, lang, head: headText, index: indexText, work: workText });
  };

  // Specials.
  add({ path: 'web/public/images/hero-banner@2x.png', lang: 'bin', binary: true, head: 'PNG:v1', index: 'PNG:v1', work: 'PNG:v2' });
  {
    const lines = genLines('json', r, small ? 600 : 4000);
    const work = mutate(lines, 'json', r, small ? 20 : 300);
    const t = join(work);
    add({ path: 'packages/core/src/generated/translations.en-US.json', lang: 'json', tooLarge: true, head: join(lines), index: t, work: t });
  }
  {
    const t = join(genLines('java', r, small ? 300 : 3000));
    add({ path: 'services/billing/src/main/java/com/acme/billing/legacy/LegacyInvoiceExporter.java', lang: 'java', head: t, index: null, work: null });
  }
  if (!small) {
    for (const lang of ['py', 'css']) {
      const t = join(genLines(lang, r, r.int(40, 160)));
      add({ path: freshPath(lang), lang, head: t, index: t, work: null }); // unstaged deletion
    }
  }
  const addedSizes = small ? [60] : [45, 160, 420, 1200];
  addedSizes.forEach((size, i) => {
    const lang = ['ts', 'tsx', 'go', 'md'][i % 4];
    const t = join(genLines(lang, r, size), i !== 1);
    // Mix of staged new files and untracked files.
    add({ path: freshPath(lang), lang, head: null, index: i % 2 === 0 ? t : null, work: t });
  });
  {
    const head = genLines('ts', r, 140);
    const work = join(mutate(head, 'ts', r, 4));
    add({ path: 'packages/core/src/time/formatDate.ts', oldPath: 'src/utils/date.ts', lang: 'ts', head: join(head), index: work, work });
  }
  {
    const t = join(genLines('md', r, 90));
    add({ path: 'docs/getting-started/local-setup.md', oldPath: 'docs/setup.md', lang: 'md', head: t, index: t, work: t });
  }
  // Files whose new text has no trailing newline.
  modified('ts', 80, 4, { noTrailingNewline: true, partial: true });
  if (!small) {
    modified('py', 120, 2, { noTrailingNewline: true });
    modified('sh', 60, 2, { noTrailingNewline: true, headNoNewline: true });
  }

  // Large changes (1000-3000 changed lines each).
  const bigKinds = small ? ['insert'] : ['insert', 'replace', 'delete', 'many', 'top'];
  for (const kind of bigKinds) {
    const lang = r.pick(['ts', 'tsx', 'go', 'py', 'rs']);
    const s = small ? 0.2 : 1;
    if (kind === 'insert')
      modified(lang, Math.round(500 * s), 0, { work: (h) => { const w = h.slice(); w.splice(Math.floor(h.length / 2), 0, ...genLines(lang, r, Math.round(2200 * s), false)); return w; } });
    if (kind === 'replace')
      modified(lang, 2000, 0, { work: (h) => { const w = h.slice(); w.splice(600, 900, ...genLines(lang, r, 1000, false)); return w; } });
    if (kind === 'delete')
      modified(lang, 2400, 0, { work: (h) => { const w = mutate(h, lang, r, 3); w.splice(700, 1200); return w; } });
    if (kind === 'many') modified(lang, 1800, 260);
    if (kind === 'top')
      modified(lang, 300, 0, { work: (h) => [...h.slice(0, 6), ...genLines(lang, r, 1100, false), ...h.slice(6)] });
  }

  // Long files with few edits (big hidden-context gaps).
  for (let i = 0, n = small ? 1 : 10; i < n; i++) modified(r.pick(['ts', 'go', 'java', 'py', 'tsx']), r.int(2000, 4000), r.int(2, 4));

  // Everything else: small edits.
  while (out.length < (small ? 12 : nFiles)) {
    const lang = r.weighted(LANG_WEIGHTS);
    const size = r.weighted([[r.int(30, 250), 6], [r.int(250, 800), 3], [r.int(800, 1500), 1]]);
    const edits = r.chance(0.15) ? r.int(6, 16) : r.int(2, 7);
    modified(lang, size, edits);
  }
  return out;
}

// ------------------------------------------------------------------ diff

const EQ = 0;
const DEL = 1;
const ADD = 2;
const CTX = 3;
const MYERS_CAP = 1500;

function splitText(t) {
  if (t == null || t === '') return { lines: [], keys: [] };
  const lines = t.split('\n');
  let nonl = true;
  if (lines[lines.length - 1] === '') {
    lines.pop();
    nonl = false;
  }
  let keys = lines;
  if (nonl) {
    // Like git, a missing final newline makes the last line differ.
    keys = lines.slice();
    keys[keys.length - 1] += '\u0000';
  }
  return { lines, keys };
}

/** Line diff: patience anchors on unique lines, Myers in between. Returns op types in order. */
function diffKeys(A, B) {
  const ids = new Map();
  const intern = (s) => {
    let v = ids.get(s);
    if (v === undefined) ids.set(s, (v = ids.size));
    return v;
  };
  const a = Int32Array.from(A, intern);
  const b = Int32Array.from(B, intern);
  const out = [];

  const myers = (a0, a1, b0, b1) => {
    const n = a1 - a0;
    const m = b1 - b0;
    const max = n + m;
    const cap = Math.min(max, MYERS_CAP);
    const off = max + 1;
    const v = new Int32Array(2 * max + 3);
    const trace = [];
    let found = -1;
    outer: for (let d = 0; d <= cap; d++) {
      for (let k = -d; k <= d; k += 2) {
        let x = k === -d || (k !== d && v[off + k - 1] < v[off + k + 1]) ? v[off + k + 1] : v[off + k - 1] + 1;
        let y = x - k;
        while (x < n && y < m && a[a0 + x] === b[b0 + y]) {
          x++;
          y++;
        }
        v[off + k] = x;
        if (x >= n && y >= m) {
          trace.push(v.slice(off - d, off + d + 1));
          found = d;
          break outer;
        }
      }
      trace.push(v.slice(off - d, off + d + 1));
    }
    if (found < 0) {
      for (let i = 0; i < n; i++) out.push(DEL);
      for (let j = 0; j < m; j++) out.push(ADD);
      return;
    }
    const rev = [];
    let x = n;
    let y = m;
    for (let d = found; d > 0; d--) {
      const prev = trace[d - 1];
      const o = d - 1;
      const k = x - y;
      const prevK = k === -d || (k !== d && prev[k - 1 + o] < prev[k + 1 + o]) ? k + 1 : k - 1;
      const prevX = prev[prevK + o];
      const prevY = prevX - prevK;
      while (x > prevX && y > prevY) {
        x--;
        y--;
        rev.push(EQ);
      }
      if (x === prevX) {
        y--;
        rev.push(ADD);
      } else {
        x--;
        rev.push(DEL);
      }
    }
    while (x > 0 && y > 0) {
      x--;
      y--;
      rev.push(EQ);
    }
    for (let i = rev.length - 1; i >= 0; i--) out.push(rev[i]);
  };

  const anchors = (a0, a1, b0, b1) => {
    const ca = new Map();
    for (let i = a0; i < a1; i++) {
      const c = ca.get(a[i]);
      ca.set(a[i], c === undefined ? i : -1);
    }
    const cb = new Map();
    for (let j = b0; j < b1; j++) {
      if (!ca.has(b[j]) || ca.get(b[j]) < 0) continue;
      const c = cb.get(b[j]);
      cb.set(b[j], c === undefined ? j : -1);
    }
    const cand = [];
    for (let i = a0; i < a1; i++) {
      if (ca.get(a[i]) !== i) continue;
      const j = cb.get(a[i]);
      if (j !== undefined && j >= 0) cand.push([i, j]);
    }
    if (!cand.length) return cand;
    // Longest increasing subsequence on b index.
    const tails = [];
    const prev = new Int32Array(cand.length);
    for (let c = 0; c < cand.length; c++) {
      const j = cand[c][1];
      let lo = 0;
      let hi = tails.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (cand[tails[mid]][1] < j) lo = mid + 1;
        else hi = mid;
      }
      prev[c] = lo > 0 ? tails[lo - 1] : -1;
      tails[lo] = c;
    }
    const res = [];
    for (let c = tails[tails.length - 1]; c >= 0; c = prev[c]) res.push(cand[c]);
    return res.reverse();
  };

  const rec = (a0, a1, b0, b1) => {
    while (a0 < a1 && b0 < b1 && a[a0] === b[b0]) {
      out.push(EQ);
      a0++;
      b0++;
    }
    let s = 0;
    while (a1 - s > a0 && b1 - s > b0 && a[a1 - 1 - s] === b[b1 - 1 - s]) s++;
    const ae = a1 - s;
    const be = b1 - s;
    if (a0 === ae) for (let j = b0; j < be; j++) out.push(ADD);
    else if (b0 === be) for (let i = a0; i < ae; i++) out.push(DEL);
    else {
      const anc = anchors(a0, ae, b0, be);
      if (!anc.length) myers(a0, ae, b0, be);
      else {
        let pa = a0;
        let pb = b0;
        for (const [ia, ib] of anc) {
          rec(pa, ia, pb, ib);
          out.push(EQ);
          pa = ia + 1;
          pb = ib + 1;
        }
        rec(pa, ae, pb, be);
      }
    }
    for (let k = 0; k < s; k++) out.push(EQ);
  };

  rec(0, a.length, 0, b.length);

  // Normalize: in each change run, deletions first, then additions (like git).
  const norm = new Uint8Array(out.length);
  let w = 0;
  for (let i = 0; i < out.length; ) {
    if (out[i] === EQ) {
      norm[w++] = EQ;
      i++;
      continue;
    }
    let dels = 0;
    let adds = 0;
    while (i < out.length && out[i] !== EQ) {
      if (out[i] === DEL) dels++;
      else adds++;
      i++;
    }
    for (; dels > 0; dels--) norm[w++] = DEL;
    for (; adds > 0; adds--) norm[w++] = ADD;
  }
  return norm;
}

const DECL_RE =
  /^\s*(?:export\s+)?(?:default\s+)?(?:pub(?:\([a-z]+\))?\s+)?(?:async\s+)?(?:(?:public|private|protected|static|final|abstract)\s+)*(?:function\*?|class|interface|enum|struct|impl|trait|fn|def|func|type|extension|protocol)\s|^\s*(?:export\s+)?const\s+\w+\s*=\s*(?:async\s*)?\(|^\s*(?:public|private|protected)\s+[\w<>\[\], ?]+\s+\w+\s*\(|^\s+(?:async\s+)?(?!if\b|for\b|while\b|switch\b|catch\b|return\b)[a-zA-Z_]\w*\s*\([^)]*\)\s*(?::\s*[\w<>\[\]|, ]+)?\s*\{\s*$|^[a-z_]\w*\(\)\s*\{|^#{1,6}\s|^CREATE\s/;

function buildHunks(types, aLines, bLines) {
  const N = types.length;
  const ai = new Int32Array(N + 1);
  const bi = new Int32Array(N + 1);
  let x = 0;
  let y = 0;
  let additions = 0;
  let deletions = 0;
  for (let i = 0; i < N; i++) {
    ai[i] = x;
    bi[i] = y;
    if (types[i] !== ADD) x++;
    if (types[i] !== DEL) y++;
    if (types[i] === ADD) additions++;
    else if (types[i] === DEL) deletions++;
  }
  ai[N] = x;
  bi[N] = y;
  let prevDecl = null;
  const section = (before) => {
    if (before <= 0) return '';
    if (!prevDecl) {
      prevDecl = new Int32Array(aLines.length);
      let last = -1;
      for (let i = 0; i < aLines.length; i++) {
        if (DECL_RE.test(aLines[i])) last = i;
        prevDecl[i] = last;
      }
    }
    const d = prevDecl[before - 1];
    return d < 0 ? '' : aLines[d].slice(0, 80).trimEnd();
  };
  const hunks = [];
  let idx = 0;
  let prevEnd = 0;
  while (idx < N) {
    while (idx < N && types[idx] === EQ) idx++;
    if (idx >= N) break;
    const start = Math.max(idx - CTX, prevEnd);
    let j = idx;
    let end;
    for (;;) {
      while (j < N && types[j] !== EQ) j++;
      let k = j;
      while (k < N && types[k] === EQ) k++;
      if (k < N && k - j <= 2 * CTX) {
        j = k;
        continue;
      }
      end = Math.min(N, j + CTX);
      break;
    }
    const lines = [];
    let oldLines = 0;
    let newLines = 0;
    for (let i = start; i < end; i++) {
      const t = types[i];
      if (t === EQ) {
        lines.push({ type: 'context', oldLine: ai[i] + 1, newLine: bi[i] + 1, text: aLines[ai[i]] });
        oldLines++;
        newLines++;
      } else if (t === DEL) {
        lines.push({ type: 'del', oldLine: ai[i] + 1, text: aLines[ai[i]] });
        oldLines++;
      } else {
        lines.push({ type: 'add', newLine: bi[i] + 1, text: bLines[bi[i]] });
        newLines++;
      }
    }
    const ob = ai[start];
    const nb = bi[start];
    hunks.push({
      oldStart: oldLines ? ob + 1 : ob,
      oldLines,
      newStart: newLines ? nb + 1 : nb,
      newLines,
      section: section(ob),
      lines,
    });
    prevEnd = end;
    idx = end;
  }
  return { hunks, additions, deletions, types };
}

function diffTexts(oldText, newText) {
  const a = splitText(oldText);
  const b = splitText(newText);
  const res = buildHunks(diffKeys(a.keys, b.keys), a.lines, b.lines);
  return { ...res, oldCount: a.lines.length, newCount: b.lines.length };
}

const sha = (...parts) => {
  const h = crypto.createHash('sha1');
  for (const p of parts) h.update(String(p ?? '\u0001')).update('\u0000');
  return h.digest('hex').slice(0, 12);
};

function hunksFingerprint(head, hunks) {
  const h = crypto.createHash('sha1');
  h.update(head);
  for (const hk of hunks) {
    h.update(`@@${hk.oldStart},${hk.oldLines},${hk.newStart},${hk.newLines}\n`);
    for (const l of hk.lines) h.update(l.type[0]).update(l.text).update('\n');
  }
  return h.digest('hex').slice(0, 12);
}

// ------------------------------------------------------------------ scopes

const SCOPES = ['all', 'staged', 'unstaged'];
const SIDES = {
  all: { old: 'head', new: 'work' },
  staged: { old: 'head', new: 'index' },
  unstaged: { old: 'index', new: 'work' },
};

function scopeTexts(e, scope) {
  const s = SIDES[scope];
  return { oldKey: s.old, newKey: s.new, oldText: e[s.old], newText: e[s.new] };
}

function isRename(e, scope) {
  const { oldKey, oldText, newText } = scopeTexts(e, scope);
  return !!e.oldPath && oldKey === 'head' && oldText != null && newText != null;
}

function inScopeEntry(e, scope) {
  const { oldText, newText } = scopeTexts(e, scope);
  return oldText !== newText || isRename(e, scope);
}

/** DiffFile without viewed flags. Cached on the entry (entries are replaced, never mutated). */
function diffOf(e, scope) {
  const cached = e.diffs[scope];
  if (cached) return cached;
  const { oldText, newText } = scopeTexts(e, scope);
  // Reuse a diff of the same text pair from another scope.
  for (const s of SCOPES) {
    const d = e.diffs[s];
    if (d && s !== scope) {
      const t = scopeTexts(e, s);
      if (t.oldText === oldText && t.newText === newText && isRename(e, s) === isRename(e, scope)) return (e.diffs[scope] = d);
    }
  }
  const rename = isRename(e, scope);
  const status = oldText == null ? 'added' : newText == null ? 'deleted' : rename ? 'renamed' : 'modified';
  const path = status === 'deleted' && e.oldPath && !rename ? e.oldPath : e.path;
  const f = {
    path,
    ...(rename ? { oldPath: e.oldPath } : {}),
    status,
    binary: e.binary,
    additions: 0,
    deletions: 0,
    hunks: [],
    tooLarge: false,
    fingerprint: '',
    oldLineCount: 0,
    newLineCount: 0,
  };
  if (e.binary) {
    f.fingerprint = sha(status, path, f.oldPath, oldText, newText);
  } else {
    const d = diffTexts(oldText, newText);
    f.additions = d.additions;
    f.deletions = d.deletions;
    f.oldLineCount = oldText == null ? 0 : d.oldCount;
    f.newLineCount = newText == null ? 0 : d.newCount;
    if (e.tooLarge) {
      f.tooLarge = true;
      f.fingerprint = sha('tooLarge', status, path, oldText, newText);
    } else {
      f.hunks = d.hunks;
      f.fingerprint = hunksFingerprint(`${status}|${f.oldPath ?? ''}|${path}|`, d.hunks);
    }
  }
  return (e.diffs[scope] = f);
}

// ------------------------------------------------------------------ state

const REPO = { root: '/workspace/acme-app', name: 'acme-app', branch: 'main' };
const VERSION = '0.0.0-mock';
const nowIso = () => new Date().toISOString();
const fakeSha = (s) => crypto.createHash('sha1').update(s).digest('hex');

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const reviews = new Map(); // id -> review state
const threads = new Map(); // id -> internal thread
const messageThread = new Map(); // message id -> thread id
let nextThreadId = 1;
let nextMessageId = 1;
let presence = [];
const sseClients = new Map(); // review id -> Set<{res, scope}>
const waiters = [];
const simTimers = new Map(); // thread id -> timeout handles

let baseEntries = null;

function makeReview(spec) {
  const id = reviewIdFor(spec);
  const t = nowIso();
  const files = new Map();
  for (const e of baseEntries) files.set(e.path, e);
  const rv = {
    id,
    spec,
    title: titleFor(spec),
    createdAt: t,
    updatedAt: t,
    scopes: spec.kind === 'working' ? SCOPES.slice() : ['all'],
    resolved: { from: fakeSha(`${id}:from`), to: spec.kind === 'working' || spec.kind === 'branch' ? null : fakeSha(`${id}:to`) },
    files,
    savedFiles: null,
    viewed: { all: new Map(), staged: new Map(), unstaged: new Map() },
    fp: {},
  };
  reviews.set(id, rv);
  return rv;
}

function slug(s) {
  return String(s).replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase();
}
function reviewIdFor(spec) {
  switch (spec.kind) {
    case 'working':
      return 'working';
    case 'branch':
      return `branch-${slug(spec.head)}-vs-${slug(spec.base)}`;
    case 'commit':
      return `commit-${slug(spec.rev)}`;
    case 'range':
      return `range-${slug(spec.from)}-${slug(spec.to)}`;
  }
  throw new HttpError(400, 'invalid spec.kind');
}
function titleFor(spec) {
  switch (spec.kind) {
    case 'working':
      return 'Uncommitted changes';
    case 'branch':
      return `${spec.head} → ${spec.base}`;
    case 'commit':
      return `Commit ${spec.rev.slice(0, 7)}`;
    case 'range':
      return `${spec.from}..${spec.to}`;
  }
}

function getReview(id) {
  const rv = reviews.get(id);
  if (!rv) throw new HttpError(404, `review not found: ${id}`);
  return rv;
}

function scopeParam(rv, q) {
  const s = q.get('scope') || 'all';
  if (!SCOPES.includes(s)) throw new HttpError(400, `invalid scope: ${s}`);
  if (rv && !rv.scopes.includes(s)) throw new HttpError(400, `scope ${s} not supported by review ${rv.id}`);
  return s;
}

/** Files in a scope, sorted by path. */
function scopeFiles(rv, scope) {
  const list = [];
  for (const e of rv.files.values()) if (inScopeEntry(e, scope)) list.push(e);
  list.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return list;
}

function findEntry(rv, path) {
  const e = rv.files.get(path);
  if (e) return e;
  for (const x of rv.files.values()) if (x.oldPath === path) return x;
  return null;
}

function diffFingerprint(rv, scope) {
  const key = `${scope}`;
  const c = rv.fp[key];
  if (c) return c;
  const h = crypto.createHash('sha1');
  for (const e of scopeFiles(rv, scope)) h.update(diffOf(e, scope).path).update(diffOf(e, scope).fingerprint);
  return (rv.fp[key] = h.digest('hex').slice(0, 12));
}

function fileView(rv, e, scope) {
  const d = diffOf(e, scope);
  const v = rv.viewed[scope].get(d.path);
  const viewed = !!v && v.fingerprint === d.fingerprint;
  return { ...d, viewed, changedSinceViewed: !!v && !viewed };
}

function touch(rv) {
  rv.updatedAt = nowIso();
}

function summary(rv) {
  let threadCount = 0;
  let unresolvedCount = 0;
  for (const t of threads.values()) {
    if (t.reviewId !== rv.id) continue;
    threadCount++;
    if (!t.resolved) unresolvedCount++;
  }
  return { id: rv.id, spec: rv.spec, title: rv.title, createdAt: rv.createdAt, updatedAt: rv.updatedAt, threadCount, unresolvedCount };
}

function reviewView(rv, scope) {
  const scopeFileCounts = {};
  for (const s of rv.scopes) {
    let n = 0;
    for (const e of rv.files.values()) if (inScopeEntry(e, s)) n++;
    scopeFileCounts[s] = n;
  }
  const ts = [...threads.values()].filter((t) => t.reviewId === rv.id).sort((a, b) => a.id - b.id);
  return {
    ...summary(rv),
    repo: REPO,
    scope,
    scopes: rv.scopes,
    scopeFileCounts,
    resolved: rv.resolved,
    diffFingerprint: diffFingerprint(rv, scope),
    files: scopeFiles(rv, scope).map((e) => fileView(rv, e, scope)),
    threads: ts.map((t) => threadView(t, scope)),
    agents: presence,
  };
}

// ------------------------------------------------------------------ threads

/** Side of `scope` that shows `content`, or null. */
function sideFor(scope, content) {
  const s = SIDES[scope];
  return s.new === content ? 'new' : s.old === content ? 'old' : null;
}

function threadView(t, scope = 'all') {
  const rv = reviews.get(t.reviewId);
  let side = rv && rv.scopes.includes(scope) ? sideFor(scope, t.content) : null;
  // The content is a side of this scope, but the file has no change in it: show it in the home scope.
  const e = side && scope !== t.homeScope ? findEntry(rv, t.anchor.path) : null;
  if (e && !inScopeEntry(e, scope) && inScopeEntry(e, t.homeScope)) side = null;
  const inScope = side !== null;
  const shown = inScope ? scope : t.homeScope;
  if (!inScope) side = sideFor(t.homeScope, t.content);
  return {
    id: t.id,
    reviewId: t.reviewId,
    anchor: { path: t.anchor.path, side, startLine: t.anchor.startLine, endLine: t.anchor.endLine },
    inScope,
    homeScope: t.homeScope,
    snippet: t.snippet,
    outdated: isOutdated(t, shown),
    resolved: t.resolved,
    noteOnly: t.noteOnly,
    agentState: t.agentState,
    claimedBy: t.claimedBy,
    messages: t.messages.map((m) => ({ ...m, author: { ...m.author } })),
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
  };
}

function isOutdated(t, scope) {
  if (t.forceOutdated) return true;
  const rv = reviews.get(t.reviewId);
  const e = rv && findEntry(rv, t.anchor.path);
  if (!e || !inScopeEntry(e, scope)) return true;
  if (t.anchor.startLine == null) return false;
  const text = e[t.content];
  if (text == null) return true;
  return t.anchor.endLine > splitText(text).lines.length;
}

function recomputeAgentState(t) {
  if (t.resolved || t.noteOnly) {
    t.agentState = 'idle';
    t.claimedBy = null;
    return;
  }
  const last = t.messages[t.messages.length - 1];
  if (!last || last.author.kind === 'agent') {
    t.agentState = 'idle';
    t.claimedBy = null;
  } else if (t.agentState !== 'working') {
    t.agentState = 'pending';
  }
}

function sendEvent(c, ev) {
  c.res.write(`data: ${JSON.stringify(ev)}\n\n`);
}

/** `ev` is an event, or a function (scope) -> event. */
function broadcast(reviewId, ev, onlyScope = null) {
  const set = sseClients.get(reviewId);
  if (!set) return;
  for (const c of set) {
    if (onlyScope && c.scope !== onlyScope) continue;
    sendEvent(c, typeof ev === 'function' ? ev(c.scope) : ev);
  }
}
function broadcastAll(ev) {
  for (const id of sseClients.keys()) broadcast(id, ev);
}
function broadcastThread(t) {
  broadcast(t.reviewId, (scope) => ({ type: 'thread', thread: threadView(t, scope) }));
}
function broadcastAgents() {
  broadcastAll({ type: 'agents', agents: presence });
}
function broadcastDiffChanged(rv) {
  rv.fp = {};
  touch(rv);
  broadcast(rv.id, (scope) => ({ type: 'diff-changed', diffFingerprint: diffFingerprint(rv, rv.scopes.includes(scope) ? scope : 'all') }));
}

function setPresence(name, state) {
  const p = presence.find((x) => x.name === name);
  if (p && p.state === state) return false;
  const next = { name, state, since: nowIso() };
  presence = p ? presence.map((x) => (x.name === name ? next : x)) : [...presence, next];
  broadcastAgents();
  return true;
}

function holdsThreads(agent) {
  for (const t of threads.values()) if (t.claimedBy === agent && t.agentState === 'working') return true;
  return false;
}

function snippetFor(rv, anchor, content) {
  if (anchor.startLine == null) return [];
  const e = findEntry(rv, anchor.path);
  const text = e?.[content];
  if (text == null) return [];
  return splitText(text).lines.slice(anchor.startLine - 1, anchor.endLine);
}

function createThread(rv, scope, { anchor, body, author, noteOnly = false }, opts = {}) {
  const t0 = opts.at ?? nowIso();
  const content = SIDES[scope][anchor.side];
  const t = {
    id: nextThreadId++,
    reviewId: rv.id,
    content,
    homeScope: scope,
    anchor: { path: anchor.path, startLine: anchor.startLine, endLine: anchor.endLine },
    snippet: opts.snippet ?? snippetFor(rv, anchor, content),
    forceOutdated: !!opts.outdated,
    resolved: false,
    noteOnly: !!noteOnly,
    agentState: 'idle',
    claimedBy: null,
    messages: [],
    createdAt: t0,
    updatedAt: t0,
  };
  threads.set(t.id, t);
  addMessage(t, { body, author }, { at: t0, silent: true });
  return t;
}

function addMessage(t, { body, author }, { at, silent = false } = {}) {
  const m = { id: nextMessageId++, author: { kind: author.kind, name: author.name }, body, createdAt: at ?? nowIso(), editedAt: null };
  t.messages.push(m);
  messageThread.set(m.id, t.id);
  t.updatedAt = m.createdAt;
  if (author.kind === 'agent') {
    const holder = t.claimedBy;
    t.agentState = 'idle';
    t.claimedBy = null;
    if (holder && !holdsThreads(holder) && presence.some((p) => p.name === holder)) setPresence(holder, 'waiting');
    if (author.name !== holder && presence.some((p) => p.name === author.name) && !holdsThreads(author.name)) setPresence(author.name, 'waiting');
  } else {
    if (t.agentState === 'working') {
      // Human follow-up while an agent works: the agent still holds it.
    } else recomputeAgentState(t);
  }
  if (!silent) afterHumanMessage(t, author);
  return m;
}

function afterHumanMessage(t, author) {
  if (author.kind !== 'human' || t.noteOnly || t.resolved) return;
  if (t.agentState === 'pending') {
    setImmediate(serviceWaiters);
    scheduleSimAgent(t.id);
  }
}

function deleteThread(t) {
  threads.delete(t.id);
  for (const m of t.messages) messageThread.delete(m.id);
  cancelSim(t.id);
  const holder = t.claimedBy;
  if (holder && !holdsThreads(holder) && presence.some((p) => p.name === holder)) setPresence(holder, 'waiting');
  broadcast(t.reviewId, { type: 'thread-deleted', threadId: t.id });
}

function getThread(id) {
  const t = threads.get(Number(id));
  if (!t) throw new HttpError(404, `thread not found: ${id}`);
  return t;
}

// ------------------------------------------------------------------ simulated agent

const SIM = 'claude';

function cancelSim(id) {
  const hs = simTimers.get(id);
  if (hs) for (const h of hs) clearTimeout(h);
  simTimers.delete(id);
}

function scheduleSimAgent(id) {
  if (!OPTS.agent) return;
  cancelSim(id);
  const h1 = setTimeout(() => {
    const t = threads.get(id);
    if (!t || t.agentState !== 'pending' || !presence.some((p) => p.name === SIM)) return cancelSim(id);
    t.agentState = 'working';
    t.claimedBy = SIM;
    t.updatedAt = nowIso();
    broadcastThread(t);
    setPresence(SIM, 'working');
    const h2 = setTimeout(() => {
      simTimers.delete(id);
      const t2 = threads.get(id);
      if (!t2 || t2.agentState !== 'working' || t2.claimedBy !== SIM) return;
      agentReply(t2, SIM);
    }, 3000 + Math.random() * 2000);
    simTimers.set(id, [h2]);
  }, 1500);
  simTimers.set(id, [h1]);
}

let replyCounter = 0;
function replyBody(t) {
  const loc = t.anchor.startLine == null ? `\`${t.anchor.path}\`` : `\`${t.anchor.path}:${t.anchor.startLine}${t.anchor.endLine !== t.anchor.startLine ? `-${t.anchor.endLine}` : ''}\``;
  const lastHuman = [...t.messages].reverse().find((m) => m.author.kind === 'human');
  const quote = lastHuman ? lastHuman.body.split('\n')[0].slice(0, 80) : '';
  const k = replyCounter++ % 4;
  if (k === 0)
    return `Good question. I read ${loc} and the call sites around it.\n\nThe value is loaded once per request and then reused, so this is not a second round-trip. I can make that explicit:\n\n\`\`\`ts\nconst cached = cache.get(id) ?? (await loadRecord(id));\ncache.set(id, cached);\n\`\`\`\n\nWant me to apply this?`;
  if (k === 1)
    return `You're right. In ${loc} the guard runs after the write, so a stale value can leak through.\n\nI will:\n\n1. Move the guard above the write.\n2. Add a test for the empty case.\n3. Keep the log line, but at \`debug\` level.`;
  if (k === 2) return `This is intentional. ${loc} mirrors the behavior of the old exporter; see [ADR 0042](https://example.com/adr/0042) for the reasoning.\n\n> ${quote}\n\nIf we change it, the nightly reconciliation job needs the same change.`;
  return `Done. I changed ${loc} to use the shared helper and ran the tests:\n\n\`\`\`\n✓ 48 passed (1.9s)\n\`\`\``;
}

function agentReply(t, name) {
  cancelSim(t.id);
  if (!t.claimedBy) t.claimedBy = name;
  addMessage(t, { body: replyBody(t), author: { kind: 'agent', name } }, { silent: true });
  broadcastThread(t);
  if (presence.some((p) => p.name === name) && !holdsThreads(name)) setPresence(name, 'waiting');
}

// ------------------------------------------------------------------ agent endpoints

function agentThread(t) {
  const rv = reviews.get(t.reviewId);
  const view = threadView(t, t.homeScope);
  return {
    thread: view,
    review: { id: rv.id, title: rv.title, spec: rv.spec, from: rv.resolved.from, to: rv.resolved.to },
    repoRoot: REPO.root,
    diffContext: diffContext(rv, t, view),
  };
}

function diffContext(rv, t, view) {
  if (view.outdated || t.anchor.startLine == null) return null;
  const e = findEntry(rv, t.anchor.path);
  if (!e) return null;
  const d = diffOf(e, t.homeScope);
  const key = view.anchor.side === 'old' ? 'oldLine' : 'newLine';
  const s = t.anchor.startLine;
  const en = t.anchor.endLine;
  const out = [`--- a/${d.oldPath ?? d.path}`, `+++ b/${d.path}`];
  let any = false;
  for (const h of d.hunks) {
    const lo = view.anchor.side === 'old' ? h.oldStart : h.newStart;
    const hi = lo + (view.anchor.side === 'old' ? h.oldLines : h.newLines) - 1;
    if (hi < s - 3 || lo > en + 3) continue;
    any = true;
    out.push(`@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@${h.section ? ' ' + h.section : ''}`);
    for (const l of h.lines) {
      const n = l[key];
      if (n !== undefined && (n < s - 20 || n > en + 20)) continue;
      const mark = n !== undefined && n >= s && n <= en ? '>' : ' ';
      out.push(`${mark}${String(l.oldLine ?? '').padStart(5)} ${String(l.newLine ?? '').padStart(5)} ${l.type === 'add' ? '+' : l.type === 'del' ? '-' : ' '}${l.text}`);
    }
  }
  return any ? out.join('\n') : null;
}

function claimPending(agent, reviewId) {
  const list = [...threads.values()]
    .filter((t) => (!reviewId || t.reviewId === reviewId) && !t.resolved && !t.noteOnly && t.agentState === 'pending')
    .sort((a, b) => a.id - b.id);
  for (const t of list) {
    cancelSim(t.id);
    t.agentState = 'working';
    t.claimedBy = agent;
    t.updatedAt = nowIso();
    broadcastThread(t);
  }
  return list;
}

function serviceWaiters() {
  for (let i = 0; i < waiters.length; ) {
    const w = waiters[i];
    const claimed = claimPending(w.agent, w.reviewId);
    if (claimed.length) {
      waiters.splice(i, 1);
      clearTimeout(w.timer);
      setPresence(w.agent, 'working');
      send(w.res, 200, { threads: claimed.map(agentThread), timedOut: false });
    } else i++;
  }
}

// ------------------------------------------------------------------ diff change simulation

const changeRng = new Rng(OPTS.seed ^ 0x5eed);

function replaceEntry(rv, e, patch) {
  const next = entry({ ...e, ...patch });
  delete next.diffs;
  next.diffs = {};
  rv.files.set(next.path, next);
  return next;
}

/** Shift working-tree threads on `path` after its text changed; mark them outdated if their lines changed. */
function reanchor(rv, path, content, prevText, nextText) {
  let map = null;
  for (const t of threads.values()) {
    if (t.reviewId !== rv.id || t.anchor.path !== path || t.content !== content || t.anchor.startLine == null || t.forceOutdated) continue;
    if (!map) {
      const a = splitText(prevText);
      const b = splitText(nextText);
      const types = diffKeys(a.keys, b.keys);
      map = new Int32Array(a.lines.length).fill(-1);
      let x = 0;
      let y = 0;
      for (const ty of types) {
        if (ty === EQ) map[x] = y;
        if (ty !== ADD) x++;
        if (ty !== DEL) y++;
      }
    }
    const s = map[t.anchor.startLine - 1] ?? -1;
    const en = map[t.anchor.endLine - 1] ?? -1;
    if (s < 0 || en < 0 || en - s !== t.anchor.endLine - t.anchor.startLine) t.forceOutdated = true;
    else if (s + 1 === t.anchor.startLine) continue;
    else {
      t.anchor.startLine = s + 1;
      t.anchor.endLine = en + 1;
    }
    t.updatedAt = nowIso();
    broadcastThread(t);
  }
}

function simulateChange(rv) {
  const r = changeRng;
  const candidates = [...rv.files.values()].filter((e) => !e.binary && !e.tooLarge && e.work != null && LANGS[e.lang]);
  const picked = new Set();
  while (picked.size < Math.min(3, candidates.length)) picked.add(r.pick(candidates));
  const changed = [];
  for (const e of picked) {
    const lines = splitText(e.work).lines;
    const work = join(mutate(lines, e.lang, r, r.int(1, 2), { topEdit: true }));
    const next = replaceEntry(rv, e, { work });
    reanchor(rv, e.path, 'work', e.work, work);
    if (e.index === e.work && e.head !== e.work) {
      // Keep the index as it was: the new edit is unstaged.
    }
    changed.push(next.path);
  }
  if (r.chance(0.4)) {
    const lang = r.weighted(LANG_WEIGHTS);
    let path;
    do path = genPath(r, lang);
    while (rv.files.has(path));
    rv.files.set(path, entry({ path, lang, head: null, index: null, work: join(genLines(lang, r, r.int(20, 120))) }));
    changed.push(`+${path}`);
  }
  if (r.chance(0.25)) {
    const victims = [...rv.files.values()].filter((e) => !e.binary && !e.tooLarge && !e.oldPath && e.head != null && e.work != null);
    if (victims.length) {
      const v = r.pick(victims);
      rv.files.delete(v.path); // reverted: no longer in the diff
      changed.push(`-${v.path}`);
    }
  }
  broadcastDiffChanged(rv);
  return changed;
}

// ------------------------------------------------------------------ seeding

function seedThreads(rv) {
  const files = scopeFiles(rv, 'all').map((e) => ({ e, d: diffOf(e, 'all') }));
  const good = files.filter(({ e, d }) => d.status === 'modified' && d.hunks.length && ['ts', 'tsx', 'py', 'go', 'rs', 'java'].includes(e.lang) && !e.tooLarge);
  const usedPaths = new Set();
  const pickFile = (pred, k = 0) => {
    const list = good.filter((x) => !usedPaths.has(x.e.path) && pred(x));
    const x = list[Math.min(k, list.length - 1)] ?? good.find((y) => !usedPaths.has(y.e.path)) ?? good[0];
    usedPaths.add(x.e.path);
    return x;
  };
  const firstLine = (d, type) => {
    for (const h of d.hunks) for (const l of h.lines) if (l.type === type) return l;
    return d.hunks[0].lines[0];
  };
  const ago = (min) => new Date(Date.now() - min * 60000).toISOString();
  const human = { kind: 'human', name: 'you' };
  const claude = { kind: 'agent', name: 'claude' };
  const codex = { kind: 'agent', name: 'codex' };
  const n = good.length;

  // 1. Human question, agent answer with markdown.
  {
    const { d } = pickFile(() => true, Math.floor(n * 0.1));
    const l = firstLine(d, 'add');
    const t = createThread(rv, 'all', { anchor: { path: d.path, side: 'new', startLine: l.newLine, endLine: l.newLine }, body: 'Why do we fetch this again here? We already loaded it in the parent. Is this a second round-trip on every render?', author: human }, { at: ago(42) });
    addMessage(
      t,
      {
        author: claude,
        body:
          `Not a second round-trip. \`${d.path}:${l.newLine}\` reads from the request cache that the parent filled.\n\n` +
          `Here is the path a request takes:\n\n` +
          `- The loader calls \`loadRecord(id)\` and stores the result.\n- This line calls the same function with the same key.\n- The cache returns the stored value, so no query runs.\n\n` +
          '```ts\nexport function loadRecord(id: string) {\n  return requestCache.getOrSet(id, () => db.records.find(id));\n}\n```\n\n' +
          `See [the cache docs](https://example.com/docs/request-cache) for the lifetime rules. If you prefer, I can pass the value down as a prop instead.`,
      },
      { at: ago(40), silent: true },
    );
  }
  // 2. Resolved thread.
  {
    const { d } = pickFile(() => true, Math.floor(n * 0.25));
    const l = firstLine(d, 'add');
    const t = createThread(rv, 'all', { anchor: { path: d.path, side: 'new', startLine: l.newLine, endLine: l.newLine }, body: 'Nit: this name is confusing next to the other helper. Rename it?', author: human }, { at: ago(35) });
    addMessage(t, { author: claude, body: 'Renamed it and updated the 3 call sites.' }, { at: ago(33), silent: true });
    t.resolved = true;
    recomputeAgentState(t);
  }
  // 3. Note only.
  {
    const { d } = pickFile(() => true, Math.floor(n * 0.4));
    const l = firstLine(d, 'add');
    const t = createThread(rv, 'all', { anchor: { path: d.path, side: 'new', startLine: l.newLine, endLine: l.newLine }, body: 'Note to self: check this against the staging data before merging.', author: human, noteOnly: true }, { at: ago(30) });
    recomputeAgentState(t);
  }
  // 4. Outdated: file is not in the diff.
  {
    const t = createThread(
      rv,
      'all',
      { anchor: { path: 'src/legacy/removed.ts', side: 'new', startLine: 10, endLine: 12 }, body: 'Is this still used anywhere?', author: human },
      { at: ago(300), snippet: ['export function legacyTotal(items: Item[]) {', '  return items.reduce((s, i) => s + i.price, 0);', '}'] },
    );
    addMessage(t, { author: claude, body: 'No. The last caller went away in the billing refactor. I removed the file.' }, { at: ago(298), silent: true });
  }
  // 5. Outdated inside a diff file.
  {
    const { d } = pickFile(() => true, Math.floor(n * 0.55));
    const l = firstLine(d, 'context');
    const t = createThread(
      rv,
      'all',
      { anchor: { path: d.path, side: 'new', startLine: l.newLine, endLine: l.newLine }, body: 'This check looks inverted.', author: human },
      { at: ago(120), outdated: true, snippet: ['  if (user.isActive) return null;'] },
    );
    addMessage(t, { author: claude, body: 'Good catch, it was inverted. Fixed.' }, { at: ago(118), silent: true });
  }
  // 6. Agent-started finding (codex), no human reply.
  {
    const { d } = pickFile(() => true, Math.floor(n * 0.7));
    const l = firstLine(d, 'add');
    createThread(
      rv,
      'all',
      {
        anchor: { path: d.path, side: 'new', startLine: l.newLine, endLine: l.newLine },
        author: codex,
        body: `**Possible race condition.** Two requests can read the same value here before either writes it back, so one update is lost.\n\nSuggested fix: wrap the read and write in one transaction, or use an atomic increment.\n\nSeverity: medium.`,
      },
      { at: ago(15) },
    );
  }
  // 7. Pending thread on a range.
  {
    const { d } = pickFile((x) => x.d.hunks.some((h) => h.newLines >= 5), Math.floor(n * 0.8));
    const h = d.hunks.find((x) => x.newLines >= 5) ?? d.hunks[0];
    const start = h.newStart;
    const end = Math.min(h.newStart + h.newLines - 1, start + 3);
    createThread(rv, 'all', { anchor: { path: d.path, side: 'new', startLine: start, endLine: end }, body: 'Can you explain what this block does, and why it needs to run before the save?', author: human }, { at: ago(5) });
  }
  // 8. Thread on a deleted line (old side).
  {
    const { d } = pickFile((x) => x.d.deletions > 0, Math.floor(n * 0.9));
    const l = firstLine(d, 'del');
    if (l.oldLine) {
      const t = createThread(rv, 'all', { anchor: { path: d.path, side: 'old', startLine: l.oldLine, endLine: l.oldLine }, body: 'Why was this removed?', author: human }, { at: ago(25) });
      addMessage(t, { author: claude, body: 'It duplicated the validation in the caller. Both paths now go through `validateInput`.' }, { at: ago(24), silent: true });
    }
  }
  // 9. Thread created in the 'staged' scope (on index content).
  if (rv.scopes.includes('staged')) {
    const partial = scopeFiles(rv, 'staged')
      .filter((e) => e.index != null && e.index !== e.work && e.head != null && !e.tooLarge && !e.binary && LANGS[e.lang])
      .map((e) => diffOf(e, 'staged'))
      .filter((d) => d.hunks.length);
    const st = partial.find((d) => !usedPaths.has(d.path)) ?? partial[0];
    if (st) {
      const l = firstLine(st, 'add');
      const t = createThread(rv, 'staged', { anchor: { path: st.path, side: 'new', startLine: l.newLine, endLine: l.newLine }, body: 'Staged this part on purpose. Is it safe to commit without the unstaged follow-up?', author: human }, { at: ago(10) });
      addMessage(t, { author: claude, body: 'Yes. The staged change stands alone; the unstaged edit only adds logging.' }, { at: ago(9), silent: true });
    }
  }
}

// ------------------------------------------------------------------ HTTP helpers

function send(res, status, body) {
  if (res.writableEnded) return;
  const s = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(s), 'Cache-Control': 'no-store' });
  res.end(s);
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > 10e6) throw new HttpError(413, 'body too large');
    chunks.push(c);
  }
  const s = Buffer.concat(chunks).toString('utf8');
  if (!s.trim()) return {};
  try {
    return JSON.parse(s);
  } catch {
    throw new HttpError(400, 'invalid JSON body');
  }
}

const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);

function validAuthor(a) {
  if (!isObj(a) || (a.kind !== 'human' && a.kind !== 'agent') || typeof a.name !== 'string' || !a.name) throw new HttpError(400, 'author must be { kind: "human" | "agent", name }');
  return a;
}
function validBody(b) {
  if (typeof b !== 'string' || !b.trim()) throw new HttpError(400, 'body must be a non-empty string');
  return b;
}

// ------------------------------------------------------------------ routes

async function route(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;
  const q = url.searchParams;
  const M = req.method;
  let m;

  if (p === '/api/health') {
    if (M !== 'GET') throw new HttpError(405, 'method not allowed');
    return send(res, 200, { ok: true, name: 'margin', version: VERSION, repo: REPO, pid: process.pid });
  }

  if (p === '/api/reviews') {
    if (M === 'GET') return send(res, 200, [...reviews.values()].map(summary));
    if (M === 'POST') {
      const body = await readJson(req);
      const spec = body.spec;
      if (!isObj(spec)) throw new HttpError(400, 'spec is required');
      const valid =
        spec.kind === 'working' ||
        (spec.kind === 'branch' && typeof spec.base === 'string' && typeof spec.head === 'string') ||
        (spec.kind === 'commit' && typeof spec.rev === 'string') ||
        (spec.kind === 'range' && typeof spec.from === 'string' && typeof spec.to === 'string');
      if (!valid) throw new HttpError(400, 'invalid spec');
      const rv = reviews.get(reviewIdFor(spec)) ?? makeReview(spec);
      return send(res, 200, summary(rv));
    }
    throw new HttpError(405, 'method not allowed');
  }

  if ((m = p.match(/^\/api\/reviews\/([^/]+)$/))) {
    if (M !== 'GET') throw new HttpError(405, 'method not allowed');
    const rv = getReview(decodeURIComponent(m[1]));
    return send(res, 200, reviewView(rv, scopeParam(rv, q)));
  }

  if ((m = p.match(/^\/api\/reviews\/([^/]+)\/file$/))) {
    if (M !== 'GET') throw new HttpError(405, 'method not allowed');
    const rv = getReview(decodeURIComponent(m[1]));
    const scope = scopeParam(rv, q);
    const path = q.get('path');
    const side = q.get('side');
    if (!path) throw new HttpError(400, 'path is required');
    if (side !== 'old' && side !== 'new') throw new HttpError(400, 'side must be old or new');
    const e = findEntry(rv, path);
    if (!e) throw new HttpError(404, `file not in review: ${path}`);
    const text = e[SIDES[scope][side]];
    return send(res, 200, { path, side, exists: text != null, binary: e.binary, text: text == null || e.binary ? '' : text });
  }

  if ((m = p.match(/^\/api\/reviews\/([^/]+)\/since-viewed$/))) {
    if (M !== 'GET') throw new HttpError(405, 'method not allowed');
    const rv = getReview(decodeURIComponent(m[1]));
    const scope = scopeParam(rv, q);
    const path = q.get('path');
    if (!path) throw new HttpError(400, 'path is required');
    const v = rv.viewed[scope].get(path);
    const e = findEntry(rv, path);
    if (!v || !e || e.binary) return send(res, 200, { path, file: null });
    const cur = e[SIDES[scope].new];
    if ((cur ?? '') === (v.snapshot ?? '')) return send(res, 200, { path, file: null });
    const d = diffTexts(v.snapshot, cur);
    const status = v.snapshot == null ? 'added' : cur == null ? 'deleted' : 'modified';
    const file = {
      path,
      status,
      binary: false,
      additions: d.additions,
      deletions: d.deletions,
      hunks: d.hunks,
      tooLarge: false,
      fingerprint: hunksFingerprint(`since|${path}|`, d.hunks),
      viewed: false,
      changedSinceViewed: false,
      oldLineCount: v.snapshot == null ? 0 : d.oldCount,
      newLineCount: cur == null ? 0 : d.newCount,
    };
    return send(res, 200, { path, file });
  }

  if ((m = p.match(/^\/api\/reviews\/([^/]+)\/viewed$/))) {
    if (M !== 'PUT') throw new HttpError(405, 'method not allowed');
    const rv = getReview(decodeURIComponent(m[1]));
    const scope = scopeParam(rv, q);
    const body = await readJson(req);
    if (typeof body.path !== 'string' || typeof body.viewed !== 'boolean') throw new HttpError(400, 'path and viewed are required');
    const e = findEntry(rv, body.path);
    if (!e || !inScopeEntry(e, scope)) throw new HttpError(404, `file not in diff: ${body.path}`);
    if (body.viewed) rv.viewed[scope].set(body.path, { fingerprint: diffOf(e, scope).fingerprint, snapshot: e[SIDES[scope].new] });
    else rv.viewed[scope].delete(body.path);
    broadcast(rv.id, { type: 'viewed', path: body.path, viewed: body.viewed }, scope);
    return send(res, 200, { ok: true });
  }

  if ((m = p.match(/^\/api\/reviews\/([^/]+)\/threads$/))) {
    if (M !== 'POST') throw new HttpError(405, 'method not allowed');
    const rv = getReview(decodeURIComponent(m[1]));
    const scope = scopeParam(rv, q);
    const body = await readJson(req);
    const a = body.anchor;
    if (!isObj(a) || typeof a.path !== 'string' || (a.side !== 'old' && a.side !== 'new')) throw new HttpError(400, 'anchor must be { path, side, startLine, endLine }');
    const fileLevel = a.startLine == null && a.endLine == null;
    if (!fileLevel && !(Number.isInteger(a.startLine) && Number.isInteger(a.endLine) && a.startLine >= 1 && a.endLine >= a.startLine))
      throw new HttpError(400, 'startLine/endLine must be both null or integers with 1 <= startLine <= endLine');
    const e = findEntry(rv, a.path);
    if (!e || !inScopeEntry(e, scope)) throw new HttpError(404, `file not in diff: ${a.path}`);
    const text = e[SIDES[scope][a.side]];
    if (!fileLevel && (text == null || a.endLine > splitText(text).lines.length)) throw new HttpError(400, 'anchor lines are outside the file');
    validBody(body.body);
    const author = validAuthor(body.author);
    const t = createThread(rv, scope, { anchor: { path: a.path, side: a.side, startLine: fileLevel ? null : a.startLine, endLine: fileLevel ? null : a.endLine }, body: body.body, author, noteOnly: !!body.noteOnly });
    recomputeAgentState(t);
    touch(rv);
    broadcastThread(t);
    afterHumanMessage(t, author);
    return send(res, 200, threadView(t, scope));
  }

  if ((m = p.match(/^\/api\/reviews\/([^/]+)\/events$/))) {
    if (M !== 'GET') throw new HttpError(405, 'method not allowed');
    const rv = getReview(decodeURIComponent(m[1]));
    const scope = scopeParam(rv, q);
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.write(': connected\n\n');
    const c = { res, scope };
    if (!sseClients.has(rv.id)) sseClients.set(rv.id, new Set());
    sseClients.get(rv.id).add(c);
    req.on('close', () => sseClients.get(rv.id)?.delete(c));
    return;
  }

  if ((m = p.match(/^\/api\/threads\/(\d+)$/))) {
    const t = getThread(m[1]);
    const scope = q.get('scope') && SCOPES.includes(q.get('scope')) ? q.get('scope') : 'all';
    if (M === 'GET') return send(res, 200, threadView(t, scope));
    if (M === 'PATCH') {
      const body = await readJson(req);
      if (body.resolved !== undefined && typeof body.resolved !== 'boolean') throw new HttpError(400, 'resolved must be boolean');
      if (body.noteOnly !== undefined && typeof body.noteOnly !== 'boolean') throw new HttpError(400, 'noteOnly must be boolean');
      if (body.resolved !== undefined) t.resolved = body.resolved;
      if (body.noteOnly !== undefined) t.noteOnly = body.noteOnly;
      const wasWorking = t.agentState === 'working' ? t.claimedBy : null;
      if (t.resolved || t.noteOnly) cancelSim(t.id);
      if (t.resolved || t.noteOnly || t.agentState !== 'working') {
        if (t.agentState === 'working' && (t.resolved || t.noteOnly)) t.agentState = 'idle';
        recomputeAgentState(t);
      }
      if (wasWorking && t.agentState !== 'working' && !holdsThreads(wasWorking) && presence.some((x) => x.name === wasWorking)) setPresence(wasWorking, 'waiting');
      t.updatedAt = nowIso();
      touch(reviews.get(t.reviewId));
      broadcastThread(t);
      if (t.agentState === 'pending') {
        setImmediate(serviceWaiters);
        scheduleSimAgent(t.id);
      }
      return send(res, 200, threadView(t, scope));
    }
    if (M === 'DELETE') {
      deleteThread(t);
      return send(res, 200, { ok: true });
    }
    throw new HttpError(405, 'method not allowed');
  }

  if ((m = p.match(/^\/api\/threads\/(\d+)\/messages$/))) {
    if (M !== 'POST') throw new HttpError(405, 'method not allowed');
    const t = getThread(m[1]);
    const body = await readJson(req);
    validBody(body.body);
    const author = validAuthor(body.author);
    if (body.resolve) cancelSim(t.id);
    addMessage(t, { body: body.body, author }, { silent: true });
    if (body.resolve) {
      t.resolved = true;
      recomputeAgentState(t);
    }
    touch(reviews.get(t.reviewId));
    broadcastThread(t);
    afterHumanMessage(t, author);
    return send(res, 200, threadView(t, 'all'));
  }

  if ((m = p.match(/^\/api\/messages\/(\d+)$/))) {
    const mid = Number(m[1]);
    const tid = messageThread.get(mid);
    if (tid === undefined) throw new HttpError(404, `message not found: ${mid}`);
    const t = getThread(tid);
    const i = t.messages.findIndex((x) => x.id === mid);
    if (M === 'PATCH') {
      const body = await readJson(req);
      validBody(body.body);
      t.messages[i].body = body.body;
      t.messages[i].editedAt = nowIso();
      t.updatedAt = t.messages[i].editedAt;
      broadcastThread(t);
      return send(res, 200, threadView(t, 'all'));
    }
    if (M === 'DELETE') {
      t.messages.splice(i, 1);
      messageThread.delete(mid);
      if (!t.messages.length) {
        deleteThread(t);
        return send(res, 200, { ok: true, threadDeleted: true });
      }
      if (t.agentState !== 'working') recomputeAgentState(t);
      t.updatedAt = nowIso();
      broadcastThread(t);
      return send(res, 200, threadView(t, 'all'));
    }
    throw new HttpError(405, 'method not allowed');
  }

  // ---- agent

  if (p === '/api/agent/wait') {
    if (M !== 'GET') throw new HttpError(405, 'method not allowed');
    const agent = q.get('agent');
    if (!agent) throw new HttpError(400, 'agent is required');
    const timeout = Math.min(Math.max(Number(q.get('timeout') ?? 30) || 0, 0), 600);
    const reviewId = q.get('review') || null;
    if (reviewId) getReview(reviewId);
    const claimed = claimPending(agent, reviewId);
    if (claimed.length) {
      setPresence(agent, 'working');
      return send(res, 200, { threads: claimed.map(agentThread), timedOut: false });
    }
    if (!holdsThreads(agent)) setPresence(agent, 'waiting');
    const w = { agent, reviewId, res, timer: null };
    w.timer = setTimeout(() => {
      const i = waiters.indexOf(w);
      if (i >= 0) waiters.splice(i, 1);
      send(res, 200, { threads: [], timedOut: true });
    }, timeout * 1000);
    waiters.push(w);
    res.on('close', () => {
      clearTimeout(w.timer);
      const i = waiters.indexOf(w);
      if (i >= 0) waiters.splice(i, 1);
    });
    return;
  }

  if (p === '/api/agent/threads') {
    if (M !== 'GET') throw new HttpError(405, 'method not allowed');
    const reviewId = q.get('review') || null;
    const state = q.get('state') || 'open';
    if (!['open', 'pending', 'all'].includes(state)) throw new HttpError(400, 'state must be open, pending or all');
    const list = [...threads.values()]
      .filter((t) => (!reviewId || t.reviewId === reviewId) && !t.noteOnly)
      .filter((t) => state === 'all' || (state === 'open' ? !t.resolved : !t.resolved && t.agentState === 'pending'))
      .sort((a, b) => a.id - b.id);
    return send(res, 200, list.map(agentThread));
  }

  if ((m = p.match(/^\/api\/agent\/threads\/(\d+)$/))) {
    if (M !== 'GET') throw new HttpError(405, 'method not allowed');
    const t = getThread(m[1]);
    if (t.noteOnly) throw new HttpError(404, `thread not found: ${m[1]}`);
    return send(res, 200, agentThread(t));
  }

  if (p === '/api/agent/release') {
    if (M !== 'POST') throw new HttpError(405, 'method not allowed');
    const body = await readJson(req);
    if (typeof body.agent !== 'string' || !body.agent) throw new HttpError(400, 'agent is required');
    for (const t of threads.values()) {
      if (t.claimedBy !== body.agent || t.agentState !== 'working') continue;
      t.agentState = 'pending';
      t.claimedBy = null;
      t.updatedAt = nowIso();
      broadcastThread(t);
    }
    if (presence.some((x) => x.name === body.agent)) {
      presence = presence.filter((x) => x.name !== body.agent);
      broadcastAgents();
    }
    setImmediate(serviceWaiters);
    return send(res, 200, { ok: true });
  }

  // ---- mock controls

  if (p.startsWith('/__mock/')) {
    if (M !== 'POST') throw new HttpError(405, 'mock endpoints use POST');
    const rv = getReview(q.get('review') || 'working');
    const what = p.slice('/__mock/'.length);
    if (what === 'change') return send(res, 200, { ok: true, changed: simulateChange(rv), diffFingerprint: diffFingerprint(rv, 'all') });
    if (what === 'agent-reply') {
      const t = getThread(q.get('thread'));
      agentReply(t, SIM);
      return send(res, 200, threadView(t, 'all'));
    }
    if (what === 'agents') {
      const body = await readJson(req);
      if (!Array.isArray(body) || !body.every((x) => isObj(x) && typeof x.name === 'string' && (x.state === 'waiting' || x.state === 'working')))
        throw new HttpError(400, 'body must be AgentPresence[]');
      presence = body.map((x) => ({ name: x.name, state: x.state, since: x.since ?? nowIso() }));
      broadcastAgents();
      return send(res, 200, { ok: true, agents: presence });
    }
    if (what === 'clear') {
      if (!rv.savedFiles) rv.savedFiles = rv.files;
      rv.files = new Map();
      broadcastDiffChanged(rv);
      return send(res, 200, { ok: true });
    }
    if (what === 'restore') {
      if (rv.savedFiles) {
        rv.files = rv.savedFiles;
        rv.savedFiles = null;
      }
      broadcastDiffChanged(rv);
      return send(res, 200, { ok: true });
    }
    throw new HttpError(404, `unknown mock endpoint: ${what}`);
  }

  throw new HttpError(404, `not found: ${M} ${p}`);
}

// ------------------------------------------------------------------ start

const t0 = performance.now();
baseEntries = buildFixture(OPTS.seed, OPTS.files, OPTS.small);
const working = makeReview({ kind: 'working' });
for (const s of SCOPES) for (const e of scopeFiles(working, s)) diffOf(e, s);
seedThreads(working);
presence = OPTS.agent ? [{ name: SIM, state: 'waiting', since: nowIso() }] : [];
const genMs = Math.round(performance.now() - t0);

setInterval(() => {
  for (const set of sseClients.values()) for (const c of set) c.res.write(': ping\n\n');
}, 15000).unref();

if (OPTS.changeEvery > 0) setInterval(() => simulateChange(working), OPTS.changeEvery * 1000).unref();

const server = http.createServer((req, res) => {
  route(req, res).catch((err) => {
    if (!(err instanceof HttpError)) console.error(err);
    if (res.headersSent) return res.end();
    send(res, err instanceof HttpError ? err.status : 500, { error: err.message || String(err) });
  });
});
server.listen(OPTS.port, '127.0.0.1', () => {
  const counts = SCOPES.map((s) => `${s}=${scopeFiles(working, s).length}`).join(' ');
  console.log(`margin mock server: http://127.0.0.1:${OPTS.port}  (files ${counts}, threads ${threads.size}, generated in ${genMs}ms${OPTS.agent ? '' : ', simulated agent off'})`);
});
