'use strict';

const { defineConfig, devices } = require('@playwright/test');

const PORT = process.env.PLAYWRIGHT_PORT || '3107';
const baseURL = process.env.PLAYWRIGHT_BASE_URL || `http://127.0.0.1:${PORT}`;

module.exports = defineConfig({
  testDir: './tests/ux/browser',
  timeout: 30_000,
  workers: 1,
  expect: {
    timeout: 5_000
  },
  fullyParallel: false,
  reporter: [['list']],
  use: {
    baseURL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off'
  },
  webServer: process.env.PLAYWRIGHT_SKIP_WEBSERVER
    ? undefined
    : {
        command: 'node tests/ux/start-server.js',
        url: `${baseURL}/healthz`,
        reuseExistingServer: !process.env.CI,
        timeout: 120_000,
        env: {
          ...process.env,
          PORT,
          NODE_ENV: 'test',
          DATABASE_DRIVER: 'sqljs',
          STORAGE_DRIVER: 'local',
          DISABLE_BACKGROUND_WORKER: '1',
          SESSION_SECRET: process.env.SESSION_SECRET || 'playwright-session-secret-for-tests-32ch',
          BOOTSTRAP_ADMIN_TOKEN: process.env.BOOTSTRAP_ADMIN_TOKEN || 'playwright-bootstrap-token'
        }
      },
  projects: [
    {
      name: 'chromium-desktop',
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1280, height: 900 }
      }
    },
    {
      name: 'chromium-mobile',
      use: {
        ...devices['Pixel 7']
      }
    }
  ]
});
