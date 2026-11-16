/**
 * Splits highlight.js HTML into one fragment per source line. Spans that cross a
 * line break are closed at the end of the line and reopened at the start of the next,
 * so every fragment is balanced and can render on its own.
 */
export function splitHtmlLines(html: string): string[] {
  const lines: string[] = [];
  const stack: string[] = [];
  let cur = '';
  let i = 0;
  const n = html.length;
  while (i < n) {
    const ch = html.charCodeAt(i);
    if (ch === 60 /* < */) {
      const end = html.indexOf('>', i);
      const tag = html.slice(i, end + 1);
      if (tag.charCodeAt(1) === 47 /* / */) stack.pop();
      else stack.push(tag);
      cur += tag;
      i = end + 1;
    } else if (ch === 10 /* \n */) {
      lines.push(cur + '</span>'.repeat(stack.length));
      cur = stack.join('');
      i++;
    } else {
      let j = i;
      while (j < n) {
        const c = html.charCodeAt(j);
        if (c === 60 || c === 10) break;
        j++;
      }
      cur += html.slice(i, j);
      i = j;
    }
  }
  lines.push(cur + '</span>'.repeat(stack.length));
  return lines;
}

export function escapeHtml(s: string): string {
  let out = '';
  let last = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    let rep: string | null = null;
    if (c === 38) rep = '&amp;';
    else if (c === 60) rep = '&lt;';
    else if (c === 62) rep = '&gt;';
    else if (c === 34) rep = '&quot;';
    if (rep) {
      out += s.slice(last, i) + rep;
      last = i + 1;
    }
  }
  return last === 0 ? s : out + s.slice(last);
}

/**
 * Wraps character ranges [start, end) of the line's text in <mark>. Works on
 * highlighted HTML: entities count as one character, and the mark is closed and
 * reopened around tags so nesting stays valid.
 */
export function markRanges(html: string, ranges: [number, number][]): string {
  if (!ranges.length) return html;
  let out = '';
  let pos = 0;
  let ri = 0;
  let inMark = false;
  let i = 0;
  const n = html.length;
  while (i < n) {
    const c = html[i];
    if (c === '<') {
      const end = html.indexOf('>', i);
      const tag = html.slice(i, end + 1);
      out += inMark ? '</mark>' + tag + '<mark>' : tag;
      i = end + 1;
      continue;
    }
    while (inMark && ri < ranges.length && pos >= ranges[ri]![1]) {
      out += '</mark>';
      inMark = false;
      ri++;
    }
    while (!inMark && ri < ranges.length && pos >= ranges[ri]![1]) ri++;
    if (!inMark && ri < ranges.length && pos >= ranges[ri]![0]) {
      out += '<mark>';
      inMark = true;
    }
    if (c === '&') {
      const semi = html.indexOf(';', i);
      out += html.slice(i, semi + 1);
      i = semi + 1;
    } else {
      out += c;
      i++;
    }
    pos++;
  }
  if (inMark) out += '</mark>';
  return out.replace(/<mark><\/mark>/g, '');
}
