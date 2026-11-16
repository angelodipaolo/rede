import type { HlResponse } from './hl.worker.ts';

let worker: Worker | null = null;
let seq = 0;
type Result = string[] | null | 'cancelled';
const pending = new Map<number, (lines: Result) => void>();

function getWorker(): Worker {
  if (!worker) {
    worker = new Worker(new URL('./hl.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (e: MessageEvent<HlResponse>) => {
      const cb = pending.get(e.data.id);
      pending.delete(e.data.id);
      cb?.(e.data.cancelled ? 'cancelled' : e.data.lines);
    };
  }
  return worker;
}

/** Highlights a whole text off the main thread. Resolves to one balanced HTML fragment per line. */
export function highlightText(text: string, lang: string | null): { id: number; done: Promise<Result> } {
  const id = ++seq;
  if (!lang) return { id, done: Promise.resolve(null) };
  const done = new Promise<Result>((resolve) => {
    pending.set(id, resolve);
    getWorker().postMessage({ id, text, lang });
  });
  return { id, done };
}

/** Drops a queued job. A job already running finishes, but its result is discarded. */
export function cancelHighlight(id: number) {
  const cb = pending.get(id);
  if (!cb) return;
  pending.delete(id);
  worker?.postMessage({ cancel: id });
  cb('cancelled');
}
