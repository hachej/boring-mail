import { defineConfig } from '@playwright/test'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export default defineConfig({
  testDir: './e2e',
  outputDir: join(tmpdir(), 'boring-mail-playwright-results'),
  fullyParallel: false,
  forbidOnly: true,
  retries: 0,
  reporter: [['line']],
  use: {
    screenshot: 'off',
    trace: 'off',
    video: 'off',
  },
})
