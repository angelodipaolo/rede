import { defineConfig } from 'vite';
import preact from '@preact/preset-vite';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));
const port = process.env.MARGIN_PORT ?? '4319';

export default defineConfig({
  root,
  // Absolute base: the app is served at /r/<id>, so assets must resolve from the origin root.
  base: '/',
  plugins: [preact()],
  build: {
    outDir: fileURLToPath(new URL('../dist/web', import.meta.url)),
    emptyOutDir: true,
    target: 'es2022',
    chunkSizeWarningLimit: 900,
  },
  worker: { format: 'es' },
  server: {
    port: Number(process.env.MARGIN_WEB_PORT ?? 5173),
    strictPort: false,
    proxy: {
      '/api': { target: `http://127.0.0.1:${port}`, changeOrigin: false },
    },
  },
});
