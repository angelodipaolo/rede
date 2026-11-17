import { useEffect, useState } from 'preact/hooks';
import type { Thread } from '../../../src/shared/types.ts';
import { highlightText } from '../highlight.ts';
import { langForPath } from '../langmap.ts';

/** One line of the outdated explanation: what changed, in plain words. */
export function OutdatedNote({ t }: { t: Thread }) {
  if (!t.outdated) return null;
  const gone = t.outdatedReason === 'file-gone';
  return (
    <div class="od-note">
      <b>{gone ? 'File no longer in this diff.' : 'Outdated: code changed.'}</b>{' '}
      {gone ? 'The file this comment was written on is not part of the current diff.' : 'The code this comment was written on has changed.'}
    </div>
  );
}

function where(t: Thread): string {
  const o = t.original;
  if (!o) return '';
  return [o.branch, o.head ? o.head.slice(0, 7) : null].filter(Boolean).join(' · ');
}

/**
 * The code a thread was written on, as a small diff: old and new line numbers, +/- marker,
 * the commented lines tinted. Syntax colors arrive from the highlight worker; until then (or
 * for unknown languages) the text is plain. Threads stored before snapshots fall back to the snippet.
 */
export function OriginalCode({ t, label = true }: { t: Thread; label?: boolean }) {
  const o = t.original;
  const lines = o?.lines ?? [];
  const [hl, setHl] = useState<string[] | null>(null);
  const key = `${t.id}:${lines.length}`;
  useEffect(() => {
    setHl(null);
    if (!lines.length) return;
    const lang = langForPath(t.anchor.path);
    if (!lang) return;
    let live = true;
    const job = highlightText(lines.map((l) => l.text).join('\n'), lang);
    void job.done.then((h) => {
      if (live && Array.isArray(h) && h.length >= lines.length) setHl(h);
    });
    return () => {
      live = false;
    };
  }, [key]);

  if (!lines.length) {
    if (!t.snippet.length) return null;
    return (
      <div class="orig">
        {label && <div class="orig-h">Commented lines when the thread started</div>}
        <pre class="snippet">
          {t.snippet.slice(0, 12).join('\n')}
          {t.snippet.length > 12 ? '\n…' : ''}
        </pre>
      </div>
    );
  }
  const w = where(t);
  return (
    <div class="orig">
      {label && (
        <div class="orig-h">
          Original code{o!.section ? <span class="orig-sec"> · {o!.section}</span> : null}
          {w && <span class="orig-at"> · {w}</span>}
        </div>
      )}
      <div class="orig-code" role="table" aria-label="Original code">
        {lines.map((l, i) => (
          <div key={i} class={`or ${l.type === 'add' ? 'a' : l.type === 'del' ? 'd' : 'x'}${l.anchored ? ' anc' : ''}`} role="row">
            <span class="oln">{l.oldLine ?? ''}</span>
            <span class="oln">{l.newLine ?? ''}</span>
            <span class="omk">{l.type === 'add' ? '+' : l.type === 'del' ? '−' : ''}</span>
            {hl ? <span class="oc" dangerouslySetInnerHTML={{ __html: hl[i]! || ' ' }} /> : <span class="oc">{l.text || ' '}</span>}
          </div>
        ))}
        {o!.truncated && <div class="or x trunc">…</div>}
      </div>
    </div>
  );
}
