import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests/e2e', timeout: 45_000, expect: { timeout: 12_000 }, workers: 1,
  use: { baseURL: 'http://127.0.0.1:4317', viewport: { width: 1440, height: 1000 },
    launchOptions: process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {},
    screenshot: 'only-on-failure', trace: 'retain-on-failure' },
  webServer: { command: 'node scripts/dev.mjs', url: 'http://127.0.0.1:4317/test/health', reuseExistingServer: !process.env.CI, timeout: 90_000 },
});
