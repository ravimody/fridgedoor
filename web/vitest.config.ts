import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

// jsdom screens run slowly while the server suite runs alongside (pnpm test, CI); 5 s flaked.
export default defineConfig({ plugins: [react()], test: { environment: 'jsdom', setupFiles: ['./src/test-setup.ts'], testTimeout: 15_000 } });
