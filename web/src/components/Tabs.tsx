import { useEffect } from 'preact/hooks';
import { reviewHref } from '../api.ts';
import { useTopics } from '../bus.ts';
import { closeTab, N, startHub, tabKey } from '../nav.ts';
import { agentColorClass } from '../util.ts';

/**
 * The strip of open reviews above every page. The first entry is the dashboard; its badge counts
 * reviews that wait for you. A dot marks a review an agent marked ready; a number, agent replies
 * that wait for you.
 */
export function Tabs() {
  useTopics('tabs', 'dash');
  useEffect(() => startHub(), []);
  const home = !N.current;
  const awaiting = N.dash?.awaiting ?? 0;
  return (
    <nav class="tabs" aria-label="Open reviews">
      <a class={`tab tab-home${home ? ' on' : ''}`} href="/" title="Dashboard: every worktree and review (⌘0)">
        <svg class="ic" width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
          <path d="M2.5 7.5L8 3l5.5 4.5V13h-4v-3h-3v3h-4z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" />
        </svg>
        <span>Dashboard</span>
        {awaiting > 0 && (
          <b class="tab-badge" title={`${awaiting} ready for your review`}>
            {awaiting}
          </b>
        )}
      </a>
      {N.tabs.map((t, i) => {
        const s = N.byKey.get(tabKey(t.ws, t.id));
        const on = N.current?.ws === t.ws && N.current.id === t.id;
        const title = s?.title ?? t.title;
        return (
          <a
            key={tabKey(t.ws, t.id)}
            class={`tab${on ? ' on' : ''}${s?.awaiting ? ' ready' : ''}`}
            href={reviewHref(t.ws, t.id)}
            title={`${t.repo} · ${t.wsName}${t.branch ? ` (${t.branch})` : ''}\n${title}${i < 9 ? `\n⌘${i + 1}` : ''}`}
          >
            {s?.awaiting && <span class={`tab-dot ${s.publishedBy ? agentColorClass(s.publishedBy.name) : ''}`} title="Ready for review" />}
            <span class="tab-ws">{t.wsName}</span>
            <span class="tab-title">{title}</span>
            {!!s?.agentReplies && (
              <b class="tab-n" title={`${s.agentReplies} agent ${s.agentReplies === 1 ? 'reply waits' : 'replies wait'} for you`}>
                {s.agentReplies}
              </b>
            )}
            <button
              class="tab-x"
              title="Close tab"
              aria-label="Close tab"
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                closeTab(t.ws, t.id);
              }}
            >
              ×
            </button>
          </a>
        );
      })}
    </nav>
  );
}
