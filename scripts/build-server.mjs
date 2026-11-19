// Bundles the CLI and server into dist/cli.js, and the desktop app's main process into
// dist/app-src/main.cjs. Both embed the same build time (__REDE_BUILD__): every copy of one build,
// such as the one inside Rede.app, has the same stamp, and a newer build replaces an older
// running server.
import { build } from 'esbuild';

const define = { __REDE_BUILD__: String(Date.now()) };

await build({
  entryPoints: ['src/cli/main.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  outfile: 'dist/cli.js',
  banner: { js: '#!/usr/bin/env node' },
  define,
  logLevel: 'info',
});

await build({
  entryPoints: ['app/main.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  outfile: 'dist/app-src/main.cjs',
  external: ['electron'],
  define,
  logLevel: 'info',
});
