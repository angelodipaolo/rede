import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import type { ReviewSummary } from '../../../src/shared/types.ts';
import { api, reviewHref, workspace, wsHref } from '../api.ts';
import { Markdown } from '../markdown.tsx';
import { ackWhenSeen, openTab } from '../nav.ts';
import { Tabs } from './Tabs.tsx';
import { subscribe, useTopics } from '../bus.ts';
import { setObserverRoot } from '../io.ts';
import { installKeys } from '../keys.ts';
import { init, S, visibleFiles, showAllDirectories } from '../store.ts';
import { captureReading, correctAnchor, layout, measureObserver, resetHeights, updateWindow, V } from '../vlist.ts';
import { agentColorClass, relTime } from '../util.ts';
import { FileCard, updateAllOverflow } from './FileCard.tsx';
import { ArchivedLink, OrphanDrafts, OutdatedSection, ShortcutSheet, ThreadsPanel, Toasts } from './Panels.tsx';
import { Icon } from './Icon.tsx';
import { Sidebar } from './Sidebar.tsx';
import { TopBar } from './TopBar.tsx';

function EmptyState() {
  useTopics('review', 'conn');
  const scope = S.scope;
  const msg = scope === 'staged' ? 'Nothing staged.' : scope === 'unstaged' ? 'No unstaged changes.' : 'No changes.';
  return (
    <div class="empty">
      <div class="empty-mark" />
      <h2>{msg}</h2>
      <p>Waiting for changes… This view updates by itself when files change.</p>
    </div>
  );
}

function VItem({ path }: { path: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = ref.current!;
    const ro = measureObserver();
    ro.observe(el);
    return () => ro.unobserve(el);
  }, []);
  return (
    <div class="vitem" data-vpath={path} ref={ref}>
      <FileCard path={path} />
    </div>
  );
}

function DiffList() {
  useTopics('files', 'vwin', 'vspace');
  useLayoutEffect(() => correctAnchor());
  const files = visibleFiles();
  if (!files.length) return null;
  layout();
  const first = Math.min(V.first, files.length - 1);
  const last = Math.min(V.last, files.length - 1);
  const items = [];
  for (let i = first; i <= last; i++) items.push(<VItem key={files[i]!.path} path={files[i]!.path} />);
  return (
    <div class="vlist">
      <div style={{ height: V.tops[first] }} />
      {items}
      <div style={{ height: Math.max(0, V.total - V.tops[last + 1]!) }} />
    </div>
  );
}

function DiffColumn() {
  useTopics('files', 'review');
  const ref = useRef<HTMLDivElement>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const el = ref.current!;
    S.scroller = el;
    setObserverRoot(el);
    setReady(true);
    let raf = 0;
    const onScroll = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        captureReading();
        updateWindow();
      });
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    const onResize = () => {
      updateWindow();
      updateAllOverflow();
    };
    window.addEventListener('resize', onResize);
    const offView = subscribe('view', () => {
      resetHeights();
      updateWindow(true);
    });
    // Collapse/expand changes heights of files that may not be mounted.
    const offFiles = subscribe('files', () => requestAnimationFrame(() => updateWindow(true)));
    const offLayout = subscribe('layout', () => requestAnimationFrame(updateAllOverflow));
    return () => {
      el.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onResize);
      offView();
      offFiles();
      offLayout();
    };
  }, []);

  useLayoutEffect(() => {
    if (ready) updateWindow();
  });

  const r = S.review;
  return (
    <main class="diffcol" ref={ref}>
      {ready && (
        <>
          {S.loadError && !r && <div class="empty"><h2>Could not load the review</h2><p>{S.loadError}</p></div>}
          {!r && !S.loadError && <div class="empty"><p class="muted">Loading…</p></div>}
          {r && S.files.length === 0 && <EmptyState />}
          {r && S.files.length > 0 && visibleFiles().length === 0 && (
            <div class="empty">
              <h2>{visibleFiles(true).length ? 'All matching files are hidden.' : 'No files with comments in this scope.'}</h2>
              {S.hiddenDirs.size > 0 && <button class="btn" onClick={showAllDirectories}>Show all directories</button>}
              {S.commentedOnly && <p>Turn off “Files with comments” to see all changes.</p>}
            </div>
          )}
          {r && <SummaryBanner />}
          <DiffList />
          <OutdatedSection />
          <OrphanDrafts />
          {S.files.length > 0 && <div class="tail">End of diff · {visibleFiles().length} of {S.files.length} files</div>}
          <div class="tail-arch">
            <ArchivedLink tail />
          </div>
        </>
      )}
    </main>
  );
}

/** The agent's description of the change, shown above the diff. */
function SummaryBanner() {
  useTopics('review');
  const [open, setOpen] = useState(true);
  const r = S.review!;
  if (!r.summary) return null;
  const by = r.publishedBy;
  const agent = by?.kind === 'agent';
  return (
    <section class={`summary${agent ? ' ' + agentColorClass(by!.name) : ''}${open ? '' : ' closed'}`} aria-label="Change summary">
      <header onClick={() => setOpen(!open)}>
        <Icon name={open ? 'downchev' : 'right'} size={14} />
        <b>Summary</b>
        {by && (
          <span class={`summary-by${agent ? ' ' + agentColorClass(by.name) : ''}`}>
            by {agent ? by.name : 'you'}
            {agent && <span class="role">agent</span>}
          </span>
        )}
        {r.readyAt && (
          <span class="muted" title={new Date(r.readyAt).toLocaleString()}>
            ready for review {relTime(r.readyAt)}
          </span>
        )}
      </header>
      {open && <Markdown class="md summary-body" src={r.summary} />}
    </section>
  );
}

/** Keeps the tab of this review, named after its worktree, in the tab strip. */
function TabSync({ id }: { id: string }) {
  useTopics('review');
  const [info, setInfo] = useState<Awaited<ReturnType<typeof api.info>> | null>(null);
  useEffect(() => {
    void api.info().then(setInfo, () => {});
  }, [id]);
  const title = S.review?.title;
  useEffect(() => {
    if (info && title) openTab({ ws: info.workspace.id, id, title, wsName: info.workspace.name, repo: info.workspace.repo.name, branch: info.repo.branch });
  }, [info, title, id]);
  return null;
}

export function ReviewApp({ id }: { id: string }) {
  useTopics('layout');
  useEffect(() => {
    init(id);
    const offKeys = installKeys();
    const offAck = ackWhenSeen(workspace(), () => S.review);
    return () => {
      offKeys();
      offAck();
    };
  }, [id]);
  useEffect(() => {
    const r = S.review;
    document.title = r ? `${r.title} · ${r.repo.name} · Rede` : 'Rede';
  });
  return (
    <div class="app">
      <TabSync id={id} />
      <Tabs />
      <TopBar />
      <div class="body">
        <Sidebar />
        <DiffColumn />
        <ThreadsPanel />
      </div>
      <Toasts />
      <ShortcutSheet />
    </div>
  );
}

export function ReviewList() {
  const [list, setList] = useState<ReviewSummary[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    api
      .reviews()
      .then((l) => setList([...l].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))))
      .catch((e: Error) => setErr(e.message));
  }, []);
  return (
    <div class="review-list">
      <h1>Rede</h1>
      {err && <p class="muted">Could not reach the Rede server: {err}</p>}
      {list && list.length === 0 && (
        <p class="muted">
          No reviews yet. Run <code>rede</code> inside a git repository to start one.
        </p>
      )}
      {list && list.length > 0 && (
        <ul>
          <li>
            <a href={wsHref('/history')} class="rl-hist">
              <span class="rl-title">
                <Icon name="history" size={15} /> History
              </span>
              <span class="muted">Past reviews and threads of this repository, with the code they were about</span>
            </a>
          </li>
          {list.map((r) => (
            <li key={r.id}>
              <a href={reviewHref(workspace(), r.id)}>
                <span class="rl-title">{r.title}</span>
                <span class="muted">
                  {r.unresolvedCount} unresolved · {r.threadCount} threads · updated {relTime(r.updatedAt)}
                </span>
              </a>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
