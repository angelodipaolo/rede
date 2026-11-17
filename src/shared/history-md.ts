/**
 * Review history as readable Markdown. Pure (no Node or DOM APIs): the CLI (`rede export`) and
 * the web UI ("Copy as Markdown") both use it.
 */
import type { HistoryEntry, OriginalLine, Thread } from './types.ts';

/** Code lines in the layout agents also get: ">" marks anchored lines, then old and new line numbers. */
export function renderOriginal(lines: OriginalLine[]): string {
  const width = String(Math.max(1, ...lines.map((l) => Math.max(l.oldLine ?? 0, l.newLine ?? 0)))).length;
  const pad = (n: number | undefined) => (n === undefined ? ''.padStart(width) : String(n).padStart(width));
  return lines
    .map((l) => `${l.anchored ? '>' : ' '} ${pad(l.oldLine)} ${pad(l.newLine)} ${l.type === 'add' ? '+' : l.type === 'del' ? '-' : ' '}${l.text}`)
    .join('\n');
}

/** A code fence that does not collide with backticks inside the text. */
function fence(text: string, lang = ''): string {
  let ticks = '```';
  while (text.includes(ticks)) ticks += '`';
  return `${ticks}${lang}\n${text}\n${ticks}`;
}

const MODE = { ask: 'Ask', discuss: 'Discuss', implement: 'Implement' } as const;

/** "2026-11-16 14:05" in UTC, so an export reads the same everywhere. */
export function stamp(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  return new Date(t).toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
}

export function threadLocation(t: Thread): string {
  const a = t.anchor;
  if (a.startLine === null) return `${a.path} (whole file)`;
  const lines = a.endLine !== null && a.endLine !== a.startLine ? `${a.startLine}-${a.endLine}` : `${a.startLine}`;
  return `${a.path}:${lines}`;
}

export function threadStates(t: Thread): string[] {
  const s = [t.resolved ? 'resolved' : 'open'];
  if (t.outdated) s.push(t.outdatedReason === 'file-gone' ? 'outdated: file no longer in the diff' : 'outdated: code changed');
  if (t.noteOnly) s.push('private note');
  if (!t.resolved && t.agentState === 'pending') s.push('waiting for an agent');
  return s;
}

function threadMarkdown(t: Thread, level: string): string[] {
  const out = [`${level} Thread #${t.id} · ${threadLocation(t)} · ${threadStates(t).join(' · ')}`, ''];
  const o = t.original;
  if (o && o.lines.length) {
    const where = [o.branch ? `branch ${o.branch}` : null, o.head ? o.head.slice(0, 7) : null].filter(Boolean).join(' · ');
    out.push(`Code when the thread started${where ? ` (${where})` : ''}:`, '', fence(renderOriginal(o.lines) + (o.truncated ? '\n  …' : ''), 'diff'), '');
  } else if (t.snippet.length) {
    out.push('Commented lines when the thread started:', '', fence(t.snippet.join('\n')), '');
  }
  for (const m of t.messages) {
    const who = m.author.kind === 'human' ? `**${m.author.name === 'you' ? 'You' : m.author.name}** (reviewer)` : `**${m.author.name}** (agent)`;
    out.push(`${who} · ${stamp(m.createdAt)}${m.pending ? ' · pending, not sent yet' : ''}${m.editedAt ? ' · edited' : ''}`, '');
    out.push(m.body.trimEnd(), '');
  }
  return out;
}

/** One history entry (a submitted review or a one-off thread) as Markdown. */
export function entryMarkdown(e: HistoryEntry): string {
  const out: string[] = [];
  if (e.kind === 'batch') {
    const b = e.batch;
    out.push(`## Review #${b.id} · ${MODE[b.mode]} · ${stamp(b.submittedAt)}`, '');
    const where = [`Review: ${e.review.title}`, b.branch ? `branch ${b.branch}` : null, b.head ? b.head.slice(0, 7) : null].filter(Boolean).join(' · ');
    out.push(where, '');
    out.push(`${e.counts.threads} thread${e.counts.threads === 1 ? '' : 's'} · ${e.counts.answered} answered · ${e.counts.resolved} resolved`, '');
    if (b.body.trim()) out.push(...b.body.trimEnd().split('\n').map((l) => `> ${l}`), '');
    for (const t of e.threads) out.push(...threadMarkdown(t, '###'));
  } else {
    const t = e.thread;
    out.push(`## ${t.noteOnly ? 'Note' : 'Comment'} · ${stamp(e.at)}`, '', `Review: ${e.review.title}`, '');
    out.push(...threadMarkdown(t, '###'));
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
}

/** A whole export. Entries are printed oldest first, so the file reads as a timeline. */
export function historyMarkdown(entries: HistoryEntry[], opts: { repo: string; exportedAt: string; filter?: string }): string {
  const batches = entries.filter((e) => e.kind === 'batch').length;
  const head = [
    `# Rede review history · ${opts.repo}`,
    '',
    `Exported ${stamp(opts.exportedAt)} · ${batches} review${batches === 1 ? '' : 's'} · ${entries.length - batches} one-off thread${entries.length - batches === 1 ? '' : 's'}${opts.filter ? ` · ${opts.filter}` : ''}`,
    '',
  ];
  const body = [...entries].reverse().map(entryMarkdown);
  return [...head, ...body].join('\n').replace(/\n{3,}/g, '\n\n');
}
