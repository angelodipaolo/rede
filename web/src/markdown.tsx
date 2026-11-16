import DOMPurify, { type Config } from 'dompurify';
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

/**
 * Messages come from agents, so their markdown is untrusted. Nothing may load from the
 * network: remote images become a link the reader can open on purpose, and tags and
 * attributes that can fetch or restyle the page (style, srcset, iframes, forms) are removed.
 */
const PURIFY: Config & { RETURN_DOM_FRAGMENT: true } = {
  USE_PROFILES: { html: true },
  FORBID_TAGS: ['style', 'link', 'meta', 'base', 'form', 'input', 'button', 'textarea', 'select', 'option', 'iframe', 'frame', 'object', 'embed', 'video', 'audio', 'source', 'track', 'picture', 'svg', 'math', 'dialog'],
  FORBID_ATTR: ['style', 'srcset', 'background', 'poster', 'formaction', 'ping', 'id', 'name'],
  RETURN_DOM_FRAGMENT: true,
};

function isLocalImage(src: string): boolean {
  return /^data:image\/(png|gif|jpe?g|webp|avif|bmp);/i.test(src);
}

const htmlCache = new Map<string, string>();
const codeCache = new Map<string, string>();

export function renderMarkdown(src: string): string {
  let html = htmlCache.get(src);
  if (html === undefined) {
    const frag = DOMPurify.sanitize(marked.parse(src) as string, PURIFY);
    for (const img of frag.querySelectorAll('img')) {
      const url = img.getAttribute('src') ?? '';
      if (isLocalImage(url)) continue;
      const alt = img.getAttribute('alt') || 'image';
      const ph = document.createElement(/^https?:/i.test(url) ? 'a' : 'span');
      ph.className = 'img-blocked';
      ph.textContent = `[${alt}: remote image not loaded]`;
      if (ph instanceof HTMLAnchorElement) {
        ph.href = url;
        ph.target = '_blank';
        ph.rel = 'noopener noreferrer';
        ph.title = `Open ${url}`;
      }
      img.replaceWith(ph);
    }
    const box = document.createElement('div');
    box.appendChild(frag);
    html = box.innerHTML;
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
