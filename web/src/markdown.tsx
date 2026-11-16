import DOMPurify from 'dompurify';
import { Marked } from 'marked';
import { useLayoutEffect, useMemo, useRef } from 'preact/hooks';
import { highlightText } from './highlight.ts';
import { langForFence } from './langmap.ts';

const marked = new Marked({ gfm: true, breaks: true, async: false });

DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A') {
    node.setAttribute('target', '_blank');
    node.setAttribute('rel', 'noopener noreferrer');
  }
});

const htmlCache = new Map<string, string>();
const codeCache = new Map<string, string>();

export function renderMarkdown(src: string): string {
  let html = htmlCache.get(src);
  if (html === undefined) {
    html = DOMPurify.sanitize(marked.parse(src) as string, { USE_PROFILES: { html: true } });
    if (htmlCache.size > 500) htmlCache.clear();
    htmlCache.set(src, html);
  }
  return html;
}

export function Markdown({ src, class: cls }: { src: string; class?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const html = useMemo(() => renderMarkdown(src), [src]);
  useLayoutEffect(() => {
    const root = ref.current;
    if (!root) return;
    root.querySelectorAll<HTMLElement>('pre > code').forEach((code) => {
      const m = /language-([\w+#-]+)/.exec(code.className);
      const lang = m ? langForFence(m[1]!) : null;
      const text = code.textContent ?? '';
      const key = `${lang}\u0000${text}`;
      const cached = codeCache.get(key);
      code.classList.add('hl');
      if (cached) {
        code.innerHTML = cached;
        return;
      }
      void highlightText(text.replace(/\n$/, ''), lang ?? (text.length < 4000 ? 'auto' : null)).done.then((lines) => {
        if (!lines || lines === 'cancelled') return;
        const out = lines.join('\n');
        codeCache.set(key, out);
        if (code.isConnected && code.textContent === text) code.innerHTML = out;
      });
    });
  }, [html]);
  return <div ref={ref} class={`md ${cls ?? ''}`} dangerouslySetInnerHTML={{ __html: html }} />;
}
