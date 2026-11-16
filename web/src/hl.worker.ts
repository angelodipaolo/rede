/// <reference lib="webworker" />
import hljs from 'highlight.js/lib/core';
import bash from 'highlight.js/lib/languages/bash';
import c from 'highlight.js/lib/languages/c';
import cpp from 'highlight.js/lib/languages/cpp';
import csharp from 'highlight.js/lib/languages/csharp';
import css from 'highlight.js/lib/languages/css';
import dart from 'highlight.js/lib/languages/dart';
import diff from 'highlight.js/lib/languages/diff';
import dockerfile from 'highlight.js/lib/languages/dockerfile';
import elixir from 'highlight.js/lib/languages/elixir';
import go from 'highlight.js/lib/languages/go';
import graphql from 'highlight.js/lib/languages/graphql';
import haskell from 'highlight.js/lib/languages/haskell';
import ini from 'highlight.js/lib/languages/ini';
import java from 'highlight.js/lib/languages/java';
import javascript from 'highlight.js/lib/languages/javascript';
import json from 'highlight.js/lib/languages/json';
import kotlin from 'highlight.js/lib/languages/kotlin';
import less from 'highlight.js/lib/languages/less';
import lua from 'highlight.js/lib/languages/lua';
import makefile from 'highlight.js/lib/languages/makefile';
import markdown from 'highlight.js/lib/languages/markdown';
import objectivec from 'highlight.js/lib/languages/objectivec';
import perl from 'highlight.js/lib/languages/perl';
import php from 'highlight.js/lib/languages/php';
import protobuf from 'highlight.js/lib/languages/protobuf';
import python from 'highlight.js/lib/languages/python';
import r from 'highlight.js/lib/languages/r';
import ruby from 'highlight.js/lib/languages/ruby';
import rust from 'highlight.js/lib/languages/rust';
import scala from 'highlight.js/lib/languages/scala';
import scss from 'highlight.js/lib/languages/scss';
import sql from 'highlight.js/lib/languages/sql';
import swift from 'highlight.js/lib/languages/swift';
import typescript from 'highlight.js/lib/languages/typescript';
import xml from 'highlight.js/lib/languages/xml';
import yaml from 'highlight.js/lib/languages/yaml';
import { splitHtmlLines } from './htmlLines.ts';

const langs = {
  bash, c, cpp, csharp, css, dart, diff, dockerfile, elixir, go, graphql, haskell, ini, java,
  javascript, json, kotlin, less, lua, makefile, markdown, objectivec, perl, php, protobuf, python,
  r, ruby, rust, scala, scss, sql, swift, typescript, xml, yaml,
};
for (const [name, def] of Object.entries(langs)) hljs.registerLanguage(name, def);

export interface HlRequest {
  id: number;
  text: string;
  lang: string | null;
}
export interface HlResponse {
  id: number;
  lines: string[] | null;
}

// LIFO: the most recent request is usually the file the reader is looking at now.
const queue: HlRequest[] = [];
let scheduled = false;

function pump() {
  scheduled = false;
  const req = queue.pop();
  if (!req) return;
  let lines: string[] | null = null;
  try {
    let html: string;
    if (req.lang && hljs.getLanguage(req.lang)) {
      html = hljs.highlight(req.text, { language: req.lang, ignoreIllegals: true }).value;
    } else if (req.lang === 'auto') {
      html = hljs.highlightAuto(req.text).value;
    } else {
      html = '';
    }
    lines = html ? splitHtmlLines(html) : null;
  } catch {
    lines = null;
  }
  (self as unknown as DedicatedWorkerGlobalScope).postMessage({ id: req.id, lines } satisfies HlResponse);
  if (queue.length) schedule();
}

function schedule() {
  if (scheduled) return;
  scheduled = true;
  setTimeout(pump, 0);
}

self.onmessage = (e: MessageEvent<HlRequest>) => {
  queue.push(e.data);
  schedule();
};
