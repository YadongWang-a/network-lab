import { defineConfig } from '@playwright/test';

// WF-12 最小冒烟 E2E：dev server 由 Playwright 拉起（vite 端口 5273，strictPort）。
export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 90_000,
  use: {
    baseURL: 'http://127.0.0.1:5273',
    navigationTimeout: 60_000,
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'pnpm dev',
    url: 'http://127.0.0.1:5273',
    reuseExistingServer: true,
    timeout: 60_000,
  },
});
