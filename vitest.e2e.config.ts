import { defineConfig } from 'vitest/config';

/** The browser tests (tests/e2e): headless Chrome against the built app. `npm run build && npm run test:e2e` */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/e2e/**/*.e2e.ts'],
    globalSetup: ['tests/globalSetup.ts'],
    setupFiles: ['tests/setup.ts'],
    testTimeout: 30_000,
    hookTimeout: 60_000,
    fileParallelism: false,
  },
});
