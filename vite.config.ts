import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const SLIM_LUCIDE_ID = '\0slim-lucide-icon';
function slimLucidePlugin() {
  return {
    name: 'slim-lucide',
    apply: 'build' as const,
    resolveId(source: string, importer?: string) {
      if (importer?.includes('lucide-react') && source.endsWith('createLucideIcon.mjs')) return SLIM_LUCIDE_ID;
      return null;
    },
    load(id: string) {
      if (id !== SLIM_LUCIDE_ID) return null;
      return `import { createElement, forwardRef } from 'react';
export default function createLucideIcon(data) {
  const nodes = data.node || [];
  return forwardRef(({ size = 24, color = 'currentColor', strokeWidth = 2, className, children, ...rest }, ref) =>
    createElement(
      'svg',
      {
        ref,
        xmlns: 'http://www.w3.org/2000/svg',
        width: size,
        height: size,
        viewBox: '0 0 24 24',
        fill: 'none',
        stroke: color,
        strokeWidth,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': rest['aria-label'] || rest['aria-labelledby'] || rest.role ? undefined : 'true',
        className,
        ...rest,
      },
      ...nodes.map(([tag, attrs], i) => createElement(tag, { ...attrs, key: i })),
      children
    )
  );
}`;
    },
    transform(code: string, id: string) {
      if (id.endsWith('lucide-react/dist/esm/lucide-react.mjs')) {
        return { code: code.replace(/import \* as index from '\.\/icons\/index\.mjs';\s*export \{ index as icons \};/, ''), map: null };
      }
      if (!id.includes('lucide-react/dist/esm/icons/')) return null;
      return {
        code: code
          .replace(/name:\s*"[^"]+",\s*size:\s*\d+,\s*/g, '')
          .replace(/,\s*key:\s*"[^"]+"/g, '')
          .replace(/__iconData\.node;\s*/g, ''),
        map: null,
      };
    },
  };
}

export default defineConfig({
  plugins: [react(), slimLucidePlugin()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    modulePreload: { polyfill: false },
    minify: 'terser',
    terserOptions: {
      module: true,
      compress: { passes: 3, ecma: 2022, pure_getters: true },
      mangle: { toplevel: true },
      format: { comments: false, ecma: 2022 },
    },
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
      // Raised in 0.6.0 (#23) back above the pre-Vitest-5 AST-mapped V8 baselines (86.3 / 83.9 / 77.8 / 78.1).
      thresholds: { lines: 87, statements: 85, branches: 82, functions: 82 },
    },
  },
});
