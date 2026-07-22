import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const projectRoot = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig(({ command }) => {
  const proxyTarget = process.env.TAU_PROXY_TARGET || 'http://127.0.0.1:3000';
  const webSocketTarget = proxyTarget.replace(/^http/, 'ws');

  return {
    root: path.join(projectRoot, 'src/web'),
    base: command === 'serve' ? '/' : '/react/',
    plugins: [react(), tailwindcss()],
    server: {
      host: '127.0.0.1',
      port: 5173,
      proxy: {
        '/api': { target: proxyTarget, changeOrigin: true },
        '/ws': { target: webSocketTarget, changeOrigin: true, ws: true },
      },
    },
    build: {
      outDir: path.join(projectRoot, 'dist/web'),
      emptyOutDir: true,
      sourcemap: false,
    },
  };
});
