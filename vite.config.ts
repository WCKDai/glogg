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
    },
  },
});
