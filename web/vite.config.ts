import { createHash } from 'node:crypto';
import { defineConfig, type Plugin } from 'vite';
import preact from '@preact/preset-vite';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));
const port = process.env.REDE_PORT ?? '4319';

/**
 * Built pages get a Content Security Policy: nothing loads from outside 127.0.0.1, even
 * when agent markdown slips something past the sanitizer. Not applied to the dev server,
 * which injects inline scripts.
 */
function csp(): Plugin {
  return {
    name: 'rede-csp',
    apply: 'build',
    transformIndexHtml(html) {
      const hashes = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(
        (m) => `'sha256-${createHash('sha256').update(m[1]!).digest('base64')}'`,
      );
      const policy = [
        "default-src 'self'",
        `script-src 'self' ${hashes.join(' ')}`,
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data: blob:",
        "connect-src 'self'",
        "worker-src 'self' blob:",
        "frame-src 'none'",
        "object-src 'none'",
        "base-uri 'none'",
        "form-action 'none'",
      ].join('; ');
      return html.replace('<meta charset="utf-8" />', `<meta charset="utf-8" />\n    <meta http-equiv="Content-Security-Policy" content="${policy}" />`);
    },
  };
}

export default defineConfig({
  root,
  // Absolute base: the app is served at /r/<id>, so assets must resolve from the origin root.
  base: '/',
  plugins: [preact(), csp()],
  build: {
    outDir: fileURLToPath(new URL('../dist/web', import.meta.url)),
    emptyOutDir: true,
    target: 'es2022',
    chunkSizeWarningLimit: 900,
  },
  worker: { format: 'es' },
  server: {
    port: Number(process.env.REDE_WEB_PORT ?? 5173),
    strictPort: false,
    proxy: {
      '/api': { target: `http://127.0.0.1:${port}`, changeOrigin: false },
    },
  },
});
