/**
 * Fails when the built web app grows past its size budget (gzipped).
 * Run after `npm run build:client`. A big jump usually means a server-only
 * library leaked into the client; see src/core/browser.ts.
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

export const BUDGET_KB: Record<string, number> = { '.js': 125, '.css': 16 };

export function checkBundle(targetDir = 'dist/assets', budgets: Record<string, number> = BUDGET_KB): {
  ok: boolean;
  lines: string[];
  totalsKb: Record<string, number>;
} {
  const dir = path.resolve(targetDir);
  if (!fs.existsSync(dir)) {
    return { ok: false, lines: [`No build found at ${dir}. Run npm run build:client first.`], totalsKb: {} };
  }

  const totals: Record<string, number> = {};
  for (const file of fs.readdirSync(dir)) {
    const ext = path.extname(file);
    if (!(ext in budgets)) continue;
    totals[ext] = (totals[ext] || 0) + zlib.gzipSync(fs.readFileSync(path.join(dir, file))).length;
  }

  let failed = false;
  const lines: string[] = [];
  const totalsKb: Record<string, number> = {};
  for (const [ext, budget] of Object.entries(budgets)) {
    const kb = (totals[ext] || 0) / 1024;
    totalsKb[ext] = kb;
    const ok = kb <= budget;
    failed ||= !ok;
    lines.push(`${ok ? 'ok  ' : 'FAIL'} ${ext.padEnd(5)} ${kb.toFixed(1).padStart(6)} KB gzipped (budget ${budget} KB)`);
  }
  return { ok: !failed, lines, totalsKb };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const res = checkBundle(process.argv[2] || 'dist/assets');
  for (const line of res.lines) {
    (res.ok ? console.log : console.error)(line);
  }
  process.exit(res.ok ? 0 : 1);
}
