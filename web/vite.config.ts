import react from '@vitejs/plugin-react';
import { defineConfig, type ProxyOptions } from 'vite';

// In development the API runs separately (`pnpm --filter @fridgedoor/server dev`, port 8080).
// Requests keep the browser's Host and Origin (no changeOrigin), so start the server with
// PUBLIC_URL=http://127.0.0.1:4173 and its origin and CSRF checks see the address you browse.
const API = process.env.FRIDGEDOOR_API ?? 'http://127.0.0.1:8080';
const PROXIED = ['/dashboard/api', '/dashboard/native', '/dashboard/google', '/native', '/calendar', '/healthz'];
const proxy: ProxyOptions = { target: API, changeOrigin: false, xfwd: true };

export default defineConfig({
  base: '/pwa/',
  plugins: [react(), {
    name: 'dashboard-dev-rewrite',
    configureServer(server) {
      server.middlewares.use((request, _response, next) => {
        const url = request.url ?? '';
        if (url.startsWith('/dashboard') && !PROXIED.some((prefix) => url.startsWith(prefix))) request.url = `/pwa${url.slice('/dashboard'.length) || '/'}`;
        next();
      });
    },
  }],
  appType: 'spa',
  server: { host: '127.0.0.1', port: 4173, strictPort: true, proxy: Object.fromEntries(PROXIED.map((prefix) => [prefix, proxy])) },
  preview: { host: '127.0.0.1', port: 4173, strictPort: true },
});
