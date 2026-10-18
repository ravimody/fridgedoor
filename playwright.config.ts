import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  use: { baseURL: 'http://127.0.0.1:4173', ...devices['Desktop Chrome'] },
  webServer: { command: 'pnpm --filter @fridgedoor/web dev --host 127.0.0.1', url: 'http://127.0.0.1:4173/dashboard/', reuseExistingServer: true },
});
