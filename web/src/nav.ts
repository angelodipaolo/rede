import type { Dashboard, DashboardWorkspace, HubEvent, ReviewSummary } from '../../src/shared/types.ts';
import { api, reviewHref } from './api.ts';
import { emit } from './bus.ts';

/**
 * Navigation across worktrees and reviews: the open-review tabs (kept in this browser), the
 * dashboard data (pushed by the hub), and acknowledging a review the human has opened.
 */

export interface Tab {
  ws: string;
  id: string;
  title: string;
  /** Worktree directory name. */
  wsName: string;
  repo: string;
  branch: string | null;
}

const TABS_KEY = 'rede:tabs';
const MAX_TABS = 12;

function readTabs(): Tab[] {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(TABS_KEY) ?? '[]');
    return Array.isArray(v) ? v.filter((t): t is Tab => !!t && typeof t.ws === 'string' && typeof t.id === 'string').slice(0, MAX_TABS) : [];
  } catch {
    return [];
  }
}

function writeTabs(tabs: Tab[]): void {
  try {
    localStorage.setItem(TABS_KEY, JSON.stringify(tabs));
  } catch {
    /* storage unavailable */
  }
}

export const N = {
  tabs: readTabs(),
  dash: null as Dashboard | null,
  /** "<ws>/<review id>" -> summary, from the dashboard. */
  byKey: new Map<string, ReviewSummary & { ws: DashboardWorkspace }>(),
  /** The tab of this page, if it is a review page. */
  current: null as { ws: string; id: string } | null,
};

export const tabKey = (ws: string, id: string) => `${ws}/${id}`;

/** Other pages (browser tabs) change the tab list too. */
window.addEventListener('storage', (e) => {
  if (e.key !== TABS_KEY) return;
  N.tabs = readTabs();
  emit('tabs');
});

/** Adds the review to the tabs (keeps the order of tabs that are already open). */
export function openTab(tab: Tab): void {
  N.current = { ws: tab.ws, id: tab.id };
  const tabs = readTabs();
  const i = tabs.findIndex((t) => t.ws === tab.ws && t.id === tab.id);
  if (i >= 0) tabs[i] = tab;
  else {
    tabs.push(tab);
    while (tabs.length > MAX_TABS) {
      const drop = tabs.findIndex((t) => !(t.ws === tab.ws && t.id === tab.id));
      tabs.splice(drop, 1);
    }
  }
  N.tabs = tabs;
  writeTabs(tabs);
  emit('tabs');
}

/** Closes a tab. When it is the current page, goes to the neighbour tab, else the dashboard. */
export function closeTab(ws: string, id: string): void {
  const tabs = readTabs();
  const i = tabs.findIndex((t) => t.ws === ws && t.id === id);
  if (i < 0) return;
  tabs.splice(i, 1);
  N.tabs = tabs;
  writeTabs(tabs);
  emit('tabs');
  if (N.current?.ws === ws && N.current.id === id) {
    const next = tabs[i] ?? tabs[i - 1];
    location.href = next ? reviewHref(next.ws, next.id) : '/';
  }
}

/** Moves to the tab `delta` places from the current one (wraps; the dashboard is position 0). */
export function stepTab(delta: number): void {
  const list: Array<string> = ['/', ...N.tabs.map((t) => reviewHref(t.ws, t.id))];
  const here = N.current ? reviewHref(N.current.ws, N.current.id) : '/';
  const i = Math.max(0, list.indexOf(here));
  const next = list[(i + delta + list.length) % list.length]!;
  if (next !== here) location.href = next;
}

/** Goes to tab n (1-based; 0 = dashboard). */
export function gotoTab(n: number): void {
  if (n === 0) location.href = '/';
  const t = N.tabs[n - 1];
  if (t) location.href = reviewHref(t.ws, t.id);
}

// ------------------------------------------------------------------ dashboard data

let refreshing: Promise<void> | null = null;
let again = false;

export function refreshDashboard(): Promise<void> {
  if (refreshing) {
    again = true;
    return refreshing;
  }
  refreshing = api
    .dashboard()
    .then((d) => {
      N.dash = d;
      N.byKey = new Map(d.workspaces.flatMap((w) => w.reviews.map((r) => [tabKey(w.id, r.id), { ...r, ws: w }] as const)));
      emit('dash', 'tabs');
    })
    .catch(() => {})
    .finally(() => {
      refreshing = null;
      if (again) {
        again = false;
        void refreshDashboard();
      }
    });
  return refreshing;
}

let es: EventSource | null = null;
let retry = 0;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let hideTimer: ReturnType<typeof setTimeout> | null = null;
let started = false;

function connect(): void {
  if (retryTimer) clearTimeout(retryTimer);
  retryTimer = null;
  es?.close();
  const src = new EventSource(api.hubEventsUrl());
  es = src;
  src.onopen = () => {
    retry = 0;
  };
  src.onmessage = (e) => {
    if (es !== src) return;
    let ev: HubEvent;
    try {
      ev = JSON.parse(e.data);
    } catch {
      return;
    }
    if (ev.type === 'dashboard') void refreshDashboard();
  };
  src.onerror = () => {
    if (es !== src) return;
    src.close();
    es = null;
    retryTimer = setTimeout(connect, Math.min(15000, 500 * 2 ** retry++));
  };
}

function disconnect(): void {
  if (retryTimer) clearTimeout(retryTimer);
  retryTimer = null;
  es?.close();
  es = null;
}

/**
 * Follows the hub's dashboard events while the page is visible. Every page of one origin counts
 * against the browser's six connections per host, so a hidden page lets its stream go after a
 * short grace and picks it up again (with a refresh) when it comes back.
 */
export function startHub(): void {
  if (started) return;
  started = true;
  void refreshDashboard();
  if (!document.hidden) connect();
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      if (hideTimer) clearTimeout(hideTimer);
      hideTimer = setTimeout(disconnect, 10_000);
    } else {
      if (hideTimer) clearTimeout(hideTimer);
      hideTimer = null;
      if (!es) {
        void refreshDashboard();
        connect();
      }
    }
  });
}

// ------------------------------------------------------------------ acknowledge

/**
 * A review that an agent marked ready stops waiting once the human has it on screen: the page
 * is visible and focused (a background tab or a hidden app window does not count).
 */
export function ackWhenSeen(ws: string, review: () => ReviewSummary | null): () => void {
  let sent = '';
  const check = () => {
    const r = review();
    if (!r?.awaiting || !r.readyAt || sent === r.readyAt) return;
    if (document.hidden || !document.hasFocus()) return;
    sent = r.readyAt;
    void api.ack(ws, r.id).then(() => refreshDashboard(), () => (sent = ''));
  };
  const timer = setInterval(check, 1000);
  window.addEventListener('focus', check);
  document.addEventListener('visibilitychange', check);
  check();
  return () => {
    clearInterval(timer);
    window.removeEventListener('focus', check);
    document.removeEventListener('visibilitychange', check);
  };
}

/** Marks a review seen from the dashboard. */
export async function markSeen(ws: string, id: string): Promise<void> {
  await api.ack(ws, id);
  await refreshDashboard();
}
