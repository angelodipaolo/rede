import type { HlResponse } from './hl.worker.ts';

let worker: Worker | null = null;
let seq = 0;
const pending = new Map<number, (lines: string[] | null) => void>();

function getWorker(): Worker {
  if (!worker) {
    worker = new Worker(new URL('./hl.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (e: MessageEvent<HlResponse>) => {
      const cb = pending.get(e.data.id);
      pending.delete(e.data.id);
      cb?.(e.data.lines);
    };
  }
  return worker;
}

/** Highlights a whole text off the main thread. Resolves to one balanced HTML fragment per line. */
export function highlightText(text: string, lang: string | null): Promise<string[] | null> {
  if (!lang) return Promise.resolve(null);
  return new Promise((resolve) => {
    const id = ++seq;
    pending.set(id, resolve);
    getWorker().postMessage({ id, text, lang });
  });
}
