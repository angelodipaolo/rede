import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import type { ReviewSummary } from '../../../src/shared/types.ts';
import { api } from '../api.ts';
import { subscribe, useTopics } from '../bus.ts';
import { setObserverRoot } from '../io.ts';
import { installKeys } from '../keys.ts';
import { init, S } from '../store.ts';
import { captureReading, correctAnchor, layout, measureObserver, resetHeights, updateWindow, V } from '../vlist.ts';
import { relTime } from '../util.ts';
import { FileCard, updateAllOverflow } from './FileCard.tsx';
import { OrphanDrafts, OutdatedSection, ShortcutSheet, ThreadsPanel, Toasts } from './Panels.tsx';
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
  const files = S.files;
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
          <DiffList />
          <OutdatedSection />
          <OrphanDrafts />
          {S.files.length > 0 && <div class="tail">End of diff · {S.files.length} files</div>}
        </>
      )}
    </main>
  );
}

export function ReviewApp({ id }: { id: string }) {
  useTopics('layout');
  useEffect(() => {
    init(id);
    return installKeys();
  }, [id]);
  useEffect(() => {
    const r = S.review;
    document.title = r ? `${r.title} · ${r.repo.name} · Margin` : 'Margin';
  });
  return (
    <div class="app">
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
      .then((l) => {
        const sorted = [...l].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
        if (sorted.length === 1) location.replace(`/r/${encodeURIComponent(sorted[0]!.id)}`);
        else setList(sorted);
      })
      .catch((e: Error) => setErr(e.message));
  }, []);
  return (
    <div class="review-list">
      <h1>Margin</h1>
      {err && <p class="muted">Could not reach the Margin server: {err}</p>}
      {list && list.length === 0 && (
        <p class="muted">
          No reviews yet. Run <code>margin</code> inside a git repository to start one.
        </p>
      )}
      {list && list.length > 0 && (
        <ul>
          {list.map((r) => (
            <li key={r.id}>
              <a href={`/r/${encodeURIComponent(r.id)}`}>
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
