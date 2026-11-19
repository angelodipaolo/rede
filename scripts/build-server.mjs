// Bundles the CLI and server into dist/cli.js. The bundle embeds its build time
// (__REDE_BUILD__): every copy of one build, such as the one inside Rede.app, has the same stamp,
// and a newer build replaces an older running server.
import { build } from 'esbuild';

await build({
  entryPoints: ['src/cli/main.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  outfile: 'dist/cli.js',
  banner: { js: '#!/usr/bin/env node' },
  define: { __REDE_BUILD__: String(Date.now()) },
  logLevel: 'info',
});
