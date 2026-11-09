/**
 * Fails when the built web app grows past its size budget (gzipped).
 * Run after `npm run build:client`. A big jump usually means a server-only
 * library leaked into the client; see src/core/browser.ts.
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const BUDGET_KB: Record<string, number> = { '.js': 125, '.css': 16 };
const dir = path.resolve(process.argv[2] || 'dist/assets');

if (!fs.existsSync(dir)) {
  console.error(`No build found at ${dir}. Run npm run build:client first.`);
  process.exit(1);
}

const totals: Record<string, number> = {};
for (const file of fs.readdirSync(dir)) {
  const ext = path.extname(file);
  if (!(ext in BUDGET_KB)) continue;
  totals[ext] = (totals[ext] || 0) + zlib.gzipSync(fs.readFileSync(path.join(dir, file))).length;
}

let failed = false;
for (const [ext, budget] of Object.entries(BUDGET_KB)) {
  const kb = (totals[ext] || 0) / 1024;
  const ok = kb <= budget;
  failed ||= !ok;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${ext.padEnd(5)} ${kb.toFixed(1).padStart(6)} KB gzipped (budget ${budget} KB)`);
}
process.exit(failed ? 1 : 0);
