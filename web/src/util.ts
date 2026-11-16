export function relTime(iso: string, now = Date.now()): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '';
  const s = Math.round((now - t) / 1000);
  if (s < 45) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  if (d < 7) return `${d}d ago`;
  return new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/** Subsequence fuzzy match. Returns a score (higher is better) or -1. */
export function fuzzy(query: string, text: string): number {
  if (!query) return 0;
  const q = query.toLowerCase();
  const s = text.toLowerCase();
  const direct = s.indexOf(q);
  if (direct >= 0) return 1000 - direct + (s.lastIndexOf('/') < direct ? 200 : 0);
  let qi = 0;
  let score = 0;
  let prev = -2;
  for (let i = 0; i < s.length && qi < q.length; i++) {
    if (s[i] === q[qi]) {
      score += i === prev + 1 ? 5 : 1;
      if (i === 0 || '/._-'.includes(s[i - 1]!)) score += 3;
      prev = i;
      qi++;
    }
  }
  return qi === q.length ? score : -1;
}

export function agentColorClass(name: string): string {
  const n = name.toLowerCase();
  if (n.includes('claude')) return 'ag-claude';
  if (n.includes('codex') || n.includes('gpt') || n.includes('openai')) return 'ag-codex';
  return 'ag-other';
}

export function copyText(text: string): Promise<boolean> {
  return navigator.clipboard
    ?.writeText(text)
    .then(() => true)
    .catch(() => fallbackCopy(text)) ?? Promise.resolve(fallbackCopy(text));
}

function fallbackCopy(text: string): boolean {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  }
  ta.remove();
  return ok;
}

export function isTyping(e: Event): boolean {
  const t = e.target as HTMLElement | null;
  if (!t) return false;
  const tag = t.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || t.isContentEditable;
}
