import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    minify: 'terser',
    terserOptions: { compress: { passes: 2 } },
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.{ts,tsx}'],
    globalSetup: ['tests/globalSetup.ts'],
    setupFiles: ['tests/setup.ts'],
    coverage: {
      provider: 'v8',
      // Code only: vitest 4+ parses every file it includes (extension/popup.html, scripts/make-icons.swift).
      include: ['server/**/*.ts', 'src/**/*.{ts,tsx}', 'plugins/**/*.ts', 'scripts/**/*.ts', 'extension/**/*.ts'],
      reporter: ['text-summary', 'json-summary', 'html'],
      reportsDirectory: '.tmp/coverage',
      // A floor, not a target: raise it as tests are added. `npm run test:coverage` (and CI) fail below it.
      // Since vitest 4, V8 coverage is mapped onto the syntax tree, which counts statements and branches the old
      // mapping missed: the same code and tests measured 89.7% of lines and 89.4% of branches on vitest 3, and
      // 86.3% (lines), 83.9% (statements), 77.8% (branches), 78.1% (functions) on vitest 5. A little under those,
      // as before, since some branches only run on macOS.
      thresholds: { lines: 85, statements: 82, branches: 76, functions: 76 },
    },
  },
});
