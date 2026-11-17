import { memo } from 'preact/compat';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { DiffFileMeta, Side, Thread } from '../../../src/shared/types.ts';
import { emit, useTopics } from '../bus.ts';
import { escapeHtml, markRanges } from '../htmlLines.ts';
import { nearViewport, observe } from '../io.ts';
import { estimate, settleSoon } from '../vlist.ts';
import {
  buildModel,
  CHUNK,
  isGap,
  lineTarget,
  ROW_H,
  wordRanges,
  type DLine,
  type GapRow,
  type Pin,
  type Row,
  type SRow,
  type URow,
} from '../model.ts';
import {
  commentOn,
  commentOnFile,
  ensureContent,
  expandGap,
  fileTopic,
  getContent,
  getDiff,
  getExpansion,
  getStaleDiff,
  releaseContent,
  requestHunks,
  getSince,
  isCollapsed,
  S,
  setCollapsed,
  setSelection,
  setViewed,
  showSince,
  type ComposerState,
  type Content,
} from '../store.ts';
import { copyText } from '../util.ts';
import { Composer, ThreadView } from './Thread.tsx';
import { Icon } from './Icon.tsx';

// ------------------------------------------------------------------ line html

function lineHtml(d: DLine, c: Content | undefined, snapshotOld: boolean): string {
  let base: string | null = null;
  if (c) {
    if (d.type === 'del') {
      if (!snapshotOld && c.oldHl && c.old && d.o && c.old[d.o - 1] === d.text) base = c.oldHl[d.o - 1]!;
    } else if (c.newHl && c.new && d.n && c.new[d.n - 1] === d.text) base = c.newHl[d.n - 1]!;
    else if (d.type === 'context' && !snapshotOld && c.oldHl && c.old && d.o && c.old[d.o - 1] === d.text)
      base = c.oldHl[d.o - 1]!;
  }
  if (base === null) base = escapeHtml(d.text);
  if (d.pair) {
    const wd = wordRanges(d);
    if (wd && wd.length) base = markRanges(base, wd);
  }
  return base;
}

const CLS: Record<string, string> = { add: 'a', del: 'd', context: 'x' };

function cellHtml(d: DLine | null, side: Side, c: Content | undefined, tint: Set<string>, snap: boolean): string {
  if (!d) return '<div class="r e"></div>';
  const ln = side === 'old' ? d.o : d.n;
  const k = (side === 'old' ? 'o' : 'n') + ln;
  const cls = `r ${CLS[d.type]}${d.exp ? ' xp' : ''}${tint.has(k) ? ' tn' : ''}`;
  const canComment = !(snap && side === 'old');
  return `<div class="${cls}" data-k="${k}" data-side="${side}" data-line="${ln}"><span class="ln${canComment ? ' cm' : ''}">${ln}</span><span class="mk">${d.type === 'add' ? '+' : d.type === 'del' ? '−' : ''}</span><span class="c">${lineHtml(d, c, snap)}</span></div>`;
}

function unifiedHtml(d: DLine, c: Content | undefined, tint: Set<string>, snap: boolean): string {
  const t = lineTarget(d);
  const k = t ? (t.side === 'old' ? 'o' : 'n') + t.line : '';
  const cls = `r ${CLS[d.type]}${d.exp ? ' xp' : ''}${tint.has(k) ? ' tn' : ''}`;
  const canComment = t && !(snap && t.side === 'old');
  return `<div class="${cls}" data-k="${k}" data-side="${t?.side ?? ''}" data-line="${t?.line ?? ''}"><span class="ln lo${canComment && t!.side === 'old' ? ' cm' : ''}">${d.o ?? ''}</span><span class="ln ln2${canComment && t!.side === 'new' ? ' cm' : ''}">${d.n ?? ''}</span><span class="mk">${d.type === 'add' ? '+' : d.type === 'del' ? '−' : ''}</span><span class="c">${lineHtml(d, c, snap)}</span></div>`;
}

// ------------------------------------------------------------------ horizontal scroll sync

const panes = new Map<string, Set<HTMLElement>>();
const paneLeft = new Map<string, number>();
let syncing = false;

function registerPane(key: string, el: HTMLElement) {
  let set = panes.get(key);
  if (!set) panes.set(key, (set = new Set()));
  set.add(el);
  const left = paneLeft.get(key);
  if (left) el.scrollLeft = left;
  let raf = 0;
  const onScroll = () => {
    if (!raf)
      raf = requestAnimationFrame(() => {
        raf = 0;
        updateOverflow(el.parentElement);
      });
    if (syncing) return;
    syncing = true;
    paneLeft.set(key, el.scrollLeft);
    for (const other of set!) if (other !== el && other.scrollLeft !== el.scrollLeft) other.scrollLeft = el.scrollLeft;
    syncing = false;
  };
  el.addEventListener('scroll', onScroll, { passive: true });
  return () => {
    el.removeEventListener('scroll', onScroll);
    set!.delete(el);
  };
}

/**
 * No-wrap mode: marks rows whose text runs past the right edge of their pane. CSS shows a
 * sticky arrow at the edge of those rows, so cut-off lines are visible at a glance.
 */
export function updateOverflow(chunk: HTMLElement | null) {
  if (!chunk || !chunk.classList.contains('nw') || !chunk.isConnected) return;
  const panes = chunk.querySelectorAll<HTMLElement>(':scope > .pane');
  const marks: [Element, boolean][] = [];
  panes.forEach((p) => {
    if (p.scrollWidth <= p.clientWidth + 1 && !p.querySelector('.r.long')) return;
    const right = p.getBoundingClientRect().right;
    for (const c of p.querySelectorAll('.c')) marks.push([c.parentElement!, c.getBoundingClientRect().right - 20 > right]);
  });
  for (const [r, on] of marks) if (r.classList.contains('long') !== on) r.classList.toggle('long', on);
}

export function updateAllOverflow() {
  S.scroller?.querySelectorAll<HTMLElement>('.chunk.nw').forEach(updateOverflow);
}

// ------------------------------------------------------------------ chunk

interface ChunkProps {
  path: string;
  rows: Row[];
  start: number;
  end: number;
  view: 'split' | 'unified';
  wrap: boolean;
  content: Content | undefined;
  ver: number;
  tint: Set<string>;
  tintKey: string;
  snap: boolean;
}

const Chunk = memo(
  function Chunk(p: ChunkProps) {
    const ref = useRef<HTMLDivElement>(null);
    const [visible, setVisible] = useState(false);
    /** Last rendered height. Wrapped rows are taller than ROW_H; placeholders keep the real height. */
    const lastH = useRef<number | null>(null);
    useLayoutEffect(() => {
      const el = ref.current!;
      if (nearViewport(el, 1200)) setVisible(true);
      return observe(el, '1200px 0px', (v) => {
        if (!v && ref.current) lastH.current = ref.current.offsetHeight;
        setVisible(v);
      });
    }, []);
    useLayoutEffect(() => {
      lastH.current = null;
    }, [p.view, p.wrap]);
    const height = (p.end - p.start) * ROW_H;
    const html = useMemo(() => {
      if (!visible) return null;
      if (p.view === 'split' && p.wrap) {
        // One grid: each left cell sits beside its right cell, so wrapped rows keep the same height.
        let g = '';
        for (let i = p.start; i < p.end; i++) {
          const row = p.rows[i] as SRow;
          if (isGap(row)) continue;
          g += cellHtml(row.l, 'old', p.content, p.tint, p.snap) + cellHtml(row.r, 'new', p.content, p.tint, p.snap);
        }
        return [g];
      }
      if (p.view === 'split') {
        let l = '';
        let r = '';
        for (let i = p.start; i < p.end; i++) {
          const row = p.rows[i] as SRow;
          if (isGap(row)) continue;
          l += cellHtml(row.l, 'old', p.content, p.tint, p.snap);
          r += cellHtml(row.r, 'new', p.content, p.tint, p.snap);
        }
        return [l, r];
      }
      let u = '';
      for (let i = p.start; i < p.end; i++) {
        const row = p.rows[i] as URow;
        if (!isGap(row)) u += unifiedHtml(row, p.content, p.tint, p.snap);
      }
      return [u];
    }, [visible, p.rows, p.start, p.end, p.view, p.wrap, p.ver, p.tintKey, p.snap]);
    const leftRef = useRef<HTMLDivElement>(null);
    const rightRef = useRef<HTMLDivElement>(null);
    useLayoutEffect(() => settleSoon(), [html]);
    useLayoutEffect(() => {
      if (!html || p.wrap) return;
      const el = ref.current;
      const raf = requestAnimationFrame(() => updateOverflow(el));
      return () => cancelAnimationFrame(raf);
    }, [html, p.wrap]);
    useLayoutEffect(() => {
      if (!html || p.wrap) return;
      const offs: (() => void)[] = [];
      if (leftRef.current) offs.push(registerPane(`${p.path}|${p.view === 'split' ? 'l' : 'u'}`, leftRef.current));
      if (rightRef.current) offs.push(registerPane(`${p.path}|r`, rightRef.current));
      return () => offs.forEach((o) => o());
    }, [!!html, p.view, p.wrap]);
    if (!html) return <div ref={ref} class="chunk ph" style={{ height: p.wrap ? lastH.current ?? height : height }} />;
    if (p.wrap)
      return <div ref={ref} class={`chunk wrap ${p.view === 'split' ? 'sgrid' : 'ulist'}`} dangerouslySetInnerHTML={{ __html: html[0]! }} />;
    if (p.view === 'split')
      return (
        <div ref={ref} class="chunk nw split" style={{ height }}>
          <div class="pane" ref={leftRef}>
            <div class="pin" dangerouslySetInnerHTML={{ __html: html[0]! }} />
          </div>
          <div class="pane" ref={rightRef}>
            <div class="pin" dangerouslySetInnerHTML={{ __html: html[1]! }} />
          </div>
        </div>
      );
    return (
      <div ref={ref} class="chunk nw unified" style={{ height }}>
        <div class="pane" ref={leftRef}>
          <div class="pin" dangerouslySetInnerHTML={{ __html: html[0]! }} />
        </div>
      </div>
    );
  },
  (a, b) =>
    a.rows === b.rows &&
    a.start === b.start &&
    a.end === b.end &&
    a.view === b.view &&
    a.wrap === b.wrap &&
    a.ver === b.ver &&
    a.tintKey === b.tintKey &&
    a.snap === b.snap &&
    a.content === b.content,
);

// ------------------------------------------------------------------ gap row

function Gap({ path, gap, canExpand }: { path: string; gap: GapRow; canExpand: boolean }) {
  const exp = (dir: 'up' | 'down' | 'all') => void expandGap(path, gap, dir);
  const small = gap.count <= 20;
  return (
    <div class="gap" data-k={`g${gap.id}`}>
      <div class="gap-ctl">
        {canExpand && gap.count > 0 && (
          small ? (
            <button class="gx" title={`Show ${gap.count} hidden lines`} onClick={() => exp('all')}>
              <Icon name="unfold" />
            </button>
          ) : (
            <>
              {gap.position !== 'top' && (
                <button class="gx" title="Show 20 more lines below the previous change" onClick={() => exp('down')}>
                  <Icon name="down" />
                </button>
              )}
              {gap.position !== 'end' && (
                <button class="gx" title="Show 20 more lines above the next change" onClick={() => exp('up')}>
                  <Icon name="up" />
                </button>
              )}
            </>
          )
        )}
      </div>
      <div class="gap-txt">
        {gap.count > 0 && (
          <button class="link" disabled={!canExpand} onClick={() => exp('all')}>
            {gap.count} unchanged {gap.count === 1 ? 'line' : 'lines'}
          </button>
        )}
        {gap.section && <span class="sect">{gap.section}</span>}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ header

const STATUS: Record<string, [string, string]> = {
  added: ['A', 'Added'],
  deleted: ['D', 'Deleted'],
  modified: ['M', 'Modified'],
  renamed: ['R', 'Renamed'],
};

function splitPath(p: string): [string, string] {
  const i = p.lastIndexOf('/');
  return i < 0 ? ['', p] : [p.slice(0, i + 1), p.slice(i + 1)];
}

function FileHeader({ f, collapsed, sinceOn, unresolved, total, pending }: { f: DiffFileMeta; collapsed: boolean; sinceOn: boolean; unresolved: number; total: number; pending: number }) {
  const [copied, setCopied] = useState(false);
  const [dir, base] = splitPath(f.path);
  const st = STATUS[f.status]!;
  const flash = S.flash.has(f.path);
  return (
    <div class={`fh${flash ? ' flash' : ''}${f.viewed ? ' viewed' : ''}`} data-k="hdr">
      <button class="chev" aria-label={collapsed ? 'Expand file' : 'Collapse file'} onClick={() => setCollapsed(f.path, !collapsed)}>
        <Icon name={collapsed ? 'right' : 'downchev'} />
      </button>
      <span class={`st st-${f.status}`} title={st[1]}>
        {st[0]}
      </span>
      <span class="fpath" title={f.oldPath ? `${f.oldPath} → ${f.path}` : f.path} onClick={() => setCollapsed(f.path, !collapsed)}>
        {f.oldPath && <span class="oldp">{f.oldPath} → </span>}
        <span class="dir">{dir}</span>
        <span class="base">{base}</span>
      </span>
      <button
        class="ib copy"
        title="Copy path"
        onClick={() => void copyText(f.path).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1200);
        })}
      >
        <Icon name={copied ? 'check' : 'copy'} />
      </button>
      <span class="counts">
        {f.additions > 0 && <span class="plus">+{f.additions}</span>}
        {f.deletions > 0 && <span class="minus">−{f.deletions}</span>}
      </span>
      {f.changedSinceViewed && (
        <span class="csv">
          <span class="badge warn">Changed since viewed</span>
          <button class="link" onClick={() => void showSince(f.path, !sinceOn)}>
            {sinceOn ? 'Show full diff' : 'Show new changes only'}
          </button>
        </span>
      )}
      <span class="sp" />
      {pending > 0 && (
        <span class="tc pending" title={`${pending} pending in your review (not sent yet)`}>
          {pending} pending
        </span>
      )}
      {total > 0 && (
        <span class={`tc${unresolved ? ' open' : ''}`} title={`${unresolved} unresolved of ${total} sent threads`}>
          <Icon name="comment" />
          {unresolved || total}
        </span>
      )}
      <button class="ib" title="Comment on this file" onClick={() => commentOnFile(f.path)}>
        <Icon name="addcomment" />
      </button>
      <label class={`vw${f.viewed ? ' on' : ''}`} title="Mark as viewed (v)">
        <input type="checkbox" checked={f.viewed} onChange={(e) => void setViewed(f.path, (e.target as HTMLInputElement).checked)} />
        Viewed
      </label>
    </div>
  );
}

// ------------------------------------------------------------------ card

type Attach = { t?: Thread; c?: ComposerState };

let lastClick: { path: string; side: Side; line: number } | null = null;

export const FileCard = memo(function FileCard({ path }: { path: string }) {
  useTopics(fileTopic(path), 'view');
  const f = S.fileByPath.get(path);
  const cardRef = useRef<HTMLDivElement>(null);
  const collapsed = f ? isCollapsed(f) : true;
  useLayoutEffect(() => settleSoon());

  const diff = getDiff(path) ?? getStaleDiff(path);
  const hasDiff = !!diff;

  // Mounted means near the viewport: load text for highlighting and context.
  useEffect(() => {
    if (!f || collapsed) return;
    if (!hasDiff) {
      requestHunks([path], true);
      return;
    }
    void ensureContent(path);
    return () => releaseContent(path);
  }, [path, collapsed, f?.fingerprint, hasDiff]);

  const since = getSince(path);
  const sinceOn = since?.state === 'ready' && !!since.file;
  const shown = sinceOn ? since!.file! : diff;
  const content = f ? getContent(f) : undefined;
  const ctx = content ? content.new ?? content.old : null;
  const exp = getExpansion(path);
  const expKey = exp ? JSON.stringify([...exp]) : '';
  const threads = S.threadsByPath.get(path) ?? [];
  // Threads and drafts on unchanged lines between hunks: reveal those lines so they show in place.
  const pins: Pin[] = [];
  for (const t of threads) {
    const a = t.anchor;
    if (!t.outdated && a.startLine !== null && a.endLine !== null) pins.push({ side: a.side, start: a.startLine, end: a.endLine });
  }
  for (const c of S.composers.values()) {
    const a = c.anchor;
    if (c.kind === 'new' && c.path === path && c.scope === S.scope && a && a.startLine !== null && a.endLine !== null)
      pins.push({ side: a.side, start: a.startLine, end: a.endLine });
  }
  const pinKey = pins.map((x) => `${x.side}${x.start}-${x.end}`).join(',');
  const model = useMemo(
    () => (shown ? buildModel(shown, exp, ctx, !sinceOn, pins) : null),
    [shown, expKey, ctx, sinceOn, pinKey],
  );

  if (!f) return null;

  const view = S.view;
  const wrap = S.wrap;
  let pendingMsgs = 0;
  let sentThreads = 0;
  let unresolved = 0;
  for (const t of threads) {
    let p = 0;
    for (const m of t.messages) if (m.pending) p++;
    pendingMsgs += p;
    if (p === t.messages.length) continue; // not sent at all yet
    sentThreads++;
    if (!t.resolved) unresolved++;
  }

  let body: preact.ComponentChildren = null;
  if (!collapsed && (f.binary || f.tooLarge)) {
    body = (
      <div class="fb">
        <div class="ph-note">
          {f.binary ? 'Binary file. Not shown.' : `Diff too large to display (+${f.additions} −${f.deletions}).`}
        </div>
      </div>
    );
  } else if (!collapsed && (!shown || !model)) {
    body = <div class="fb skel" style={{ height: Math.max(40, estimate(f) - 48) }} />;
  } else if (!collapsed && shown && model) {
    const rows: Row[] = view === 'split' ? model.split : model.unified;
    const index = view === 'split' ? model.sIndex : model.uIndex;
    const attach = new Map<number, Attach[]>();
    const top: Attach[] = [];
    const tint = new Set<string>();
    const addTint = (side: Side, a: number, b: number) => {
      if (b - a > 2000) return;
      for (let i = a; i <= b; i++) tint.add((side === 'old' ? 'o' : 'n') + i);
    };
    /** Row of a line: its own row, else the hidden-lines row that contains it (until the text loads). */
    const rowOf = (side: Side, line: number): number | undefined => {
      const idx = index.get((side === 'old' ? 'o' : 'n') + line);
      if (idx !== undefined) return idx;
      for (let i = 0; i < rows.length; i++) {
        const r = rows[i]!;
        if (!isGap(r) || !r.count) continue;
        const first = side === 'old' ? r.o : r.n;
        if (line >= first && line < first + r.count) return i;
      }
      return undefined;
    };
    for (const t of threads) {
      const a = t.anchor;
      if (t.outdated || a.startLine === null || a.endLine === null) {
        top.push({ t });
        continue;
      }
      const idx = rowOf(a.side, a.endLine);
      if (idx === undefined) {
        top.push({ t });
        continue;
      }
      if (!t.resolved) addTint(a.side, a.startLine, a.endLine);
      let arr = attach.get(idx);
      if (!arr) attach.set(idx, (arr = []));
      arr.push({ t });
    }
    for (const c of S.composers.values()) {
      if (c.kind !== 'new' || c.path !== path || c.scope !== S.scope || !c.anchor) continue;
      const a = c.anchor;
      if (a.startLine === null || a.endLine === null) {
        top.push({ c });
        continue;
      }
      const idx = rowOf(a.side, a.endLine);
      if (idx === undefined) {
        top.push({ c });
        continue;
      }
      addTint(a.side, a.startLine, a.endLine);
      let arr = attach.get(idx);
      if (!arr) attach.set(idx, (arr = []));
      arr.push({ c });
    }
    if (S.sel && S.sel.path === path) addTint(S.sel.side, S.sel.start, S.sel.end);
    const tintKey = [...tint].join(',');
    const ver = content?.ver ?? 0;

    const parts: preact.ComponentChildren[] = [];
    let segStart = 0;
    const flush = (end: number) => {
      for (let s = segStart; s < end; s += CHUNK) {
        const e = Math.min(end, s + CHUNK);
        parts.push(
          <Chunk key={`c${s}`} path={path} rows={rows} start={s} end={e} view={view} wrap={wrap} content={content} ver={ver} tint={tint} tintKey={tintKey} snap={sinceOn} />,
        );
      }
    };
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i]!;
      const att = attach.get(i);
      if (isGap(r)) {
        flush(i);
        parts.push(<Gap key={`g${r.id}`} path={path} gap={r} canExpand={!sinceOn && !f.binary} />);
        segStart = i + 1;
        if (!att) continue;
      }
      if (att) {
        flush(i + 1);
        parts.push(
          <div
            class={`attach${view === 'split' && att.every((x) => (x.t?.anchor ?? x.c?.anchor)?.side === 'new') ? ' sn' : ''}`}
            key={`a${i}`}
          >
            {att.map((x) => (x.t ? <ThreadView key={`t${x.t.id}`} id={x.t.id} /> : <Composer key={x.c!.key} ck={x.c!.key} />))}
          </div>,
        );
        segStart = i + 1;
      }
    }
    flush(rows.length);

    let placeholder: preact.ComponentChildren = null;
    if (!shown.hunks.length)
      placeholder = (
        <div class="ph-note">
          {f.status === 'renamed'
            ? 'File renamed without changes.'
            : f.status === 'added'
              ? 'Empty file added.'
              : f.status === 'deleted'
                ? 'Empty file deleted.'
                : 'No content changes (file mode or type changed).'}
        </div>
      );

    body = (
      <div
        class={`fb ${view}${wrap ? ' wrapped' : ''}`}
        onMouseDown={(e) => onGutterDown(e, path)}
        onMouseMove={(e) => onRowHover(e, path)}
        onMouseLeave={() => (S.hover = null)}
      >
        {sinceOn && (
          <div class="since-bar">
            <Icon name="history" /> Showing only what changed since you marked this file viewed.
            <button class="link" onClick={() => void showSince(path, false)}>
              Show full diff
            </button>
          </div>
        )}
        {top.length > 0 && (
          <div class="attach top">
            {top.map((x) => (x.t ? <ThreadView key={`t${x.t.id}`} id={x.t.id} pinned /> : <Composer key={x.c!.key} ck={x.c!.key} />))}
          </div>
        )}
        {placeholder}
        {parts}
      </div>
    );
  }

  return (
    <section class={`card${collapsed ? ' collapsed' : ''}`} data-path={path} ref={cardRef}>
      <FileHeader f={f} collapsed={collapsed} sinceOn={sinceOn} unresolved={unresolved} total={sentThreads} pending={pendingMsgs} />
      {since?.state === 'loading' && <div class="since-bar">Loading changes since viewed…</div>}
      {body}
    </section>
  );
});

// ------------------------------------------------------------------ gutter interaction

function rowInfo(el: EventTarget | null): { side: Side; line: number; row: HTMLElement } | null {
  const row = (el as HTMLElement | null)?.closest?.('.r') as HTMLElement | null;
  if (!row || !row.dataset.side || !row.dataset.line) return null;
  return { side: row.dataset.side as Side, line: Number(row.dataset.line), row };
}

function onRowHover(e: MouseEvent, path: string) {
  const info = rowInfo(e.target);
  S.hover = info ? { path, side: info.side, line: info.line } : null;
}

function onGutterDown(e: MouseEvent, path: string) {
  if (e.button !== 0) return;
  const target = e.target as HTMLElement;
  if (!target.classList.contains('ln') || !target.classList.contains('cm')) return;
  const info = rowInfo(target);
  if (!info) return;
  e.preventDefault();
  if (e.shiftKey && lastClick && lastClick.path === path && lastClick.side === info.side) {
    commentOn(path, info.side, lastClick.line, info.line);
    lastClick = null;
    return;
  }
  const origin = info.line;
  setSelection({ path, side: info.side, start: origin, end: origin, origin });
  const move = (ev: MouseEvent) => {
    const el = document.elementFromPoint(ev.clientX, ev.clientY);
    const i2 = rowInfo(el);
    if (!i2 || i2.side !== info.side || !S.sel) return;
    if (!(el as HTMLElement).closest(`[data-path="${CSS.escape(path)}"]`)) return;
    const start = Math.min(origin, i2.line);
    const end = Math.max(origin, i2.line);
    if (start !== S.sel.start || end !== S.sel.end) setSelection({ ...S.sel, start, end });
  };
  const up = () => {
    document.removeEventListener('mousemove', move);
    document.removeEventListener('mouseup', up);
    const sel = S.sel;
    setSelection(null);
    if (!sel) return;
    lastClick = { path, side: sel.side, line: sel.origin };
    commentOn(path, sel.side, sel.start, sel.end);
  };
  document.addEventListener('mousemove', move);
  document.addEventListener('mouseup', up);
}

export function rerenderAllFiles() {
  for (const f of S.files) emit(fileTopic(f.path));
}
