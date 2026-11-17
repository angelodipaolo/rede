import { useEffect, useRef, useState } from 'preact/hooks';
import type { ReviewScope } from '../../../src/shared/types.ts';
import { emit, useTopics } from '../bus.ts';
import {
  cycleTheme,
  deleteMessage,
  discardReview,
  historyHref,
  jumpToThread,
  pendingList,
  reviewNote,
  S,
  setFinishOpen,
  setReviewNote,
  setScope,
  setSidebar,
  setView,
  submitReview,
  threadLabel,
  toggleWrap,
} from '../store.ts';
import { agentColorClass, copyText, relTime } from '../util.ts';
import { Icon } from './Icon.tsx';

const SCOPE_LABEL: Record<ReviewScope, string> = { all: 'All changes', staged: 'Staged', unstaged: 'Unstaged' };

function ScopeToggle() {
  useTopics('review', 'ui');
  const r = S.review;
  if (!r || !r.scopes || r.scopes.length < 2) return null;
  return (
    <div class="seg" role="tablist" title="Scope (s)">
      {r.scopes.map((s) => (
        <button key={s} role="tab" aria-selected={S.scope === s} class={S.scope === s ? 'on' : ''} onClick={() => setScope(s)}>
          {SCOPE_LABEL[s]}
          <span class="segn">{r.scopeFileCounts?.[s] ?? ''}</span>
        </button>
      ))}
    </div>
  );
}

function Progress() {
  useTopics('progress', 'files');
  const total = S.files.length;
  const viewed = S.files.filter((f) => f.viewed).length;
  const pct = total ? (viewed / total) * 100 : 0;
  return (
    <div class={`prog${total && viewed === total ? ' done' : ''}`} title={`${viewed} of ${total} files viewed`}>
      <span class="prog-txt">
        <b>{viewed}</b> / {total} viewed
      </span>
      <span class="bar">
        <span style={{ width: `${pct}%` }} />
      </span>
    </div>
  );
}

function ThreadCount() {
  useTopics('threads', 'ui');
  let open = 0;
  let mine = 0;
  for (const t of S.threads.values()) {
    // Threads not sent yet belong to the review in progress, not to the conversation.
    if (t.resolved || t.messages.every((m) => m.pending)) continue;
    open++;
    if (t.messages[t.messages.length - 1]?.author.kind === 'agent') mine++;
  }
  const unread = S.unread.size;
  return (
    <button
      class={`tb-btn${S.panel ? ' on' : ''}`}
      title="Threads panel"
      onClick={() => {
        S.panel = !S.panel;
        emit('ui', 'layout');
      }}
    >
      <Icon name="comment" size={15} />
      <span>
        {open} unresolved{mine > 0 && <span class="attn-n"> · {mine} need you</span>}
      </span>
      {unread > 0 && <span class="dot unread" />}
    </button>
  );
}

function FinishReview() {
  useTopics('pending', 'ui');
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!S.finish) return;
    const onDoc = (e: MouseEvent) => {
      // Confirm dialogs and clicks inside keep it open.
      if (ref.current && !ref.current.contains(e.target as Node)) setFinishOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [S.finish]);
  const n = S.pendingCount;
  if (n === 0) return null;
  return (
    <div class="finish-wrap" ref={ref}>
      <button
        class={`tb-btn finish${S.finish ? ' on' : ''}`}
        title="Finish your review: send all pending comments to the agent (Shift+R)"
        aria-expanded={S.finish}
        onClick={() => setFinishOpen(!S.finish)}
      >
        Finish review <span class="finish-n">{n}</span>
      </button>
      {S.finish && <FinishPanel />}
    </div>
  );
}

function FinishPanel() {
  useTopics('threads', 'pending', 'agents');
  const [note, setNote] = useState(reviewNote);
  const [busy, setBusy] = useState(false);
  const taRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => taRef.current?.focus(), []);
  const items = pendingList();
  const send = async (mode: 'discuss' | 'implement') => {
    if (busy) return;
    setBusy(true);
    const ok = await submitReview(mode, note);
    if (!ok) setBusy(false);
  };
  const n = S.pendingCount;
  return (
    <div
      class="popover finish-pop"
      role="dialog"
      aria-label="Finish your review"
      onKeyDown={(e) => {
        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
          e.preventDefault();
          void send(e.shiftKey ? 'implement' : 'discuss');
        } else if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          setFinishOpen(false);
        }
      }}
    >
      <div class="pop-h">
        Finish your review <span class="muted">· {n} pending {n === 1 ? 'comment' : 'comments'}</span>
      </div>
      <ul class="pend-list">
        {items.map(({ t, m }) => (
          <li key={m.id}>
            <button
              class="pend-go"
              title="Jump to this comment"
              onClick={() => {
                setFinishOpen(false);
                jumpToThread(t.id);
              }}
            >
              <span class="pend-loc">{threadLabel(t)}</span>
              <span class="pend-txt">
                {t.messages[0] !== m && <span class="pend-kind">reply · </span>}
                {m.body.trim().split('\n')[0]}
              </span>
            </button>
            <button
              class="ib sm"
              title="Remove from the review"
              aria-label="Remove from the review"
              onClick={() => {
                if (confirm('Remove this pending comment from your review?')) void deleteMessage(t.id, m.id);
              }}
            >
              <Icon name="x" size={12} />
            </button>
          </li>
        ))}
      </ul>
      <textarea
        ref={taRef}
        class="finish-note"
        placeholder="Overall note to the agent (optional). Markdown works."
        value={note}
        disabled={busy}
        onInput={(e) => {
          const v = (e.target as HTMLTextAreaElement).value;
          setNote(v);
          setReviewNote(v);
        }}
      />
      <div class="finish-acts">
        <button class="mode-btn discuss" disabled={busy} onClick={() => void send('discuss')}>
          <span class="mb-t">Discuss</span>
          <span class="mb-s">Agent answers. No code changes.</span>
          <kbd>⌘↵</kbd>
        </button>
        <button class="mode-btn implement" disabled={busy} onClick={() => void send('implement')}>
          <span class="mb-t">Implement</span>
          <span class="mb-s">Agent makes the changes, then reports.</span>
          <kbd>⌘⇧↵</kbd>
        </button>
      </div>
      <div class="finish-foot">
        {S.agents.length === 0 ? (
          <span class="muted">
            No agent connected. After you send it, tell your agent: <q>Address the Rede feedback.</q>
          </span>
        ) : (
          <span />
        )}
        <span class="sp" />
        <button
          class="btn sm ghost danger"
          disabled={busy}
          onClick={() => {
            if (confirm(`Discard your review? This deletes ${n} pending ${n === 1 ? 'comment' : 'comments'}.`)) void discardReview();
          }}
        >
          Discard review
        </button>
      </div>
    </div>
  );
}

function Presence() {
  useTopics('agents', 'conn', 'ui');
  const agents = S.agents;
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!S.connect) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        S.connect = false;
        emit('ui');
      }
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [S.connect]);
  return (
    <div class="presence-wrap" ref={ref}>
      <button
        class={`tb-btn presence${agents.length ? '' : ' none'}`}
        onClick={() => {
          S.connect = !S.connect;
          emit('ui');
        }}
        title="Agents"
        aria-label={agents.length ? 'Connected agents' : 'Connect an agent'}
        aria-expanded={S.connect}
      >
        {agents.length === 0 ? (
          <>
            <Icon name="plug" size={15} />
            <span class="tb-lbl">Connect agent</span>
          </>
        ) : (
          agents.map((a) => (
            <span key={a.name} class={`agent-pill ${agentColorClass(a.name)} ${a.state}`}>
              <span class="adot" />
              {a.name}
              <span class="astate">{a.state === 'working' ? 'working' : 'waiting'}</span>
            </span>
          ))
        )}
      </button>
      {S.connect && <ConnectPopover />}
    </div>
  );
}

function CopyBox({ text }: { text: string }) {
  const [ok, setOk] = useState(false);
  return (
    <div class="copybox">
      <code>{text}</code>
      <button
        class="ib"
        title="Copy"
        onClick={() =>
          void copyText(text).then(() => {
            setOk(true);
            setTimeout(() => setOk(false), 1200);
          })
        }
      >
        <Icon name={ok ? 'check' : 'copy'} size={14} />
      </button>
    </div>
  );
}

function ConnectPopover() {
  const agents = S.agents;
  return (
    <div class="popover connect">
      <div class="pop-h">Agents</div>
      {agents.length > 0 ? (
        <ul class="agent-list">
          {agents.map((a) => (
            <li key={a.name} class={agentColorClass(a.name)}>
              <span class="adot" />
              <b>{a.name}</b>
              <span class="muted">
                {a.state === 'working' ? 'working on a thread' : 'waiting for comments'} · since {relTime(a.since)}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p class="muted small">No agent is connected. Your feedback waits here until an agent reads it.</p>
      )}
      <p class="small">
        When you finish a review, tell Claude Code or Codex in this repo:
      </p>
      <CopyBox text="Address the Rede feedback." />
      <p class="small muted">It reads your feedback, answers or changes the code, replies in each thread, and stops.</p>
      <p class="small">To have it answer each comment while you review:</p>
      <CopyBox text="Watch Rede and answer my comments live." />
      <p class="small muted">
        These prompts use the Rede skill. Install it once (run it again after you update Rede):
      </p>
      <CopyBox text="rede setup" />
    </div>
  );
}

function Conn() {
  useTopics('conn');
  if (S.conn === 'open') return null;
  return (
    <span class={`conn ${S.conn}`} title={S.conn === 'down' ? 'Server unreachable. Reconnecting…' : 'Connecting…'}>
      <span class="cdot" />
      {S.conn === 'down' ? 'Disconnected' : 'Connecting'}
    </span>
  );
}

export function TopBar() {
  useTopics('review', 'ui', 'view', 'layout');
  const r = S.review;
  const dark =
    S.theme === 'dark' || (S.theme === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
  return (
    <header class="topbar">
      <button class="ib" title={S.sidebarHidden ? 'Show file tree' : 'Hide file tree'} onClick={() => setSidebar(null, !S.sidebarHidden)}>
        <Icon name="sidebar" />
      </button>
      <div class="ident">
        <a class="repo" href="/" title={r?.repo.root}>
          {r?.repo.name ?? 'Rede'}
        </a>
        {r?.repo.branch && <span class="branch">{r.repo.branch}</span>}
        <span class="title">{r?.title ?? ''}</span>
      </div>
      <ScopeToggle />
      <Progress />
      <span class="sp" />
      <Conn />
      <FinishReview />
      <ThreadCount />
      <Presence />
      <a class="ib" href={historyHref()} title="History of past reviews (h)" aria-label="History">
        <Icon name="history" />
      </a>
      <div class="seg icons" title="Split or unified (u)">
        <button class={S.view === 'split' ? 'on' : ''} onClick={() => setView('split')} title="Split view">
          <Icon name="split" />
        </button>
        <button class={S.view === 'unified' ? 'on' : ''} onClick={() => setView('unified')} title="Unified view">
          <Icon name="unified" />
        </button>
      </div>
      <button
        class={`ib${S.wrap ? ' on' : ''}`}
        title={S.wrap ? 'Long lines wrap. Switch to no wrap (w)' : 'Long lines scroll sideways. Switch to soft wrap (w)'}
        aria-label="Soft wrap long lines"
        aria-pressed={S.wrap}
        onClick={toggleWrap}
      >
        <Icon name={S.wrap ? 'wrap' : 'nowrap'} />
      </button>
      <button class="ib" title={dark ? 'Light theme' : 'Dark theme'} onClick={cycleTheme}>
        <Icon name={dark ? 'sun' : 'moon'} />
      </button>
      <button
        class="ib"
        title="Keyboard shortcuts (?)"
        onClick={() => {
          S.sheet = true;
          emit('ui');
        }}
      >
        <Icon name="keyboard" />
      </button>
    </header>
  );
}
