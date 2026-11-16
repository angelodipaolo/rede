/** Word-level diff for one pair of changed lines. Returns changed char ranges per side, or null. */
export type Ranges = [number, number][];

const TOKEN = /\w+|\s+|[^\w\s]/g;

export function wordDiff(a: string, b: string): { a: Ranges; b: Ranges } | null {
  if (a === b) return null;
  if (a.length > 800 || b.length > 800) return null;
  const ta = a.match(TOKEN) ?? [];
  const tb = b.match(TOKEN) ?? [];
  // Trim common token prefix and suffix; most edits are local.
  let pre = 0;
  let preChars = 0;
  while (pre < ta.length && pre < tb.length && ta[pre] === tb[pre]) preChars += ta[pre++]!.length;
  let suf = 0;
  while (
    suf < ta.length - pre &&
    suf < tb.length - pre &&
    ta[ta.length - 1 - suf] === tb[tb.length - 1 - suf]
  )
    suf++;
  const ma = ta.slice(pre, ta.length - suf);
  const mb = tb.slice(pre, tb.length - suf);
  const n = ma.length;
  const m = mb.length;
  const ra: Ranges = [];
  const rb: Ranges = [];
  const push = (r: Ranges, s: number, e: number) => {
    if (e <= s) return;
    const last = r[r.length - 1];
    if (last && last[1] === s) last[1] = e;
    else r.push([s, e]);
  };
  if (n === 0 || m === 0 || n * m > 40000) {
    push(ra, preChars, preChars + ma.join('').length);
    push(rb, preChars, preChars + mb.join('').length);
  } else {
    const w = m + 1;
    const dp = new Uint16Array((n + 1) * w);
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        dp[i * w + j] =
          ma[i] === mb[j] ? dp[(i + 1) * w + j + 1]! + 1 : Math.max(dp[(i + 1) * w + j]!, dp[i * w + j + 1]!);
      }
    }
    let i = 0;
    let j = 0;
    let pa = preChars;
    let pb = preChars;
    while (i < n || j < m) {
      if (i < n && j < m && ma[i] === mb[j]) {
        pa += ma[i++]!.length;
        pb += mb[j++]!.length;
      } else if (j < m && (i >= n || dp[i * w + j + 1]! >= dp[(i + 1) * w + j]!)) {
        push(rb, pb, pb + mb[j]!.length);
        pb += mb[j++]!.length;
      } else {
        push(ra, pa, pa + ma[i]!.length);
        pa += ma[i++]!.length;
      }
    }
  }
  const changedA = ra.reduce((s, r) => s + r[1] - r[0], 0);
  const changedB = rb.reduce((s, r) => s + r[1] - r[0], 0);
  // When nearly the whole line changed, word marks are noise.
  if (changedA > a.length * 0.65 && changedB > b.length * 0.65) return null;
  return { a: ra, b: rb };
}
