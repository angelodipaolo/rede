import { useEffect, useRef, useState } from 'preact/hooks';
import type { ReviewSummary } from '../../../src/shared/types.ts';
import { api } from '../api.ts';
import { useTopics } from '../bus.ts';
import { setObserverRoot } from '../io.ts';
import { installKeys } from '../keys.ts';
import { init, S, setCurrent } from '../store.ts';
import { relTime } from '../util.ts';
import { FileCard } from './FileCard.tsx';
import { OutdatedSection, ShortcutSheet, ThreadsPanel, Toasts } from './Panels.tsx';
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
        const r = el.getBoundingClientRect();
        const hit = document.elementFromPoint(r.left + Math.min(200, r.width / 2), r.top + 8) as HTMLElement | null;
        const card = hit?.closest<HTMLElement>('[data-path]');
        if (card) setCurrent(card.dataset.path!);
      });
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    onScroll();
    return () => el.removeEventListener('scroll', onScroll);
  }, []);

  const r = S.review;
  return (
    <main class="diffcol" ref={ref}>
      {ready && (
        <>
          {S.loadError && !r && <div class="empty"><h2>Could not load the review</h2><p>{S.loadError}</p></div>}
          {!r && !S.loadError && <div class="empty"><p class="muted">Loading…</p></div>}
          <OutdatedSection />
          {r && S.files.length === 0 && <EmptyState />}
          {S.files.map((f) => (
            <FileCard key={f.path} path={f.path} />
          ))}
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
