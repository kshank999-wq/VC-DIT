import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * The renderer on its own, in a browser, with the demo day and no Electron:
 * `npm run dev:renderer -w @vcdit/desktop`. For working on screens; the
 * license is the developer build's (unlocked).
 */
const version = (JSON.parse(readFileSync(resolve(__dirname, 'package.json'), 'utf8')) as { version: string }).version;

export default defineConfig({
  root: resolve(__dirname, 'src/renderer'),
  plugins: [react()],
  define: { __APP_VERSION__: JSON.stringify(version) },
  server: { port: 5199, strictPort: true },
});
