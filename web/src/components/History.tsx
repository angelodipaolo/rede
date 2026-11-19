import { memo } from 'preact/compat';
import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import type { HistoryEntry, ReviewSummary, Thread } from '../../../src/shared/types.ts';
import { entryMarkdown, threadLocation } from '../../../src/shared/history-md.ts';
import { api, reviewHref, workspace } from '../api.ts';
import { useTopics } from '../bus.ts';
import { Markdown } from '../markdown.tsx';
import { applyTheme, cycleTheme, HUMAN, S } from '../store.ts';
import { agentColorClass, copyText, isTyping, relTime } from '../util.ts';
import { Icon } from './Icon.tsx';
import { OriginalCode, OutdatedNote } from './Original.tsx';
import { Avatar } from './Thread.tsx';

type StateF = 'all' | 'open' | 'resolved';
type ModeF = '' | 'ask' | 'discuss' | 'implement';
interface Filters {
  q: string;
  review: string;
  state: StateF;
  mode: ModeF;
}

const PAGE = 50;

function readFilters(): Filters {
  const p = new URLSearchParams(location.search);
  const state = p.get('state');
  const mode = p.get('mode');
  return {
    q: p.get('q') ?? '',
    review: p.get('review') ?? '',
    state: state === 'open' || state === 'resolved' ? state : 'all',
    mode: mode === 'ask' || mode === 'discuss' || mode === 'implement' ? mode : '',
  };
}

function writeFilters(f: Filters) {
  const u = new URL(location.href);
  for (const [k, v] of Object.entries(f)) {
    if (v && v !== 'all') u.searchParams.set(k, v);
    else u.searchParams.delete(k);
  }
  history.replaceState(null, '', u);
}

const keyOf = (e: HistoryEntry) => (e.kind === 'batch' ? `b${e.batch.id}` : `t${e.thread.id}`);

function dayLabel(iso: string, now = new Date()): string {
  const d = new Date(iso);
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((day(now) - day(d)) / 86_400_000);
  const date = d.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric', year: d.getFullYear() === now.getFullYear() ? undefined : 'numeric' });
  if (diff === 0) return `Today · ${date}`;
  if (diff === 1) return `Yesterday · ${date}`;
  return date;
}

const timeOf = (iso: string) => new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });

function diffHref(t: Thread): string {
  const scope = t.homeScope !== 'all' ? `?scope=${t.homeScope}` : '';
  return `${reviewHref(workspace(), t.reviewId)}${scope}#thread-${t.id}`;
}

function StateChips({ t }: { t: Thread }) {
  const pending = t.messages.some((m) => m.pending);
  return (
    <>
      {t.resolved ? (
        <span class="badge ok">
          <Icon name="check" size={11} /> Resolved
        </span>
      ) : (
        <span class="badge open">Open</span>
      )}
      {t.outdated && <span class="badge outdated">{t.outdatedReason === 'file-gone' ? 'File not in diff' : 'Outdated'}</span>}
      {!t.resolved && !t.noteOnly && t.agentState === 'pending' && <span class="badge waiting">Waiting for agent</span>}
      {!t.resolved && t.agentState === 'working' && <span class="badge waiting">{t.claimedBy ?? 'Agent'} working</span>}
      {pending && <span class="badge pending">Pending reply</span>}
      {t.noteOnly && <span class="badge note">Note</span>}
    </>
  );
}

function HistMessage({ m }: { m: Thread['messages'][number] }) {
  const agent = m.author.kind === 'agent';
  return (
    <div class={`msg ${agent ? 'msg-a ' + agentColorClass(m.author.name) : 'msg-h'}${m.pending ? ' msg-p' : ''}`}>
      <Avatar kind={m.author.kind} name={m.author.name} />
      <div class="msg-main">
        <div class="msg-head">
          <span class="who">{agent ? m.author.name : m.author.name === 'you' ? 'You' : m.author.name}</span>
          <span class="role">{agent ? 'agent' : 'reviewer'}</span>
          {m.pending && <span class="badge pending">Pending</span>}
          <time title={new Date(m.createdAt).toLocaleString()}>{relTime(m.createdAt)}</time>
          {m.editedAt && <span class="edited">edited</span>}
        </div>
        <Markdown src={m.body} class="msg-body" />
      </div>
    </div>
  );
}

/** One thread in History: location, state, original code, the whole conversation, reply and resolve. */
function HistThread({ t, onChange }: { t: Thread; onChange: (t: Thread) => void }) {
  const [showCode, setShowCode] = useState(!t.resolved);
  const [replying, setReplying] = useState(false);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const hasCode = (t.original?.lines.length ?? 0) > 0 || t.snippet.length > 0;
  const taRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (replying) taRef.current?.focus();
  }, [replying]);
  const run = async (p: Promise<Thread>) => {
    setBusy(true);
    setErr(null);
    try {
      onChange(await p);
      return true;
    } catch (e) {
      setErr((e as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  };
  const send = async () => {
    if (!text.trim()) return;
    if (await run(api.addMessage(t.id, t.homeScope, { body: text, author: HUMAN }))) {
      setText('');
      setReplying(false);
    }
  };
  return (
    <div class={`thread hthread${t.noteOnly ? ' note' : ''}`} data-thread={t.id}>
      <div class="th-head">
        <span class="hloc" title={threadLocation(t)}>
          {threadLocation(t)}
        </span>
        <StateChips t={t} />
        <span class="sp" />
        <span class="th-id">#{t.id}</span>
        {t.archived ? (
          <span class="hro" title="Resolved, and its code is no longer in the diff. Reply or unresolve to bring it back to the diff view.">
            Only in History
          </span>
        ) : (
          <a class="btn sm ghost" href={diffHref(t)} title="Show this thread in the current diff">
            Open in diff
          </a>
        )}
        <button class="btn sm" disabled={busy} onClick={() => void run(api.updateThread(t.id, t.homeScope, { resolved: !t.resolved }))}>
          {t.resolved ? 'Unresolve' : 'Resolve'}
        </button>
      </div>
      <OutdatedNote t={t} />
      {hasCode &&
        (showCode ? (
          <OriginalCode t={t} />
        ) : (
          <button class="orig-toggle" onClick={() => setShowCode(true)}>
            <Icon name="right" size={12} /> Show the code it was written on
          </button>
        ))}
      <div class="msgs">
        {t.messages.map((m) => (
          <HistMessage key={m.id} m={m} />
        ))}
      </div>
      {err && <div class="herr">{err}</div>}
      {replying ? (
        <div class="reply-wrap">
          <div class="composer">
            <textarea
              value={text}
              disabled={busy}
              placeholder={t.resolved ? 'Reply. It reopens the thread and sends it to the agent.' : 'Reply. The agent gets it at once.'}
              ref={taRef}
              onInput={(e) => setText((e.target as HTMLTextAreaElement).value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  void send();
                } else if (e.key === 'Escape') {
                  e.preventDefault();
                  e.stopPropagation();
                  setReplying(false);
                }
              }}
            />
            <div class="cmp-bar">
              <span class="cmp-hint">⌘↵ Send · Esc cancels</span>
              <span class="sp" />
              <button class="btn sm ghost" disabled={busy} onClick={() => setReplying(false)}>
                Cancel
              </button>
              <button class="btn sm primary" disabled={busy || !text.trim()} onClick={() => void send()}>
                Send
              </button>
            </div>
          </div>
        </div>
      ) : (
        <button class="reply-fake" onClick={() => setReplying(true)}>
          <Icon name="reply" size={14} /> {t.resolved ? 'Reply (reopens the thread)…' : 'Reply…'}
        </button>
      )}
    </div>
  );
}

function CopyMd({ e }: { e: HistoryEntry }) {
  const [ok, setOk] = useState(false);
  return (
    <button
      class="btn sm ghost"
      title="Copy this entry as Markdown"
      onClick={(ev) => {
        ev.stopPropagation();
        void copyText(entryMarkdown(e)).then(() => {
          setOk(true);
          setTimeout(() => setOk(false), 1400);
        });
      }}
    >
      <Icon name={ok ? 'check' : 'copy'} size={13} /> {ok ? 'Copied' : 'Copy as Markdown'}
    </button>
  );
}

const MODE = { ask: 'Ask', discuss: 'Discuss', implement: 'Implement' } as const;

function firstLine(s: string): string {
  return s.replace(/[#*`>_]/g, '').trim().split('\n')[0] ?? '';
}

/** Memoized: appending a page re-renders only the new entries, not the whole list. */
const EntryRow = memo(function EntryRow({ e, open, onToggle, onThread }: { e: HistoryEntry; open: boolean; onToggle: (k: string) => void; onThread: (t: Thread) => void }) {
  const toggle = () => onToggle(keyOf(e));
  const head =
    e.kind === 'batch' ? (
      <>
        <span class={`badge mode-${e.batch.mode}`}>{MODE[e.batch.mode]}</span>
        <b class="he-title">Review #{e.batch.id}</b>
        <span class="he-rev">{e.review.title}</span>
        {(e.batch.branch || e.batch.head) && (
          <span class="he-git" title={e.batch.head ?? ''}>
            {e.batch.branch ?? 'detached'}
            {e.batch.head ? ` · ${e.batch.head.slice(0, 7)}` : ''}
          </span>
        )}
      </>
    ) : (
      <>
        <span class="badge">{e.thread.noteOnly ? 'Note' : e.thread.messages[0]?.author.kind === 'agent' ? 'Agent finding' : 'Comment'}</span>
        <b class="he-title he-loc">{threadLocation(e.thread)}</b>
        <span class="he-rev">{e.review.title}</span>
      </>
    );
  const sub =
    e.kind === 'batch' ? (
      <>
        <span class="he-txt">{open ? null : e.batch.body ? `“${firstLine(e.batch.body)}”` : <span class="muted">No overall note</span>}</span>
        <span class="he-n">
          {e.counts.threads} {e.counts.threads === 1 ? 'thread' : 'threads'} · {e.counts.answered} answered · {e.counts.resolved} resolved
        </span>
      </>
    ) : (
      <>
        <span class="he-txt">{firstLine(e.thread.messages[0]?.body ?? '')}</span>
        <span class="he-n he-chips">
          <StateChips t={e.thread} />
          <span>
            {e.thread.messages.length} {e.thread.messages.length === 1 ? 'message' : 'messages'}
          </span>
        </span>
      </>
    );
  return (
    <section class={`hentry${open ? ' open' : ''}`}>
      <div
        class="he-row"
        role="button"
        tabIndex={0}
        aria-expanded={open}
        onClick={toggle}
        onKeyDown={(ev) => {
          if (ev.key === 'Enter' || ev.key === ' ') {
            ev.preventDefault();
            toggle();
          }
        }}
      >
        <span class="he-chev">
          <Icon name={open ? 'downchev' : 'right'} size={14} />
        </span>
        <div class="he-main">
          <div class="he-top">
            {head}
            <span class="sp" />
            <time class="he-time" title={new Date(e.at).toLocaleString()}>
              {timeOf(e.at)}
            </time>
          </div>
          <div class="he-sub">{sub}</div>
        </div>
      </div>
      {open && (
        <div class="he-body">
          <div class="he-acts">
            {e.kind === 'batch' && e.batch.body && <Markdown src={e.batch.body} class="he-note msg-body" />}
            <span class="sp" />
            <CopyMd e={e} />
          </div>
          {e.kind === 'batch' ? (
            e.threads.length ? (
              e.threads.map((t) => <HistThread key={t.id} t={t} onChange={onThread} />)
            ) : (
              <p class="muted small">No thread of this review matches the filters.</p>
            )
          ) : (
            <HistThread t={e.thread} onChange={onThread} />
          )}
        </div>
      )}
    </section>
  );
});

function Seg<T extends string>({ value, options, onChange, label }: { value: T; options: [T, string][]; onChange: (v: T) => void; label: string }) {
  return (
    <div class="seg" role="radiogroup" aria-label={label}>
      {options.map(([v, l]) => (
        <button key={v} role="radio" aria-checked={value === v} class={value === v ? 'on' : ''} onClick={() => onChange(v)}>
          {l}
        </button>
      ))}
    </div>
  );
}

export function HistoryApp() {
  useTopics('ui');
  const [filters, setFilters] = useState<Filters>(readFilters);
  const [qText, setQText] = useState(filters.q);
  const [entries, setEntries] = useState<HistoryEntry[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [total, setTotal] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [reviews, setReviews] = useState<ReviewSummary[]>([]);
  const [repo, setRepo] = useState('');
  const seq = useRef(0);
  const scRef = useRef<HTMLDivElement>(null);
  const sentinel = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const from = new URLSearchParams(location.search).get('from');

  useEffect(() => {
    applyTheme();
    document.title = 'History · Rede';
    api.reviews().then(setReviews, () => {});
    api.info().then((h) => {
      setRepo(h.repo.name);
      document.title = `History · ${h.repo.name} · Rede`;
    }, () => {});
    const onKey = (e: KeyboardEvent) => {
      if (isTyping(e) || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === '/') {
        e.preventDefault();
        searchRef.current?.focus();
      } else if (e.key === 'h') {
        location.href = from ? reviewHref(workspace(), from) : '/';
      } else if (e.key === 't') {
        cycleTheme();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const load = async (reset: boolean) => {
    const my = ++seq.current;
    setLoading(true);
    setErr(null);
    try {
      const page = await api.history({ q: filters.q, review: filters.review, state: filters.state, mode: filters.mode, before: reset ? undefined : (next ?? undefined), limit: PAGE });
      if (my !== seq.current) return;
      setEntries((prev) => (reset ? page.entries : [...prev, ...page.entries]));
      setNext(page.next);
      setTotal(page.total);
    } catch (e) {
      if (my === seq.current) setErr((e as Error).message);
    } finally {
      if (my === seq.current) setLoading(false);
    }
  };

  useEffect(() => {
    writeFilters(filters);
    if (scRef.current) scRef.current.scrollTop = 0;
    void load(true);
  }, [filters.q, filters.review, filters.state, filters.mode]);

  // Search as you type, a moment after the last key.
  useEffect(() => {
    if (qText === filters.q) return;
    const t = setTimeout(() => setFilters((f) => ({ ...f, q: qText })), 200);
    return () => clearTimeout(t);
  }, [qText]);

  // Next page when the end of the list comes near.
  useEffect(() => {
    const el = sentinel.current;
    if (!el || !next || loading) return;
    const io = new IntersectionObserver((es) => es[0]?.isIntersecting && void load(false), { root: scRef.current, rootMargin: '800px' });
    io.observe(el);
    return () => io.disconnect();
  }, [next, loading, entries.length]);

  const toggle = useCallback(
    (k: string) =>
      setOpen((s) => {
        const n = new Set(s);
        if (n.has(k)) n.delete(k);
        else n.add(k);
        return n;
      }),
    [],
  );
  const onThread = useCallback(
    (t: Thread) =>
      setEntries((es) =>
        es.map((e) => (e.kind === 'thread' ? (e.thread.id === t.id ? { ...e, thread: t } : e) : e.threads.some((x) => x.id === t.id) ? { ...e, threads: e.threads.map((x) => (x.id === t.id ? t : x)) } : e)),
      ),
    [],
  );

  const dark = S.theme === 'dark' || (S.theme === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
  const groups: { label: string; items: HistoryEntry[] }[] = [];
  for (const e of entries) {
    const label = dayLabel(e.at);
    const g = groups[groups.length - 1];
    if (g && g.label === label) g.items.push(e);
    else groups.push({ label, items: [e] });
  }
  const filtered = !!(filters.q || filters.review || filters.state !== 'all' || filters.mode);

  return (
    <div class="hist-app">
      <header class="topbar">
        <a class="ib" href={from ? reviewHref(workspace(), from) : '/'} title={from ? 'Back to the review (h)' : 'All reviews (h)'} aria-label="Back">
          <Icon name="back" />
        </a>
        <div class="ident">
          <a class="repo" href="/">
            {repo || 'Rede'}
          </a>
          <span class="title">
            <Icon name="history" size={14} /> History
          </span>
        </div>
        <span class="sp" />
        <button class="ib" title={dark ? 'Light theme (t)' : 'Dark theme (t)'} onClick={cycleTheme}>
          <Icon name={dark ? 'sun' : 'moon'} />
        </button>
      </header>
      <div class="hist-scroll" ref={scRef}>
        <div class="hist-wrap">
          <div class="hist-filters">
            <label class="hsearch">
              <Icon name="search" size={14} />
              <input
                ref={searchRef}
                type="search"
                placeholder="Search comments and file paths  ( / )"
                value={qText}
                onInput={(e) => setQText((e.target as HTMLInputElement).value)}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') (e.target as HTMLInputElement).blur();
                }}
              />
            </label>
            <select
              class="hselect"
              aria-label="Review"
              value={filters.review}
              onChange={(e) => setFilters((f) => ({ ...f, review: (e.target as HTMLSelectElement).value }))}
            >
              <option value="">All reviews</option>
              {reviews.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.title}
                </option>
              ))}
            </select>
            <Seg<StateF>
              label="State"
              value={filters.state}
              options={[
                ['all', 'All'],
                ['open', 'Open'],
                ['resolved', 'Resolved'],
              ]}
              onChange={(v) => setFilters((f) => ({ ...f, state: v }))}
            />
            <Seg<ModeF>
              label="Mode"
              value={filters.mode}
              options={[
                ['', 'Any mode'],
                ['ask', 'Ask'],
                ['discuss', 'Discuss'],
                ['implement', 'Implement'],
              ]}
              onChange={(v) => setFilters((f) => ({ ...f, mode: v }))}
            />
          </div>
          <div class="hist-meta">
            <span>
              {total === null ? 'Loading…' : `${total} ${total === 1 ? 'entry' : 'entries'}${filtered ? ' match' : ''}`}
              {filtered && (
                <>
                  {' · '}
                  <button
                    class="link"
                    onClick={() => {
                      setQText('');
                      setFilters({ q: '', review: '', state: 'all', mode: '' });
                    }}
                  >
                    Clear filters
                  </button>
                </>
              )}
            </span>
            <span class="sp" />
            <span class="muted" title="Nothing is ever deleted automatically.">
              Resolved threads whose code changed leave the diff view and stay here.
            </span>
          </div>
          {err && <div class="herr">Could not load the history: {err}</div>}
          {total === 0 && !loading && (
            <div class="empty hist-empty">
              <h2>{filtered ? 'Nothing matches these filters.' : 'No history yet.'}</h2>
              <p>{filtered ? 'Try fewer words or another state.' : 'Submitted reviews and comments show up here.'}</p>
            </div>
          )}
          {groups.map((g) => (
            <div class="hday" key={g.label}>
              <h3 class="hday-h">{g.label}</h3>
              {g.items.map((e) => {
                const k = keyOf(e);
                return <EntryRow key={k} e={e} open={open.has(k)} onToggle={toggle} onThread={onThread} />;
              })}
            </div>
          ))}
          <div ref={sentinel} class="hist-end">
            {loading ? 'Loading…' : next ? (
              <button class="btn sm" onClick={() => void load(false)}>
                Load more
              </button>
            ) : entries.length > 0 ? (
              'End of history'
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}
