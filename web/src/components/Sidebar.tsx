import { memo } from 'preact/compat';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { DiffFileMeta as DiffFile } from '../../../src/shared/types.ts';
import { emit, useTopics } from '../bus.ts';
import { S, scrollToFile, setCollapsed, isCollapsed, setSidebar, visibleFiles, setCommentedOnly, isDirectoryHidden, setDirectoryHidden, showAllDirectories } from '../store.ts';
import { fuzzy } from '../util.ts';
import { Icon } from './Icon.tsx';

interface TNode {
  name: string;
  key: string;
  dirs: TNode[];
  files: DiffFile[];
}

function buildTree(files: DiffFile[]): TNode {
  const root: TNode = { name: '', key: '', dirs: [], files: [] };
  const dirMap = new Map<string, TNode>([['', root]]);
  for (const f of files) {
    const parts = f.path.split('/');
    let node = root;
    let acc = '';
    for (let i = 0; i < parts.length - 1; i++) {
      acc = acc ? `${acc}/${parts[i]}` : parts[i]!;
      let next = dirMap.get(acc);
      if (!next) {
        next = { name: parts[i]!, key: acc, dirs: [], files: [] };
        dirMap.set(acc, next);
        node.dirs.push(next);
      }
      node = next;
    }
    node.files.push(f);
  }
  const compact = (n: TNode): TNode => {
    n.dirs = n.dirs.map(compact);
    if (n !== root && !S.hiddenDirs.has(n.key) && n.files.length === 0 && n.dirs.length === 1) {
      const only = n.dirs[0]!;
      return { name: `${n.name}/${only.name}`, key: only.key, dirs: only.dirs, files: only.files };
    }
    return n;
  };
  compact(root);
  const sort = (n: TNode) => {
    n.dirs.sort((a, b) => a.name.localeCompare(b.name));
    n.files.sort((a, b) => a.path.localeCompare(b.path));
    n.dirs.forEach(sort);
  };
  sort(root);
  return root;
}

interface RowProps {
  path: string;
  name: string;
  status: string;
  add: number;
  del: number;
  viewed: boolean;
  csv: boolean;
  total: number;
  open: number;
  /** Pending messages (review in progress) on this file. */
  pending: number;
  /** Threads that have only pending messages (not sent at all yet). */
  pendingOnly: number;
  unread: boolean;
  active: boolean;
  flash: boolean;
  depth: number;
}

const FileRow = memo(function FileRow(p: RowProps) {
  return (
    <div
      class={`tf${p.active ? ' active' : ''}${p.viewed ? ' viewed' : ''}${p.flash ? ' flash' : ''}`}
      style={{ paddingLeft: 8 + p.depth * 12 }}
      title={p.path}
      onClick={() => {
        const f = S.fileByPath.get(p.path);
        if (f && isCollapsed(f) && !f.viewed) setCollapsed(p.path, false);
        scrollToFile(p.path);
      }}
    >
      <span class={`tst st-${p.status}`}>{p.status[0]!.toUpperCase()}</span>
      <span class="tname">{p.name}</span>
      {p.csv && <span class="dot csv" title="Changed since you viewed it" />}
      {p.unread && <span class="dot unread" title="New agent reply" />}
      {p.pending > 0 && (
        <span class="tcount pending" title={`${p.pending} pending in your review (not sent yet)`}>
          {p.pending}
        </span>
      )}
      {p.total - p.pendingOnly > 0 && (
        <span class={`tcount${p.open ? ' open' : ''}`} title={`${p.open} unresolved of ${p.total - p.pendingOnly} sent threads`}>
          {p.open || p.total - p.pendingOnly}
        </span>
      )}
      <span class="tdelta">
        {p.add > 0 && <span class="plus">+{p.add}</span>}
        {p.del > 0 && <span class="minus">−{p.del}</span>}
      </span>
      <span class={`tview${p.viewed ? ' on' : ''}`}>{p.viewed && <Icon name="check" size={13} />}</span>
    </div>
  );
});

type Flat = { d: TNode; depth: number; closed: boolean } | { f: DiffFile; depth: number };

const ROW_H = 24;

export function Sidebar() {
  useTopics('files', 'tree', 'threads', 'progress', 'current', 'layout', 'filter');
  const [closedDirs, setClosedDirs] = useState<Set<string>>(new Set());
  const [scrollTop, setScrollTop] = useState(0);
  const [viewH, setViewH] = useState(800);
  const treeRef = useRef<HTMLDivElement>(null);
  // Keep hidden directory rows available so the reviewer can restore them.
  const files = visibleFiles(true);
  const q = S.filter.trim();
  const shown = useMemo(() => (q ? files.filter((f) => fuzzy(q, f.path) >= 0) : files), [files, q]);
  const tree = useMemo(() => buildTree(shown), [shown, S.hiddenDirs]);

  const flat = useMemo(() => {
    const out: Flat[] = [];
    const walk = (n: TNode, depth: number) => {
      for (const d of n.dirs) {
        const closed = isDirectoryHidden(d.key) || (!q && closedDirs.has(d.key));
        out.push({ d, depth, closed });
        if (!closed) walk(d, depth + 1);
      }
      for (const f of n.files) out.push({ f, depth });
    };
    walk(tree, 0);
    return out;
  }, [tree, closedDirs, q]);

  const activeIdx = useMemo(() => flat.findIndex((r) => 'f' in r && r.f.path === S.current), [flat, S.current]);

  useLayoutEffect(() => {
    const el = treeRef.current;
    if (!el) return;
    el.scrollTop = Math.min(el.scrollTop, Math.max(0, flat.length * ROW_H - el.clientHeight));
    setScrollTop(el.scrollTop);
  }, [flat]);

  // Keep the current file visible in the tree, unless the pointer is in the tree.
  useEffect(() => {
    const el = treeRef.current;
    if (!el || activeIdx < 0 || el.matches(':hover')) return;
    const y = activeIdx * ROW_H;
    if (y < el.scrollTop) el.scrollTop = y;
    else if (y + ROW_H > el.scrollTop + el.clientHeight) el.scrollTop = y + ROW_H - el.clientHeight;
  }, [activeIdx]);

  useEffect(() => {
    const el = treeRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setViewH(el.clientHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, [S.sidebarHidden]);

  if (S.sidebarHidden) return null;

  const counts = new Map<string, { total: number; open: number; pending: number; pendingOnly: number; unread: boolean }>();
  for (const t of S.threads.values()) {
    if (!t.inScope) continue;
    const c = counts.get(t.anchor.path) ?? { total: 0, open: 0, pending: 0, pendingOnly: 0, unread: false };
    c.total++;
    let p = 0;
    for (const m of t.messages) if (m.pending) p++;
    c.pending += p;
    const onlyPending = p === t.messages.length;
    if (onlyPending) c.pendingOnly++;
    else if (!t.resolved) c.open++;
    if (S.unread.has(t.id)) c.unread = true;
    counts.set(t.anchor.path, c);
  }

  const start = Math.max(0, Math.floor(scrollTop / ROW_H) - 15);
  const end = Math.min(flat.length, Math.ceil((scrollTop + viewH) / ROW_H) + 15);
  const rows: preact.ComponentChildren[] = [];
  for (let i = start; i < end; i++) {
    const r = flat[i]!;
    if ('d' in r) {
      const d = r.d;
      const hidden = isDirectoryHidden(d.key);
      const partial = !hidden && [...S.hiddenDirs].some((path) => path.startsWith(`${d.key}/`));
      rows.push(
        <div
          key={`d:${d.key}`}
          class={`td${hidden ? ' hidden-dir' : ''}`}
          style={{ paddingLeft: 8 + r.depth * 12 }}
          onClick={() => {
            if (hidden) return;
            const next = new Set(closedDirs);
            if (r.closed) next.delete(d.key);
            else next.add(d.key);
            setClosedDirs(next);
          }}
        >
          <Icon name={r.closed ? 'right' : 'downchev'} size={12} />
          <span class="dname">{d.name}</span>
          {hidden && <span class="dir-hidden-label">Hidden</span>}
          <input
            class="dir-visibility"
            type="checkbox"
            checked={!hidden && !partial}
            ref={(el) => { if (el) el.indeterminate = partial; }}
            aria-label={`Show ${d.key} in diff`}
            title={hidden ? 'Show directory in diff' : partial ? 'Show all files in directory' : 'Hide directory from diff'}
            onClick={(e) => e.stopPropagation()}
            onChange={(e) => setDirectoryHidden(d.key, !e.currentTarget.checked)}
          />
        </div>,
      );
    } else {
      const f = r.f;
      const c = counts.get(f.path);
      rows.push(
        <FileRow
          key={`f:${f.path}`}
          path={f.path}
          name={f.path.slice(f.path.lastIndexOf('/') + 1)}
          status={f.status}
          add={f.additions}
          del={f.deletions}
          viewed={f.viewed}
          csv={f.changedSinceViewed}
          total={c?.total ?? 0}
          open={c?.open ?? 0}
          pending={c?.pending ?? 0}
          pendingOnly={c?.pendingOnly ?? 0}
          unread={c?.unread ?? false}
          active={i === activeIdx}
          flash={S.flash.has(f.path)}
          depth={r.depth}
        />,
      );
    }
  }

  return (
    <aside class="sidebar" style={{ width: S.sidebarW }}>
      <div class="filter">
        <Icon name="search" size={14} />
        <input
          id="file-filter"
          type="text"
          placeholder="Filter files (t)"
          value={S.filter}
          spellcheck={false}
          autocomplete="off"
          onInput={(e) => {
            S.filter = (e.target as HTMLInputElement).value;
            emit('filter');
          }}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              S.filter = '';
              emit('filter');
              (e.target as HTMLInputElement).blur();
            } else if (e.key === 'Enter' && shown.some((f) => !isDirectoryHidden(f.path))) {
              scrollToFile(shown.find((f) => !isDirectoryHidden(f.path))!.path);
              (e.target as HTMLInputElement).blur();
            }
          }}
        />
        {q && <span class="fcount">{shown.length}</span>}
      </div>
      <label class="comment-filter">
        <input type="checkbox" checked={S.commentedOnly} onChange={(e) => setCommentedOnly(e.currentTarget.checked)} />
        <span>Files with comments</span>
        <span class="fcount">{visibleFiles().length} of {S.files.length}</span>
      </label>
      {S.hiddenDirs.size > 0 && (
        <div class="hidden-dirs-summary">
          <span>{S.hiddenDirs.size} {S.hiddenDirs.size === 1 ? 'directory' : 'directories'} hidden</span>
          <button class="btn sm ghost" onClick={showAllDirectories}>Show all</button>
        </div>
      )}
      <div
        class="tree"
        ref={treeRef}
        onScroll={(e) => {
          const t = (e.target as HTMLElement).scrollTop;
          if (Math.abs(t - scrollTop) >= ROW_H * 5) setScrollTop(t);
        }}
      >
        <div style={{ height: flat.length * ROW_H, position: 'relative' }}>
          <div style={{ position: 'absolute', top: start * ROW_H, left: 0, right: 0 }}>{rows}</div>
        </div>
        {S.commentedOnly && files.length === 0 && <div class="tree-empty">No files with comments in this scope.</div>}
        {files.length > 0 && shown.length === 0 && <div class="tree-empty">No file matches “{q}”.</div>}
      </div>
      <Resizer />
    </aside>
  );
}

function Resizer() {
  return (
    <div
      class="resizer"
      onMouseDown={(e) => {
        e.preventDefault();
        const startX = e.clientX;
        const startW = S.sidebarW;
        document.body.classList.add('resizing');
        const move = (ev: MouseEvent) => setSidebar(startW + ev.clientX - startX);
        const up = () => {
          document.body.classList.remove('resizing');
          document.removeEventListener('mousemove', move);
          document.removeEventListener('mouseup', up);
        };
        document.addEventListener('mousemove', move);
        document.addEventListener('mouseup', up);
      }}
      onDblClick={() => setSidebar(280)}
    />
  );
}
