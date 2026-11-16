import { useState } from 'preact/hooks';
import type { Thread } from '../../../src/shared/types.ts';
import { emit, useTopics } from '../bus.ts';
import { dismissToast, jumpToThread, S, threadLabel } from '../store.ts';
import { agentColorClass, relTime } from '../util.ts';
import { Icon } from './Icon.tsx';
import { Avatar, ThreadView } from './Thread.tsx';

type Filter = 'open' | 'attn' | 'resolved' | 'all';

const SCOPE_NAME = { all: 'All changes', staged: 'Staged', unstaged: 'Unstaged' } as const;

function shortLoc(s: string, max = 46): string {
  if (s.length <= max) return s;
  const parts = s.split('/');
  let out = parts[parts.length - 1]!;
  for (let i = parts.length - 2; i >= 0; i--) {
    const next = `${parts[i]}/${out}`;
    if (next.length + 2 > max) break;
    out = next;
  }
  return `…/${out}`;
}

function needsMe(t: Thread) {
  return !t.resolved && t.messages[t.messages.length - 1]?.author.kind === 'agent';
}

export function ThreadsPanel() {
  useTopics('threads', 'ui', 'files');
  const [filter, setFilter] = useState<Filter>('open');
  if (!S.panel) return null;
  const order = new Map(S.files.map((f, i) => [f.path, i]));
  const all = [...S.threads.values()].sort((a, b) => {
    const fa = order.get(a.anchor.path) ?? 1e9;
    const fb = order.get(b.anchor.path) ?? 1e9;
    return fa - fb || a.anchor.path.localeCompare(b.anchor.path) || (a.anchor.endLine ?? 0) - (b.anchor.endLine ?? 0);
  });
  const counts = {
    open: all.filter((t) => !t.resolved).length,
    attn: all.filter(needsMe).length,
    resolved: all.filter((t) => t.resolved).length,
    all: all.length,
  };
  const list = all.filter((t) =>
    filter === 'open' ? !t.resolved : filter === 'attn' ? needsMe(t) : filter === 'resolved' ? t.resolved : true,
  );
  const tabs: [Filter, string][] = [
    ['open', 'Open'],
    ['attn', 'Needs me'],
    ['resolved', 'Resolved'],
    ['all', 'All'],
  ];
  return (
    <aside class="panel">
      <div class="panel-h">
        <b>Threads</b>
        <span class="sp" />
        <button
          class="ib"
          title="Close"
          onClick={() => {
            S.panel = false;
            emit('ui', 'layout');
          }}
        >
          <Icon name="x" />
        </button>
      </div>
      <div class="tabs">
        {tabs.map(([k, label]) => (
          <button key={k} class={filter === k ? 'on' : ''} onClick={() => setFilter(k)}>
            {label}
            <span class="n">{counts[k]}</span>
          </button>
        ))}
      </div>
      <div class="plist">
        {list.length === 0 && (
          <div class="empty-small">
            {filter === 'attn' ? 'Nothing needs you. Agents have not replied to anything open.' : 'No threads here.'}
          </div>
        )}
        {list.map((t) => {
          const last = t.messages[t.messages.length - 1];
          const unread = S.unread.has(t.id);
          const offScope = !t.inScope;
          const gone = !offScope && !S.fileByPath.has(t.anchor.path);
          return (
            <button key={t.id} class={`pitem${unread ? ' unread' : ''}${t.resolved ? ' resolved' : ''}`} onClick={() => jumpToThread(t.id)}>
              <div class="pi-top">
                <span class="pi-loc" title={threadLabel(t)}>{shortLoc(threadLabel(t))}</span>
                {offScope && <span class="badge scope">in {SCOPE_NAME[t.homeScope] ?? t.homeScope}</span>}
                {(t.outdated || gone) && <span class="badge outdated">Outdated</span>}
                {t.noteOnly && <span class="badge note">Note</span>}
                {unread && <span class="dot unread" />}
              </div>
              {last && (
                <div class="pi-msg">
                  <Avatar kind={last.author.kind} name={last.author.name} />
                  <span class={`pi-who ${last.author.kind === 'agent' ? agentColorClass(last.author.name) : ''}`}>
                    {last.author.kind === 'agent' ? last.author.name : 'you'}
                  </span>
                  <span class="pi-txt">{last.body.replace(/[#*`>_]/g, '').slice(0, 140)}</span>
                </div>
              )}
              <div class="pi-meta">
                {t.agentState === 'working' && !t.resolved ? (
                  <span class="working-txt">{t.claimedBy ?? 'agent'} is working…</span>
                ) : t.agentState === 'pending' && !t.resolved ? (
                  <span>Waiting for an agent</span>
                ) : needsMe(t) ? (
                  <span class="attn-txt">Your turn</span>
                ) : t.resolved ? (
                  <span>Resolved</span>
                ) : (
                  <span />
                )}
                <span class="sp" />
                <span>{t.messages.length} msg · {relTime(t.updatedAt)}</span>
              </div>
            </button>
          );
        })}
      </div>
    </aside>
  );
}

export function OutdatedSection() {
  useTopics('threads', 'files');
  const [open, setOpen] = useState(false);
  const list = [...S.threads.values()].filter((t) => t.inScope && !S.fileByPath.has(t.anchor.path));
  if (!list.length) return null;
  const unresolved = list.filter((t) => !t.resolved).length;
  return (
    <section class="card outdated-sec">
      <div class="fh" onClick={() => setOpen(!open)}>
        <button class="chev">
          <Icon name={open ? 'downchev' : 'right'} />
        </button>
        <span class="badge outdated">Outdated</span>
        <span class="fpath">
          {list.length} {list.length === 1 ? 'thread' : 'threads'} on files no longer in this diff
          {unresolved > 0 && <span class="muted"> · {unresolved} unresolved</span>}
        </span>
      </div>
      {open && (
        <div class="fb">
          {list.map((t) => (
            <div key={t.id} class="attach top">
              <div class="od-path">{t.anchor.path}</div>
              <ThreadView id={t.id} pinned />
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

export function Toasts() {
  useTopics('toasts');
  if (!S.toasts.length) return null;
  return (
    <div class="toasts">
      {S.toasts.map((t) => (
        <div
          key={t.id}
          class={`toast ${t.kind}${t.agent ? ' ' + agentColorClass(t.agent) : ''}`}
          onClick={() => {
            if (t.threadId !== undefined) jumpToThread(t.threadId);
            dismissToast(t.id);
          }}
        >
          {t.kind === 'agent' && <Avatar kind="agent" name={t.agent ?? 'agent'} />}
          <span class="toast-txt">{t.text}</span>
          {t.threadId !== undefined && <span class="toast-go">Jump</span>}
          <button
            class="ib sm"
            onClick={(e) => {
              e.stopPropagation();
              dismissToast(t.id);
            }}
          >
            <Icon name="x" size={12} />
          </button>
        </div>
      ))}
    </div>
  );
}

const KEYS: [string, string][] = [
  ['j / k', 'Next / previous file'],
  ['n / p', 'Next / previous unresolved thread'],
  ['v', 'Toggle viewed on the current file'],
  ['c', 'Comment on the hovered line'],
  ['u', 'Toggle split / unified'],
  ['w', 'Toggle soft wrap of long lines'],
  ['s', 'Cycle scope (all / staged / unstaged)'],
  ['t', 'Filter files'],
  ['o', 'Collapse or expand the current file'],
  ['[', 'Toggle file tree'],
  [']', 'Toggle threads panel'],
  ['⌘↵', 'Submit a comment'],
  ['Esc', 'Cancel / close'],
  ['?', 'This sheet'],
];

export function ShortcutSheet() {
  useTopics('ui');
  if (!S.sheet) return null;
  const close = () => {
    S.sheet = false;
    emit('ui');
  };
  return (
    <div class="modal-bg" onClick={close}>
      <div class="modal" onClick={(e) => e.stopPropagation()}>
        <div class="panel-h">
          <b>Keyboard shortcuts</b>
          <span class="sp" />
          <button class="ib" onClick={close}>
            <Icon name="x" />
          </button>
        </div>
        <dl class="keys">
          {KEYS.map(([k, d]) => (
            <>
              <dt>
                {k.split(' / ').map((x, i) => (
                  <>
                    {i > 0 && ' '}
                    <kbd>{x}</kbd>
                  </>
                ))}
              </dt>
              <dd>{d}</dd>
            </>
          ))}
        </dl>
      </div>
    </div>
  );
}
