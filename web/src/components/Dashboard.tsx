import { useEffect } from 'preact/hooks';
import type { DashboardWorkspace, ReviewSummary } from '../../../src/shared/types.ts';
import { api, reviewHref, wsHref } from '../api.ts';
import { useTopics } from '../bus.ts';
import { Markdown } from '../markdown.tsx';
import { markSeen, N, refreshDashboard } from '../nav.ts';
import { applyTheme } from '../store.ts';
import { agentColorClass, relTime } from '../util.ts';
import { Icon } from './Icon.tsx';
import { Tabs } from './Tabs.tsx';

type Item = ReviewSummary & { ws: DashboardWorkspace };

function Where({ w }: { w: DashboardWorkspace }) {
  return (
    <span class="db-where" title={w.root}>
      <span class="db-repo">{w.repo.name}</span>
      {w.name !== w.repo.name && <span class="db-wt">{w.name}</span>}
      {w.branch && <span class="branch">{w.branch}</span>}
    </span>
  );
}

function By({ r }: { r: ReviewSummary }) {
  if (!r.publishedBy) return null;
  const agent = r.publishedBy.kind === 'agent';
  return (
    <span class={`db-by${agent ? ' ' + agentColorClass(r.publishedBy.name) : ''}`}>
      {agent ? r.publishedBy.name : 'You'}
      {agent && <span class="role">agent</span>}
    </span>
  );
}

function ReadyCard({ it }: { it: Item }) {
  return (
    <li class="db-card">
      <div class="db-card-head">
        <Where w={it.ws} />
        <span class="sp" />
        <time title={new Date(it.readyAt!).toLocaleString()}>{relTime(it.readyAt!)}</time>
      </div>
      <a class="db-title" href={reviewHref(it.ws.id, it.id)}>
        {it.title}
      </a>
      {it.summary && <Markdown class="db-summary md" src={it.summary} />}
      <div class="db-card-foot">
        <By r={it} />
        <span class="muted">
          {it.unresolvedCount} open · {it.threadCount} threads
        </span>
        <span class="sp" />
        <button class="btn sm ghost" onClick={() => void markSeen(it.ws.id, it.id)} title="Clear it from Ready and the Dock badge without opening it">
          Mark seen
        </button>
        <a class="btn sm primary" href={reviewHref(it.ws.id, it.id)}>
          Open review
        </a>
      </div>
    </li>
  );
}

function ReviewRow({ w, r }: { w: DashboardWorkspace; r: ReviewSummary }) {
  return (
    <li>
      <a class="db-row" href={reviewHref(w.id, r.id)}>
        <span class="db-row-title">
          {r.awaiting && <span class={`tab-dot ${r.publishedBy ? agentColorClass(r.publishedBy.name) : ''}`} title="Ready for review" />}
          {r.title}
        </span>
        {r.summary && <span class="db-row-sum">{r.summary.split('\n')[0]}</span>}
        <span class="db-row-meta muted">
          {r.agentReplies > 0 && <b class="attn">{r.agentReplies} to answer · </b>}
          {r.unresolvedCount} open · {r.threadCount} threads · {relTime(r.updatedAt)}
        </span>
      </a>
    </li>
  );
}

function WorkspaceBlock({ w }: { w: DashboardWorkspace }) {
  return (
    <section class={`db-ws${w.missing ? ' missing' : ''}`}>
      <header>
        <span class="db-wt-name" title={w.root}>
          {w.name}
        </span>
        {w.branch && <span class="branch">{w.branch}</span>}
        {w.agents.map((a) => (
          <span key={a.name} class={`agent-pill ${agentColorClass(a.name)} ${a.state}`} title={`${a.name} is ${a.state}`}>
            <span class="pdot" />
            {a.name}
          </span>
        ))}
        <span class="sp" />
        {w.missing ? (
          <>
            <span class="muted">Worktree removed</span>
            <button
              class="btn sm ghost"
              onClick={() => {
                if (confirm(`Remove ${w.name} from the dashboard? Its data stays in the repository.`)) void api.forgetWorkspace(w.id).then(refreshDashboard);
              }}
            >
              Remove
            </button>
          </>
        ) : (
          <a class="ib" href={wsHref('/history', w.id)} title="History of this worktree" aria-label="History">
            <Icon name="history" size={15} />
          </a>
        )}
      </header>
      {w.reviews.length ? (
        <ul>
          {w.reviews.map((r) => (
            <ReviewRow key={r.id} w={w} r={r} />
          ))}
        </ul>
      ) : (
        <p class="muted db-none">No reviews yet.</p>
      )}
    </section>
  );
}

export function DashboardApp() {
  useTopics('dash');
  useEffect(() => {
    applyTheme();
    document.title = 'Rede';
  }, []);
  useEffect(() => {
    const n = N.dash?.awaiting ?? 0;
    document.title = n ? `(${n}) Rede` : 'Rede';
  });
  const d = N.dash;
  const all: Item[] = d ? d.workspaces.flatMap((w) => w.reviews.map((r) => ({ ...r, ws: w }))) : [];
  const ready = all.filter((r) => r.awaiting).sort((a, b) => b.readyAt!.localeCompare(a.readyAt!));
  const replies = all.filter((r) => !r.awaiting && r.agentReplies > 0).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  // Repositories, most recently used first; their worktrees likewise.
  const repos = new Map<string, DashboardWorkspace[]>();
  const used = (w: DashboardWorkspace) => [w.lastUsedAt, ...w.reviews.map((r) => r.updatedAt)].sort().pop()!;
  for (const w of [...(d?.workspaces ?? [])].sort((a, b) => used(b).localeCompare(used(a)))) {
    const list = repos.get(w.repo.commonDir) ?? [];
    list.push(w);
    repos.set(w.repo.commonDir, list);
  }

  return (
    <div class="dash-app">
      <Tabs />
      <main class="dash">
        {!d && <p class="muted">Loading…</p>}
        {d && !d.workspaces.length && (
          <div class="empty">
            <div class="empty-mark" />
            <h2>No reviews yet</h2>
            <p>
              Run <code>rede</code> in a git repository or worktree. Agents publish their work with <code>rede publish</code>.
            </p>
          </div>
        )}
        {ready.length > 0 && (
          <section class="db-sec">
            <h2>
              Ready for review <span class="count">{ready.length}</span>
              <span class="sp" />
              <button
                class="btn sm ghost"
                onClick={() => void Promise.all(ready.map((r) => api.ack(r.ws.id, r.id))).then(refreshDashboard)}
                title="Clear every item from Ready and the Dock badge"
              >
                Mark all seen
              </button>
            </h2>
            <ul class="db-cards">
              {ready.map((it) => (
                <ReadyCard key={`${it.ws.id}/${it.id}`} it={it} />
              ))}
            </ul>
          </section>
        )}
        {replies.length > 0 && (
          <section class="db-sec">
            <h2>
              Waiting for your answer <span class="count">{replies.length}</span>
            </h2>
            <ul class="db-list">
              {replies.map((it) => (
                <li key={`${it.ws.id}/${it.id}`}>
                  <a class="db-row" href={reviewHref(it.ws.id, it.id)}>
                    <span class="db-row-title">
                      <Where w={it.ws} /> {it.title}
                    </span>
                    <span class="db-row-meta muted">
                      <b class="attn">{it.agentReplies} to answer</b> · {relTime(it.updatedAt)}
                    </span>
                  </a>
                </li>
              ))}
            </ul>
          </section>
        )}
        {[...repos.entries()].map(([key, list]) => (
          <section class="db-sec db-repo-sec" key={key}>
            <h2 title={key}>{list[0]!.repo.name}</h2>
            {list.map((w) => (
              <WorkspaceBlock key={w.id} w={w} />
            ))}
          </section>
        ))}
      </main>
    </div>
  );
}
