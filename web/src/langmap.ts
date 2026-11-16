/** Maps a path to a highlight.js language name registered in the worker. No hljs import here. */
const EXT: Record<string, string> = {
  ts: 'typescript', tsx: 'typescript', mts: 'typescript', cts: 'typescript',
  js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
  json: 'json', jsonc: 'json', json5: 'json',
  css: 'css', scss: 'scss', less: 'less',
  html: 'xml', htm: 'xml', xml: 'xml', svg: 'xml', vue: 'xml', svelte: 'xml', plist: 'xml',
  md: 'markdown', markdown: 'markdown', mdx: 'markdown',
  py: 'python', pyi: 'python',
  go: 'go', rs: 'rust', java: 'java', kt: 'kotlin', kts: 'kotlin', swift: 'swift',
  c: 'c', h: 'c', cc: 'cpp', cpp: 'cpp', cxx: 'cpp', hpp: 'cpp', hh: 'cpp', hxx: 'cpp',
  m: 'objectivec', mm: 'objectivec', cs: 'csharp', rb: 'ruby', php: 'php',
  sh: 'bash', bash: 'bash', zsh: 'bash', fish: 'bash',
  yml: 'yaml', yaml: 'yaml', sql: 'sql', toml: 'ini', ini: 'ini', cfg: 'ini', conf: 'ini',
  diff: 'diff', patch: 'diff', lua: 'lua', graphql: 'graphql', gql: 'graphql', proto: 'protobuf',
  scala: 'scala', dart: 'dart', ex: 'elixir', exs: 'elixir', hs: 'haskell', pl: 'perl', r: 'r',
};

const NAMES: Record<string, string> = {
  dockerfile: 'dockerfile', makefile: 'makefile', gnumakefile: 'makefile', gemfile: 'ruby',
  rakefile: 'ruby', '.bashrc': 'bash', '.zshrc': 'bash', '.env': 'bash',
};

const ALIASES: Record<string, string> = {
  ts: 'typescript', typescript: 'typescript', tsx: 'typescript', js: 'javascript', javascript: 'javascript',
  jsx: 'javascript', json: 'json', css: 'css', scss: 'scss', html: 'xml', xml: 'xml', md: 'markdown',
  markdown: 'markdown', py: 'python', python: 'python', go: 'go', golang: 'go', rs: 'rust', rust: 'rust',
  java: 'java', kotlin: 'kotlin', swift: 'swift', c: 'c', cpp: 'cpp', 'c++': 'cpp', objc: 'objectivec',
  cs: 'csharp', csharp: 'csharp', rb: 'ruby', ruby: 'ruby', php: 'php', sh: 'bash', bash: 'bash',
  shell: 'bash', zsh: 'bash', console: 'bash', yaml: 'yaml', yml: 'yaml', sql: 'sql', toml: 'ini',
  ini: 'ini', diff: 'diff', lua: 'lua', graphql: 'graphql', proto: 'protobuf', scala: 'scala',
  dockerfile: 'dockerfile', makefile: 'makefile', dart: 'dart', elixir: 'elixir', haskell: 'haskell',
};

export function langForPath(path: string): string | null {
  const base = path.slice(path.lastIndexOf('/') + 1).toLowerCase();
  if (NAMES[base]) return NAMES[base];
  if (base.startsWith('dockerfile')) return 'dockerfile';
  const dot = base.lastIndexOf('.');
  if (dot < 0) return null;
  return EXT[base.slice(dot + 1)] ?? null;
}

export function langForFence(info: string): string | null {
  return ALIASES[info.trim().toLowerCase()] ?? null;
}
