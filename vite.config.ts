import { defineConfig } from 'vite';
// ES-module workers: the diff highlighter worker (@pierre/diffs) imports Shiki chunks.
export default defineConfig({ clearScreen: false, server: { port: 1420, strictPort: true }, build: { target: 'es2022', assetsInlineLimit: 0 }, worker: { format: 'es' } });
