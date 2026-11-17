import { renderOriginal } from '../server/context.ts';
import type { AgentThread, DiffFile, Review, ReviewBatch, ReviewMode, ReviewSpec, Thread, WaitResponse } from '../shared/types.ts';

/** What the agent must do for each mode. Plain imperative text: agents follow it literally. */
export const MODE_INSTRUCTIONS: Record<ReviewMode, string> = {
  ask: 'Answer; change code only if the comment asks for it.',
  discuss:
    'Answer and discuss only. Do not change any code or files, even if a comment asks for a change; describe the change you would make instead.',
  implement:
    'Change the code to address every comment. Then reply in each thread with what you changed (files and lines). If a comment is a question, answer it. If you disagree with a request or it is ambiguous, do not guess: say so in the thread and leave that code unchanged. You do not have to make all the changes before you reply, but reply to every thread before you wait again.',
};

/** One line per thread block: the mode it must be handled in. */
function modeLine(t: Thread, batchId: number | null): string {
  switch (t.mode) {
    case 'ask':
      return `Mode: ASK (one-off comment). ${MODE_INSTRUCTIONS.ask}`;
    case 'discuss':
      return `Mode: DISCUSS${batchId ? ` (review #${batchId})` : ''}. Do not change any code or files; describe the change instead.`;
    case 'implement':
      return `Mode: IMPLEMENT${batchId ? ` (review #${batchId})` : ''}. Change the code, then reply with what you changed.`;
  }
}

const RULE = '='.repeat(72);

/** The header printed before the threads of one submitted review. */
export function formatBatchHeader(b: ReviewBatch, count: number): string {
  const out = [RULE, `# REVIEW #${b.id} · ${b.mode.toUpperCase()} · ${count} thread${count === 1 ? '' : 's'}`];
  out.push(`Submitted ${b.submittedAt} by the human reviewer. Threads: ${b.threadIds.map((id) => `#${id}`).join(', ')}`);
  if (b.body.trim()) {
    out.push('', 'Overall note from the reviewer:');
    out.push(...b.body.trimEnd().split('\n').map((l) => `> ${l}`));
  }
  out.push('', `INSTRUCTION (${b.mode.toUpperCase()}): ${MODE_INSTRUCTIONS[b.mode]}`, RULE);
  return out.join('\n');
}

/** The header printed before one-off threads in a wait response. */
export function formatOneOffHeader(count: number): string {
  return [RULE, `# ONE-OFF COMMENTS · ${count} thread${count === 1 ? '' : 's'} (not part of a review)`, `INSTRUCTION (ASK): ${MODE_INSTRUCTIONS.ask}`, RULE].join('\n');
}

export function specText(spec: ReviewSpec): string {
  switch (spec.kind) {
    case 'working':
      return 'uncommitted changes (HEAD -> working tree)';
    case 'branch':
      return `branch ${spec.head} against ${spec.base} (merge-base -> ${spec.head}, including uncommitted changes when ${spec.head} is checked out)`;
    case 'commit':
      return `commit ${spec.rev}`;
    case 'range':
      return `range ${spec.from}..${spec.to}`;
  }
}

/** A fence that does not collide with backticks inside the text. */
function fence(text: string, lang = ''): string {
  let ticks = '```';
  while (text.includes(ticks)) ticks += '`';
  return `${ticks}${lang}\n${text}\n${ticks}`;
}

export function location(t: Thread): string {
  const a = t.anchor;
  if (a.startLine === null) return `${a.path} (whole file)`;
  const lines = a.endLine !== null && a.endLine !== a.startLine ? `${a.startLine}-${a.endLine}` : `${a.startLine}`;
  return `${a.path}:${lines} (${a.side} side)`;
}

function author(t: Thread['messages'][number]): string {
  return t.author.kind === 'human' ? `${t.author.name} (human reviewer)` : `${t.author.name} (agent)`;
}

export function formatAgentThread(at: AgentThread, agentName: string, opts: { replyHint: boolean; argStyle?: boolean }): string {
  const t = at.thread;
  const out: string[] = [];
  const flags = [t.resolved ? 'resolved' : 'open', `agent state: ${t.agentState}${t.claimedBy ? ` (${t.claimedBy})` : ''}`];
  if (t.outdated)
    flags.push(t.outdatedReason === 'file-gone' ? 'OUTDATED: the file is no longer in this diff' : 'OUTDATED: the commented code changed since the thread started');
  if (t.noteOnly) flags.push('private note');
  out.push(`## Thread #${t.id} · ${location(t)}`);
  out.push(`Review: ${at.review.title} [${at.review.id}] · ${flags.join(' · ')}`);
  out.push(modeLine(t, at.batchId ?? null));
  out.push(`Repo: ${at.repoRoot}`);
  out.push('');
  const orig = t.original;
  if (at.diffContext) {
    out.push('Code (">" marks the commented lines; columns: old line, new line):');
    out.push(fence(at.diffContext, 'diff'));
  }
  if (t.outdated && orig && orig.lines.length) {
    const where = [orig.head ? `commit ${orig.head.slice(0, 7)}` : null, orig.branch ? `branch ${orig.branch}` : null].filter(Boolean).join(', ');
    out.push(`Original code when the thread started${where ? ` (${where})` : ''}. It has changed since: read the current file before you answer.`);
    out.push('(">" marks the commented lines; columns: old line, new line)');
    out.push(fence(renderOriginal(orig.lines) + (orig.truncated ? '\n  ... (anchor cut) ...' : ''), 'diff'));
  } else if (!at.diffContext && t.snippet.length) {
    out.push('Commented lines as they were when the thread started:');
    out.push(fence(t.snippet.join('\n')));
  }
  out.push('');
  out.push('Conversation:');
  for (const m of t.messages) {
    out.push('');
    out.push(`--- ${author(m)}${m.editedAt ? ' (edited)' : ''} · message ${m.id} ---`);
    out.push(m.body.trimEnd());
  }
  out.push('--- end of conversation ---');
  if (opts.replyHint && !t.resolved && opts.argStyle) {
    out.push('');
    out.push(`Reply: margin reply ${t.id} --as ${agentName} -m '<your answer in markdown>'`);
    out.push("(one plain command, no heredoc or pipe; the text must not contain ' : write ’ instead)");
  } else if (opts.replyHint && !t.resolved) {
    out.push('');
    out.push(`Reply: margin reply ${t.id} --as ${agentName} <<'MARGIN_EOF'`);
    out.push('<your answer in markdown>');
    out.push('MARGIN_EOF');
  }
  return out.join('\n');
}

export function formatThreadLine(at: AgentThread): string {
  const t = at.thread;
  const last = t.messages[t.messages.length - 1];
  const preview = last ? `${last.author.name}: ${last.body.replace(/\s+/g, ' ').slice(0, 90)}` : '';
  const state = t.resolved ? 'resolved' : t.agentState;
  return `#${t.id} [${state}, ${t.mode}${t.outdated ? ', outdated' : ''}] ${location(t)} · ${at.review.id} · ${preview}`;
}

/** Renders one file as unified diff text. */
export function fileToUnified(f: DiffFile): string {
  const a = f.oldPath ?? f.path;
  const out = [`diff --git a/${a} b/${f.path}`];
  if (f.status === 'renamed') out.push(`rename from ${a}`, `rename to ${f.path}`);
  if (f.status === 'added') out.push('new file');
  if (f.status === 'deleted') out.push('deleted file');
  if (f.binary) {
    out.push('Binary file changed');
    return out.join('\n');
  }
  if (f.tooLarge) {
    out.push(`(diff too large to show: +${f.additions} -${f.deletions})`);
    return out.join('\n');
  }
  if (!f.hunks.length) return out.join('\n');
  out.push(`--- ${f.status === 'added' ? '/dev/null' : `a/${a}`}`);
  out.push(`+++ ${f.status === 'deleted' ? '/dev/null' : `b/${f.path}`}`);
  for (const h of f.hunks) {
    out.push(`@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@${h.section ? ' ' + h.section : ''}`);
    for (const l of h.lines) out.push(`${l.type === 'add' ? '+' : l.type === 'del' ? '-' : ' '}${l.text}`);
  }
  return out.join('\n');
}

/** The header of `margin diff`, plus the file list with --stat. The patch itself is streamed after it. */
export function formatDiff(r: Review, stat: boolean): string {
  const out: string[] = [];
  out.push(`# Review ${r.id}: ${r.title}`);
  out.push(`Compares: ${specText(r.spec)}${r.scopes.length > 1 ? ` · scope: ${r.scope}` : ''}`);
  out.push(`From ${r.resolved.from.slice(0, 12)} to ${r.resolved.to ? r.resolved.to.slice(0, 12) : 'the working tree'} · ${r.files.length} files`);
  const open = r.threads.filter((t) => !t.resolved).length;
  if (r.threads.length) out.push(`Threads: ${r.threads.length} (${open} open). List them with \`margin threads\`.`);
  out.push('');
  if (stat) {
    let add = 0;
    let del = 0;
    for (const f of r.files) {
      add += f.additions;
      del += f.deletions;
      const name = f.oldPath ? `${f.oldPath} => ${f.path}` : f.path;
      out.push(`${f.status.padEnd(8)} ${name} | ${f.binary ? 'binary' : `+${f.additions} -${f.deletions}`}`);
    }
    out.push(`${r.files.length} files changed, +${add} -${del}`);
    return out.join('\n');
  }
  return out.join('\n');
}

/** A wait response: each submitted review under its own header, then one-off threads. */
export function formatWait(r: WaitResponse, agentName: string, argStyle: boolean, next: 'wait' | 'inbox' = 'wait'): string {
  const n = r.threads.length;
  const then =
    next === 'inbox'
      ? 'Handle and answer each one with `margin reply <id>`. Then run `margin inbox` once more; when it prints "No feedback is waiting.", stop and summarize for the user.'
      : 'Answer each one with `margin reply <id>`, then run `margin wait` again.';
  const parts = [`# ${n} thread${n > 1 ? 's' : ''} for you (${agentName})\n${then}`];
  const block = (at: AgentThread) => formatAgentThread(at, agentName, { replyHint: true, argStyle });
  const batches = new Map(r.batches.map((b) => [b.id, b]));
  const grouped = new Map<number, AgentThread[]>();
  const oneOff: AgentThread[] = [];
  for (const at of r.threads) {
    const b = at.batchId ?? null;
    if (b !== null && batches.has(b)) {
      if (!grouped.has(b)) grouped.set(b, []);
      grouped.get(b)!.push(at);
    } else oneOff.push(at);
  }
  for (const [id, list] of grouped) parts.push(formatBatchHeader(batches.get(id)!, list.length), ...list.map(block));
  if (oneOff.length) {
    if (grouped.size) parts.push(formatOneOffHeader(oneOff.length));
    parts.push(...oneOff.map(block));
  }
  return parts.join('\n\n');
}
