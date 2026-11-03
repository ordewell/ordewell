import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

const here = (relPath: string): string => fileURLToPath(new URL(relPath, import.meta.url));

// The renderer is served from app://renderer/ when built (security.ts) and
// from this dev server in development; the policy for each is in shared/csp.ts.
export default defineConfig({
  root: here('./src/renderer'),
  base: './',
  plugins: [react()],
  // Module workers: Monaco's are bundled as files of the app (renderer/monaco), which
  // script-src 'self' serves; the default IIFE format cannot import shared chunks.
  worker: { format: 'es' },
  server: { host: '127.0.0.1', port: 5183, strictPort: true },
  build: {
    outDir: here('./dist/renderer'),
    emptyOutDir: true,
    // No inline asset: `data:` is allowed for images only, and a font or
    // script inlined as one would be refused by the policy.
    assetsInlineLimit: 0,
  },
});
