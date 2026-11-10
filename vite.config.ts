import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.{ts,tsx}'],
    globalSetup: ['tests/globalSetup.ts'],
    setupFiles: ['tests/setup.ts'],
    coverage: {
      provider: 'v8',
      include: ['server/**', 'src/**', 'plugins/**', 'scripts/**', 'extension/**'],
      reporter: ['text-summary', 'json-summary', 'html'],
      reportsDirectory: '.tmp/coverage',
      // A floor, not a target: raise it as tests are added. `npm run test:coverage` (and CI) fail below it.
      // A little under the measured figure (83.8 / 86.0 / 77.3), since some branches only run on macOS.
      thresholds: { lines: 82, statements: 82, branches: 84, functions: 75 },
    },
  },
});
