import { memo } from 'preact/compat';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { DiffFile } from '../../../src/shared/types.ts';
import { emit, useTopics } from '../bus.ts';
import { S, scrollToFile, setCollapsed, isCollapsed, setSidebar } from '../store.ts';
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
    if (n !== root && n.files.length === 0 && n.dirs.length === 1) {
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
  unread: boolean;
  active: boolean;
  flash: boolean;
  depth: number;
}

const FileRow = memo(function FileRow(p: RowProps) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (p.active && ref.current && !ref.current.closest('.tree:hover')) ref.current.scrollIntoView({ block: 'nearest' });
  }, [p.active]);
  return (
    <div
      ref={ref}
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
      {p.total > 0 && (
        <span class={`tcount${p.open ? ' open' : ''}`} title={`${p.open} unresolved of ${p.total}`}>
          {p.open || p.total}
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

export function Sidebar() {
  useTopics('files', 'tree', 'threads', 'progress', 'current', 'layout', 'filter');
  const [closedDirs, setClosedDirs] = useState<Set<string>>(new Set());
  const files = S.files;
  const q = S.filter.trim();
  const shown = useMemo(() => (q ? files.filter((f) => fuzzy(q, f.path) >= 0) : files), [files, q]);
  const tree = useMemo(() => buildTree(shown), [shown]);

  const counts = new Map<string, { total: number; open: number; unread: boolean }>();
  for (const t of S.threads.values()) {
    if (t.inScope === false) continue;
    const c = counts.get(t.anchor.path) ?? { total: 0, open: 0, unread: false };
    c.total++;
    if (!t.resolved) c.open++;
    if (S.unread.has(t.id)) c.unread = true;
    counts.set(t.anchor.path, c);
  }

  const rows: preact.ComponentChildren[] = [];
  const walk = (n: TNode, depth: number) => {
    for (const d of n.dirs) {
      const closed = !q && closedDirs.has(d.key);
      rows.push(
        <div
          key={`d:${d.key}`}
          class="td"
          style={{ paddingLeft: 8 + depth * 12 }}
          onClick={() => {
            const next = new Set(closedDirs);
            if (closed) next.delete(d.key);
            else next.add(d.key);
            setClosedDirs(next);
          }}
        >
          <Icon name={closed ? 'right' : 'downchev'} size={12} />
          <span class="dname">{d.name}</span>
        </div>,
      );
      if (!closed) walk(d, depth + 1);
    }
    for (const f of n.files) {
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
          unread={c?.unread ?? false}
          active={S.current === f.path}
          flash={S.flash.has(f.path)}
          depth={depth}
        />,
      );
    }
  };
  walk(tree, 0);

  if (S.sidebarHidden) return null;
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
            } else if (e.key === 'Enter' && shown[0]) {
              scrollToFile(shown[0].path);
              (e.target as HTMLInputElement).blur();
            }
          }}
        />
        {q && <span class="fcount">{shown.length}</span>}
      </div>
      <div class="tree">
        {rows}
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
