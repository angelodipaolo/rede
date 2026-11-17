import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const GUIDE = `# Margin: answer code review feedback

Margin is a local code review tool. A human reviews a git diff in the browser
and leaves comment threads on lines. You answer in those threads. You talk to
Margin only through the \`margin\` command. Run it from inside the repository.
It starts its local server (127.0.0.1) when needed.

Pick the way to work from what the user asked:

- ONE PASS (the default). The user says "address the margin feedback", "read
  the review", "answer my margin comments" or similar. Handle what is waiting
  now, then stop.
- WATCH. Only when the user explicitly asks you to watch Margin, wait for
  comments, stay connected, or answer comments live.

## One pass (default)

1. Run \`margin inbox\`. It prints all feedback that waits for you and never
   blocks: each submitted review (mode, the reviewer's note), then its threads
   with the file, lines, diff context and conversation. If it prints "No
   feedback is waiting.", tell the user that and stop.
2. Handle every thread as its mode says (see "Modes"). Read the code first.
3. Reply in every thread you received (see "Replying").
4. Run \`margin inbox\` once more for feedback that arrived meanwhile. Handle it
   the same way. When it prints "No feedback is waiting.", stop.
5. Give the user a short summary in the chat: what you answered, what you
   changed (files), and what is still open or where you disagreed.

In one pass, do not run \`margin wait\` and do not loop.

## Watch (only when asked)

1. Run \`margin wait\`. It blocks until the human writes a comment for you and
   uses no tokens while it waits.
2. Handle and reply to every thread it printed, as in one pass.
3. Run \`margin wait\` again. When it prints "No new comments", run it again at
   once. Stop when the user tells you to stop.

In Claude Code: run \`margin wait --timeout 540\` with the Bash tool timeout set
to 600000 ms. Do not poll with sleep, and do not run it in the background.
In Codex: run \`margin wait\` (it returns after 100 seconds without comments),
then run it again.

## Replying

\`margin reply <id>\` with your answer on stdin:

    margin reply 12 <<'MARGIN_EOF'
    Your answer in markdown. Backticks and \`code\` are fine here.
    MARGIN_EOF

Reply to every thread you received. Never resolve a thread unless the human
asks you to; the human resolves threads.

## Codex

Margin needs its server on 127.0.0.1 and writes .git/margin; the Codex sandbox
blocks both. \`margin setup\` installs a Codex rule that runs margin commands
outside the sandbox without a prompt. The rule matches only a plain command:
- Run \`margin ...\` by name and alone: no pipe, \`&&\`, redirection, heredoc or
  VAR= prefix.
- Give the reply with -m in single quotes, not on stdin:

      margin reply 12 -m 'Your answer in markdown. It’s fine to use \`code\`.'

  The text must not contain a straight ' (an escape like '\\'' breaks the
  match): write ’ instead.
- If margin says the sandbox blocked it, do what its "Fix:" line says. If the
  rule is missing or older than this Margin, rerun the command with escalated
  permissions, and ask the user to run \`margin setup\` in a terminal and start
  a new Codex session.

## Modes

Every thread shows a "Mode:" line. Follow it exactly.

- ASK: a one-off comment. Answer it. Change code only if the comment asks for
  a change; then reply with what you changed.
- DISCUSS: part of a submitted review. Answer and discuss only. Do not change
  any code or files, even if a comment asks for a change; describe the change
  you would make instead.
- IMPLEMENT: part of a submitted review. Change the code to address every
  comment, then reply in each thread with what you changed (files and lines).
  Answer questions. If a request is ambiguous or you disagree, say so in the
  thread and leave that code unchanged.

## How to answer

- Answer the question. Be specific and short. Cite code as \`path:line\`.
- Say what you checked. If you are not sure, say so and say how to find out.
- A thread marked OUTDATED: the code it was on changed. It shows the original
  code; read the current code before you answer.

## Review findings

When the human asks you to review the diff:

1. \`margin diff\` prints the exact diff the human sees (\`--stat\` for a summary).
2. For each real problem, start a thread on the line:

       margin comment src/app.ts:42-45 <<'MARGIN_EOF'
       **Bug:** \`user\` can be null here when ... Suggest: ...
       MARGIN_EOF

   Use \`--old\` to comment on a deleted line (old side). \`margin comment <path>\`
   without a line starts a file-level thread. Only files in the diff accept
   comments. Report real issues (bugs, risks, missing cases), not style nits,
   unless asked. In Codex, use -m as above.
3. Then stop and tell the user how many threads you left (in watch mode, go
   back to \`margin wait\`).

## Other commands

- \`margin threads\` lists open threads (\`--pending\` for unanswered, \`--all\`
  also lists resolved and old ones).
- \`margin show <id>\` prints one thread with its context, and the original code
  of an outdated thread.
- \`margin release\` gives back threads you received but will not answer.
- Add \`--as <name>\` to set your name, \`--review <id>\` to pick a review,
  \`--json\` for raw JSON.
`;

const DESCRIPTION =
  'Answer code review feedback in Margin, the local diff review tool. Use when the user says "address margin feedback", "address the review", "read the review", "answer my margin comments", "watch margin", or asks you to connect to Margin, run `margin inbox` or `margin wait`, or leave review findings on a diff as Margin threads.';

/**
 * The installed skill only points at `margin guide`, so it never goes stale when Margin changes:
 * the guide always comes from the installed margin build.
 */
export const SKILL_BODY = `# Margin

Run \`margin guide\` first and follow what it prints. It is the current guide
for the installed Margin version: how to read the feedback, how to reply, and
what each mode (ask, discuss, implement) allows you to do.

By default, handle the waiting feedback once (\`margin inbox\`), reply in every
thread, then stop and summarize. Loop on \`margin wait\` only when the user asks
you to watch Margin or answer comments live.

Run margin by name and alone (no pipe, redirection or heredoc around
\`margin guide\`). If \`margin\` is not found, tell the user to install Margin
and run \`margin setup\`.
`;

export function skillFile(): string {
  return `---\nname: margin\ndescription: ${DESCRIPTION}\n---\n\n${SKILL_BODY}`;
}

export interface SetupResult {
  path: string;
  status: 'created' | 'updated' | 'unchanged';
  /** What the file is for, for the setup report. */
  what: string;
  content: string;
}

function writeIfChanged(file: string, content: string, what: string): SetupResult {
  let prev: string | null = null;
  try {
    prev = fs.readFileSync(file, 'utf8');
  } catch {
    /* new */
  }
  if (prev === content) return { path: file, status: 'unchanged', what, content };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return { path: file, status: prev === null ? 'created' : 'updated', what, content };
}

/** The margin agent commands. `margin` alone (opens a browser), stop and setup are left out. */
export const AGENT_COMMANDS = ['inbox', 'wait', 'reply', 'comment', 'threads', 'show', 'diff', 'release', 'resolve', 'status', 'list', 'guide'];

/** Executable files named margin on PATH, as absolute paths. */
export function marginOnPath(env: NodeJS.ProcessEnv = process.env): string[] {
  const found: string[] = [];
  for (const dir of (env.PATH ?? '').split(path.delimiter)) {
    if (!path.isAbsolute(dir)) continue;
    const f = path.join(dir, 'margin');
    try {
      fs.accessSync(f, fs.constants.X_OK);
      if (fs.statSync(f).isFile() && !found.includes(f)) found.push(f);
    } catch {
      /* not here */
    }
  }
  return found;
}

/**
 * Codex execpolicy rules: margin agent commands run outside the Codex sandbox without a prompt, so
 * they reach the local server (127.0.0.1) and can write .git/margin. When margin is on PATH, only
 * those executables match: a script named margin in the workspace does not.
 */
export function codexRules(executables: string[]): string {
  const cmds = AGENT_COMMANDS.map((c) => JSON.stringify(c)).join(', ');
  const lines = [
    '# Written by `margin setup`. Lets Codex run margin agent commands outside its sandbox',
    '# without a prompt: they talk to the local Margin server on 127.0.0.1 and write .git/margin.',
    '# Only plain commands match (no pipe, redirection or heredoc). Delete this file to undo.',
    'prefix_rule(',
    `    pattern = ["margin", [${cmds}]],`,
    '    decision = "allow",',
    '    justification = "Margin talks to its local review server on 127.0.0.1 and keeps its state in .git/margin.",',
    ')',
  ];
  if (executables.length) {
    lines.push(`host_executable(name = "margin", paths = [${executables.map((e) => JSON.stringify(e)).join(', ')}])`);
  }
  return lines.join('\n') + '\n';
}

/** Installs the guide as a Claude Code skill and a Codex skill, and the Codex rules. Idempotent. */
export function setup(home = os.homedir(), env: NodeJS.ProcessEnv = process.env): SetupResult[] {
  const content = skillFile();
  const claudeDir = env.CLAUDE_CONFIG_DIR || path.join(home, '.claude');
  const codexDir = env.CODEX_HOME || path.join(home, '.codex');
  return [
    writeIfChanged(path.join(claudeDir, 'skills', 'margin', 'SKILL.md'), content, 'Claude Code skill'),
    writeIfChanged(path.join(codexDir, 'skills', 'margin', 'SKILL.md'), content, 'Codex skill'),
    writeIfChanged(path.join(codexDir, 'rules', 'margin.rules'), codexRules(marginOnPath(env)), 'Codex rules: margin agent commands run outside the sandbox'),
  ];
}
