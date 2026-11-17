import { emit } from './bus.ts';
import {
  commentOn,
  cycleScope,
  isCollapsed,
  jumpToThread,
  nav,
  orderedOpenThreads,
  S,
  scrollToFile,
  setCollapsed,
  setFinishOpen,
  setSidebar,
  setView,
  setViewed,
  toggleWrap,
} from './store.ts';
import { isTyping } from './util.ts';

function currentIndex(): number {
  if (!S.current) return -1;
  return S.files.findIndex((f) => f.path === S.current);
}

function moveFile(dir: 1 | -1) {
  const files = S.files;
  if (!files.length) return;
  let i = currentIndex();
  const sc = S.scroller;
  if (dir === -1 && i >= 0 && sc) {
    // Inside a file: go to its own header first.
    const top = nav.fileTop(files[i]!.path);
    if (top !== null && top < -2) {
      scrollToFile(files[i]!.path);
      return;
    }
  }
  i = Math.max(0, Math.min(files.length - 1, i + dir));
  scrollToFile(files[i]!.path);
}

function moveThread(dir: 1 | -1) {
  const list = orderedOpenThreads();
  if (!list.length || !S.scroller) return;
  const sTop = S.scroller.getBoundingClientRect().top;
  const marker = sTop + Math.max(80, S.scroller.clientHeight * 0.25) + (dir === 1 ? 4 : -4);
  const pos = list.map((t) => {
    const el = S.scroller!.querySelector<HTMLElement>(`[data-thread="${t.id}"]`);
    if (el) return el.getBoundingClientRect().top;
    const top = nav.fileTop(t.anchor.path);
    return top === null ? -1e9 : sTop + top + 1;
  });
  let target = -1;
  if (dir === 1) target = pos.findIndex((y) => y > marker);
  else for (let i = pos.length - 1; i >= 0; i--) if (pos[i]! < marker) { target = i; break; }
  if (target < 0) target = dir === 1 ? 0 : list.length - 1;
  jumpToThread(list[target]!.id);
}

export function installKeys(): () => void {
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      if (S.sheet || S.connect || S.finish) {
        S.sheet = false;
        S.connect = false;
        S.finish = false;
        emit('ui');
      }
      return;
    }
    if (isTyping(e) || e.metaKey || e.ctrlKey || e.altKey) return;
    const cur = S.current ? S.fileByPath.get(S.current) : undefined;
    switch (e.key) {
      case 'j':
        moveFile(1);
        break;
      case 'k':
        moveFile(-1);
        break;
      case 'n':
        moveThread(1);
        break;
      case 'p':
        moveThread(-1);
        break;
      case 'v':
        if (cur) void setViewed(cur.path, !cur.viewed);
        break;
      case 'o':
        if (cur) setCollapsed(cur.path, !isCollapsed(cur));
        break;
      case 'c': {
        const h = S.hover;
        if (h) commentOn(h.path, h.side, h.line, h.line);
        break;
      }
      case 'w':
        toggleWrap();
        break;
      case 'u':
        setView(S.view === 'split' ? 'unified' : 'split');
        break;
      case 's':
        cycleScope();
        break;
      case 't': {
        if (S.sidebarHidden) setSidebar(null, false);
        requestAnimationFrame(() => {
          const el = document.getElementById('file-filter') as HTMLInputElement | null;
          el?.focus();
          el?.select();
        });
        break;
      }
      case '[':
        setSidebar(null, !S.sidebarHidden);
        break;
      case ']':
        S.panel = !S.panel;
        emit('ui', 'layout');
        break;
      case 'R':
        setFinishOpen(!S.finish);
        break;
      case '?':
        S.sheet = !S.sheet;
        emit('ui');
        break;
      default:
        return;
    }
    e.preventDefault();
  };
  window.addEventListener('keydown', onKey);
  return () => window.removeEventListener('keydown', onKey);
}
