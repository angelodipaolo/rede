import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import type { Message, Thread } from '../../../src/shared/types.ts';
import { emit, useTopics } from '../bus.ts';
import { Markdown } from '../markdown.tsx';
import {
  closeComposer,
  createThread,
  deleteMessage,
  editMessage,
  hasPending,
  latestBatchId,
  markRead,
  openComposer,
  reply,
  S,
  sendHintVisible,
  setResolved,
  stashComposer,
  type SendKind,
  takeFocusComposer,
  threadLabel,
  toggleResolvedOpen,
  updateComposer,
} from '../store.ts';
import { agentColorClass, relTime } from '../util.ts';
import { Icon } from './Icon.tsx';
import { OriginalCode, OutdatedNote } from './Original.tsx';

export function Avatar({ kind, name }: { kind: 'human' | 'agent'; name: string }) {
  if (kind === 'human') return <span class="av av-h">{(name[0] ?? 'y').toUpperCase()}</span>;
  return (
    <span class={`av av-a ${agentColorClass(name)}`} title={`Agent: ${name}`}>
      <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
        <path d="M8 1.5l1.6 4.9 4.9 1.6-4.9 1.6L8 14.5l-1.6-4.9L1.5 8l4.9-1.6z" fill="currentColor" />
      </svg>
    </span>
  );
}

function MessageView({ m, thread }: { m: Message; thread: Thread }) {
  useTopics('composers');
  const editKey = `edit:${m.id}`;
  const draft = S.composers.get(editKey);
  const editing = !!draft && !draft.hidden;
  const agent = m.author.kind === 'agent';
  return (
    <div class={`msg ${agent ? 'msg-a ' + agentColorClass(m.author.name) : 'msg-h'}${m.pending ? ' msg-p' : ''}`}>
      <Avatar kind={m.author.kind} name={m.author.name} />
      <div class="msg-main">
        <div class="msg-head">
          <span class="who">{agent ? m.author.name : 'You'}</span>
          {agent && <span class="role">agent</span>}
          {m.pending && (
            <span class="badge pending" title="Pending: part of your review in progress. The agent gets it when you finish the review.">
              Pending
            </span>
          )}
          <time title={new Date(m.createdAt).toLocaleString()}>{relTime(m.createdAt)}</time>
          {m.editedAt && <span class="edited">edited</span>}
          {!agent && !editing && (
            <span class="msg-act">
              <button
                class="ib sm"
                title="Edit"
                onClick={() => openComposer({ key: editKey, kind: 'edit', scope: S.scope, path: thread.anchor.path, threadId: thread.id, messageId: m.id, text: m.body, original: m.body })}
              >
                <Icon name="edit" size={14} />
              </button>
              <button
                class="ib sm"
                title={m.pending ? 'Remove from the review' : 'Delete'}
                onClick={() => {
                  if (confirm(m.pending ? 'Remove this pending comment from your review?' : 'Delete this message?')) void deleteMessage(thread.id, m.id);
                }}
              >
                <Icon name="trash" size={14} />
              </button>
            </span>
          )}
        </div>
        {editing ? <Composer ck={editKey} /> : <Markdown src={m.body} class="msg-body" />}
        {draft?.hidden && <DraftChip ck={editKey} label="Unsaved edit" />}
      </div>
    </div>
  );
}

function AgentStatus({ t }: { t: Thread }) {
  useTopics('agents');
  if (t.resolved || t.noteOnly) return null;
  if (t.agentState === 'working')
    return (
      <div class={`agst working ${agentColorClass(t.claimedBy ?? 'agent')}`}>
        <span class="spin" />
        <span>
          <b>{t.claimedBy ?? 'An agent'}</b> is looking into it<span class="ell" />
        </span>
      </div>
    );
  if (t.agentState === 'pending') {
    const none = S.agents.length === 0;
    return (
      <div class="agst pending">
        <span class="pulse-dot" />
        <span>{hasPending(t) ? 'Your sent messages wait for an agent. The pending one goes with your review.' : 'Waiting for an agent'}</span>
        {none && (
          <span class="hint">
            · tell your agent: <q>address rede feedback</q>{' '}
            <button
              class="link"
              title="Prompts and setup"
              onClick={(e) => {
                e.stopPropagation();
                S.connect = true;
                emit('ui');
              }}
            >
              How?
            </button>
          </span>
        )}
      </div>
    );
  }
  return null;
}

const MODE_TITLE = {
  discuss: 'Sent in a Discuss review: the agent answers and does not change code.',
  implement: 'Sent in an Implement review: the agent changes the code, then reports.',
} as const;

/** The mode of the latest human submission. Nothing for a one-off ("ask"). */
export function ModeChip({ t }: { t: Thread }) {
  if (t.mode === 'ask') return null;
  const b = latestBatchId(t);
  return (
    <span class={`badge mode-${t.mode}`} title={`${b ? `Review #${b}. ` : ''}${MODE_TITLE[t.mode]}`}>
      {t.mode === 'implement' ? 'Implement' : 'Discuss'}
    </span>
  );
}

export function ThreadView({ id, pinned }: { id: number; pinned?: boolean }) {
  useTopics(`t:${id}`, 'composers');
  const t = S.threads.get(id);
  const ref = useRef<HTMLDivElement>(null);
  const unread = S.unread.has(id);

  useEffect(() => {
    const el = ref.current;
    if (!el || !unread) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const io = new IntersectionObserver(
      ([e]) => {
        if (e?.isIntersecting) timer = setTimeout(() => markRead(id), 1200);
        else if (timer) clearTimeout(timer);
      },
      { threshold: 0.6 },
    );
    io.observe(el);
    return () => {
      io.disconnect();
      if (timer) clearTimeout(timer);
    };
  }, [unread, id]);

  if (!t) return null;
  const a = t.anchor;
  const lineRef =
    a.startLine === null ? 'File' : a.startLine === a.endLine ? `${a.side === 'old' ? 'L' : 'R'}${a.endLine}` : `${a.side === 'old' ? 'L' : 'R'}${a.startLine}–${a.endLine}`;
  const first = t.messages[0];
  const lastMsg = t.messages[t.messages.length - 1];

  if (t.resolved && !S.openResolved.has(id)) {
    return (
      <div
        class="thread resolved-line"
        data-thread={id}
        ref={ref}
        role="button"
        tabIndex={0}
        aria-expanded={false}
        title="Show resolved thread"
        onClick={() => toggleResolvedOpen(id)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            toggleResolvedOpen(id);
          }
        }}
      >
        <Icon name="check" size={14} />
        <span class="rl-ref">{lineRef}</span>
        <span class="rl-txt">{first?.body.split('\n')[0]}</span>
        <span class="rl-n">
          {t.messages.length} {t.messages.length === 1 ? 'message' : 'messages'} · resolved
          {hasPending(t) && <b class="rl-pending"> · pending reply</b>}
          {S.composers.has(`reply:${id}`) && <b class="rl-draft"> · draft reply</b>}
        </span>
      </div>
    );
  }

  const replyKey = `reply:${id}`;
  const replyDraft = S.composers.get(replyKey);
  const replying = !!replyDraft && !replyDraft.hidden;
  const needsMe = !t.resolved && lastMsg?.author.kind === 'agent';
  const onlyPending = t.messages.every((m) => m.pending);

  return (
    <div
      class={`thread${unread ? ' unread' : ''}${t.noteOnly ? ' note' : ''}${t.resolved ? ' is-resolved' : ''}${onlyPending ? ' pending-only' : ''}`}
      data-thread={id}
      data-k={`t${id}`}
      ref={ref}
    >
      <div class="th-head">
        <span class="th-ref">{lineRef}</span>
        <ModeChip t={t} />
        {t.messages[0]?.author.kind === 'agent' && (
          <span class={`badge finding ${agentColorClass(t.messages[0].author.name)}`} title={`Started by the agent ${t.messages[0].author.name}`}>
            Finding · {t.messages[0].author.name}
          </span>
        )}
        {t.noteOnly && (
          <span class="badge note" title="Private note. Agents never see it.">
            <Icon name="note" size={12} /> Note
          </span>
        )}
        {t.outdated && (
          <span class="badge outdated" title={t.outdatedReason === 'file-gone' ? 'The file is no longer in this diff' : 'The code this comment was written on has changed'}>
            {t.outdatedReason === 'file-gone' ? 'File not in diff' : 'Outdated'}
          </span>
        )}
        {pinned && !t.outdated && a.startLine !== null && <span class="badge">Not in visible diff</span>}
        {unread && <span class="badge new">New reply</span>}
        {needsMe && !unread && <span class="badge attn">Your turn</span>}
        <span class="sp" />
        <span class="th-id">#{t.id}</span>
        {t.resolved ? (
          <>
            <button class="btn sm ghost" onClick={() => toggleResolvedOpen(id)}>
              Collapse
            </button>
            <button class="btn sm" onClick={() => void setResolved(id, false)}>
              Unresolve
            </button>
          </>
        ) : (
          <button class="btn sm" onClick={() => void setResolved(id, true)} title="Resolve thread">
            <Icon name="check" size={14} /> Resolve
          </button>
        )}
      </div>
      {t.outdated ? (
        <>
          <OutdatedNote t={t} />
          <OriginalCode t={t} />
        </>
      ) : (
        pinned &&
        t.snippet.length > 0 && (
          <pre class="snippet">
            {t.snippet.slice(0, 12).join('\n')}
            {t.snippet.length > 12 ? '\n…' : ''}
          </pre>
        )
      )}
      <div class="msgs">
        {/* Pending messages go to the end: that is where they land when the review is submitted. */}
        {[...t.messages.filter((m) => !m.pending), ...t.messages.filter((m) => m.pending)].map((m) => (
          <MessageView key={m.id} m={m} thread={t} />
        ))}
      </div>
      <AgentStatus t={t} />
      {replying ? (
          <div class="reply-wrap">
            <Composer ck={replyKey} />
          </div>
        ) : replyDraft ? (
          <DraftChip ck={replyKey} label="Draft reply" />
        ) : (
          <button
            class="reply-fake"
            onClick={() => openComposer({ key: replyKey, kind: 'reply', scope: S.scope, path: a.path, threadId: id })}
          >
            <Icon name="reply" size={14} /> {t.resolved ? 'Reply (reopens the thread)…' : 'Reply…'}
          </button>
        )}
    </div>
  );
}

export function Composer({ ck }: { ck: string }) {
  useTopics('composers', 'pending');
  const c = S.composers.get(ck);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const [busy, setBusy] = useState(false);
  const [text, setText] = useState(c?.text ?? '');

  useLayoutEffect(() => {
    const ta = taRef.current;
    if (ta && takeFocusComposer(ck)) {
      ta.focus();
      ta.setSelectionRange(ta.value.length, ta.value.length);
    }
  });
  useLayoutEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = Math.min(420, Math.max(64, ta.scrollHeight + 2)) + 'px';
  }, [text]);

  if (!c) return null;
  if (c.hidden) return <DraftChip ck={ck} label={c.kind === 'new' ? 'Draft comment' : 'Draft'} />;

  const submit = async (mode: SendKind | 'resolve') => {
    const body = (taRef.current?.value ?? text).trim();
    if (!body || busy) return;
    setBusy(true);
    let ok = false;
    c.text = body;
    if (c.kind === 'new') ok = await createThread(c, mode === 'resolve' ? 'comment' : mode);
    else if (c.kind === 'reply') ok = await reply(c.threadId!, body, { resolve: mode === 'resolve', pending: mode === 'review' });
    else if (c.kind === 'edit') ok = await editMessage(c.messageId!, body);
    setBusy(false);
    if (ok) closeComposer(ck);
  };

  // A note thread is never sent, so its replies cannot join a review.
  const thread = c.threadId !== undefined ? S.threads.get(c.threadId) : undefined;
  const canReview = c.kind === 'new' || (c.kind === 'reply' && !thread?.noteOnly);
  const inReview = S.pendingCount > 0;
  // The primary action (⌘↵) follows the review in progress; ⌘⇧↵ is the other one.
  const primary: SendKind = canReview && inReview ? 'review' : 'comment';
  const secondary: SendKind | null = canReview ? (primary === 'review' ? 'comment' : 'review') : null;
  const label = (k: SendKind) => (k === 'review' ? (inReview ? 'Add to review' : 'Start a review') : c.kind === 'reply' && !canReview ? 'Reply' : 'Comment');
  const tip = (k: SendKind) =>
    k === 'review'
      ? 'Queue it as pending. The agent gets all pending comments together when you finish the review.'
      : 'Send it now. The agent answers this one at once.';
  const keyHint =
    c.kind === 'edit'
      ? '⌘↵ to save'
      : `⌘↵ ${label(primary)}${secondary ? ` · ⌘⇧↵ ${label(secondary)}` : ''}`;

  const a = c.anchor;
  const title =
    c.kind === 'new'
      ? a && a.startLine !== null
        ? a.startLine === a.endLine
          ? `Comment on ${a.side === 'old' ? 'old' : 'new'} line ${a.endLine}`
          : `Comment on ${a.side === 'old' ? 'old' : 'new'} lines ${a.startLine}–${a.endLine}`
        : 'Comment on file'
      : null;

  return (
    <div class={`composer k-${c.kind}`} data-composer={ck} data-k={`cmp:${ck}`}>
      {title && <div class="cmp-title">{title}</div>}
      <textarea
        ref={taRef}
        value={text}
        disabled={busy}
        placeholder={c.kind === 'new' ? 'Ask a question or leave a comment. Markdown works.' : c.kind === 'reply' ? 'Reply…' : ''}
        onInput={(e) => {
          const v = (e.target as HTMLTextAreaElement).value;
          setText(v);
          updateComposer(ck, v);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            void submit(c.kind === 'edit' ? 'comment' : e.shiftKey && secondary ? secondary : primary);
          } else if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            stashComposer(ck, (e.target as HTMLTextAreaElement).value);
          }
        }}
      />
      <div class="cmp-bar">
        <span class="cmp-hint" title="Esc closes the composer and keeps the draft">
          {keyHint} · Esc keeps the draft
        </span>
        <span class="sp" />
        <button
          class="btn sm ghost"
          title={c.kind === 'edit' ? 'Discard the changes to this message' : 'Delete this draft'}
          onClick={() => closeComposer(ck)}
          disabled={busy}
        >
          Discard
        </button>
        {c.kind === 'new' && (
          <button class="btn sm ghost" title="Private note. Agents never see it." onClick={() => void submit('note')} disabled={busy || !text.trim()}>
            <Icon name="note" size={14} /> Note
          </button>
        )}
        {c.kind === 'reply' && (
          <button class="btn sm ghost" onClick={() => void submit('resolve')} disabled={busy || !text.trim()}>
            Reply &amp; resolve
          </button>
        )}
        {c.kind === 'edit' ? (
          <button class="btn sm primary" onClick={() => void submit('comment')} disabled={busy || !text.trim()}>
            Save
          </button>
        ) : (
          <>
            {secondary && (
              <button class={`btn sm send-${secondary}`} title={tip(secondary)} onClick={() => void submit(secondary)} disabled={busy || !text.trim()}>
                {label(secondary)}
              </button>
            )}
            <button class={`btn sm primary send-${primary}`} title={tip(primary)} onClick={() => void submit(primary)} disabled={busy || !text.trim()}>
              {label(primary)}
            </button>
          </>
        )}
      </div>
      {canReview && sendHintVisible() && (
        <div class="cmp-explain">
          <b>Comment</b>: the agent answers now · <b>Review</b>: queue comments, send them together
        </div>
      )}
    </div>
  );
}

/** A draft closed with Esc. Its text stays until it is posted or discarded. */
export function DraftChip({ ck, label = 'Draft' }: { ck: string; label?: string }) {
  useTopics('composers');
  const c = S.composers.get(ck);
  if (!c || !c.hidden) return null;
  const first = c.text.trim().split('\n')[0] ?? '';
  const resume = () => openComposer(c);
  return (
    <div class="draft-chip" data-k={`draft:${ck}`}>
      <Icon name="edit" size={13} />
      <span class="dc-label">{label}</span>
      <button class="dc-txt" title="Resume editing" onClick={resume}>
        {first}
      </button>
      <button class="btn sm ghost" onClick={resume}>
        Resume
      </button>
      <button
        class="btn sm ghost"
        onClick={() => {
          if (confirm('Discard this draft?')) closeComposer(ck);
        }}
      >
        Discard
      </button>
    </div>
  );
}

export { threadLabel };
