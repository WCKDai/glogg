/**
 * Runs once per test run, outside the test files. Every temporary glogg home of
 * the run lives under one folder in the repo's ignored .tmp/, removed at the
 * end, so test runs don't leave anything behind. (Plugins are imported from
 * these homes, which the test runner only allows inside the project.)
 */
import fs from 'node:fs';
import path from 'node:path';
import type { TestProject } from 'vitest/node';

const STALE_MS = 60 * 60_000;

export default function setup(project: TestProject) {
  const root = path.resolve(import.meta.dirname, '..', '.tmp');
  fs.mkdirSync(root, { recursive: true });
  // Clear what older runs left: their folders, and the per-test homes made before this setup existed.
  // Only folders untouched for an hour, so a run going on in parallel keeps its own.
  for (const name of fs.readdirSync(root)) {
    if (!/^(run|home)-/.test(name)) continue;
    const dir = path.join(root, name);
    try {
      if (Date.now() - fs.statSync(dir).mtimeMs > STALE_MS) fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // gone already
    }
  }
  const runRoot = fs.mkdtempSync(path.join(root, 'run-'));
  project.provide('tmpRoot', runRoot);
  return () => fs.rmSync(runRoot, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
}

declare module 'vitest' {
  export interface ProvidedContext {
    tmpRoot: string;
  }
}
