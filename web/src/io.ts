/** Shared IntersectionObservers keyed by margin, rooted at the diff scroller. */
type Cb = (visible: boolean) => void;

const observers = new Map<string, { io: IntersectionObserver; cbs: Map<Element, Cb> }>();
let root: Element | null = null;

export function setObserverRoot(el: Element | null) {
  if (root === el) return;
  root = el;
  // Recreate observers with the new root.
  const old = [...observers.entries()];
  for (const [, { io }] of old) io.disconnect();
  observers.clear();
  for (const [margin, { cbs }] of old) for (const [el2, cb] of cbs) observe(el2, margin, cb);
}

export function observe(el: Element, margin: string, cb: Cb): () => void {
  let o = observers.get(margin);
  if (!o) {
    const cbs = new Map<Element, Cb>();
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) cbs.get(e.target)?.(e.isIntersecting);
      },
      { root, rootMargin: margin },
    );
    o = { io, cbs };
    observers.set(margin, o);
  }
  o.cbs.set(el, cb);
  o.io.observe(el);
  const obs = o;
  return () => {
    obs.cbs.delete(el);
    obs.io.unobserve(el);
  };
}

/** Synchronous check used on mount so freshly created chunks render before paint. */
export function nearViewport(el: Element, marginPx: number): boolean {
  const r = el.getBoundingClientRect();
  const top = root ? root.getBoundingClientRect().top : 0;
  const bottom = root ? root.getBoundingClientRect().bottom : innerHeight;
  return r.bottom >= top - marginPx && r.top <= bottom + marginPx;
}
