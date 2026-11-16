import { useEffect, useRef, useState } from 'preact/hooks';
import type { ReviewScope } from '../../../src/shared/types.ts';
import { emit, useTopics } from '../bus.ts';
import { cycleTheme, S, setScope, setSidebar, setView, toggleWrap } from '../store.ts';
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
    if (t.resolved) continue;
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
      >
        {agents.length === 0 ? (
          <>
            <Icon name="plug" size={15} />
            <span>Connect agent</span>
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
        <p class="muted small">No agent is connected. Comments wait until one connects.</p>
      )}
      <p class="small">
        Start Claude Code or Codex in this repo and paste this prompt. The agent waits for your comments and answers them in the threads.
      </p>
      <CopyBox text="Run `margin guide` and follow it." />
      <p class="small muted">
        To install the skill so the agent knows Margin without a prompt, run <code>margin setup</code> once.
      </p>
      <CopyBox text="margin setup" />
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
          {r?.repo.name ?? 'Margin'}
        </a>
        {r?.repo.branch && <span class="branch">{r.repo.branch}</span>}
        <span class="title">{r?.title ?? ''}</span>
      </div>
      <ScopeToggle />
      <Progress />
      <span class="sp" />
      <Conn />
      <ThreadCount />
      <Presence />
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
