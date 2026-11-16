import { useEffect, useReducer } from 'preact/hooks';

/** Topic-based change notification. Components subscribe to the topics they render. */
const subs = new Map<string, Set<() => void>>();
let pending: Set<string> | null = null;

export function emit(...topics: string[]) {
  if (!pending) {
    pending = new Set();
    queueMicrotask(flush);
  }
  for (const t of topics) pending.add(t);
}

function flush() {
  const topics = pending!;
  pending = null;
  const called = new Set<() => void>();
  for (const t of topics) {
    const set = subs.get(t);
    if (!set) continue;
    for (const fn of set) {
      if (called.has(fn)) continue;
      called.add(fn);
      fn();
    }
  }
}

export function subscribe(topic: string, fn: () => void): () => void {
  let set = subs.get(topic);
  if (!set) subs.set(topic, (set = new Set()));
  set.add(fn);
  return () => {
    set!.delete(fn);
    if (!set!.size) subs.delete(topic);
  };
}

/** Re-renders the component when any of the topics is emitted. */
export function useTopics(...topics: string[]): number {
  const [v, bump] = useReducer((x: number) => x + 1, 0);
  const key = topics.join('\u0001');
  useEffect(() => {
    const offs = topics.map((t) => subscribe(t, bump as () => void));
    return () => offs.forEach((o) => o());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return v;
}
