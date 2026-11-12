/**
 * Numbers from the environment. Docker Compose passes unset settings on as empty
 * strings (`${NAME:-}`), and a typo shouldn't turn a deadline into NaN, which
 * setTimeout treats as zero. So: empty means the default, and junk means the
 * default with a warning.
 */
const warned = new Set<string>();

export function envNumber(
  name: string,
  fallback: number,
  opts: { min?: number; env?: NodeJS.ProcessEnv; warn?: (msg: string) => void } = {}
): number {
  const env = opts.env ?? process.env;
  const raw = env[name]?.trim();
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  const min = opts.min ?? 0;
  if (Number.isFinite(n) && n >= min) return n;
  const warn = opts.warn ?? ((m: string) => console.warn(m));
  if (!warned.has(name) || opts.warn) {
    warned.add(name);
    warn(`${name}=${JSON.stringify(raw)} isn't a number ≥ ${min}; using ${fallback}.`);
  }
  return fallback;
}
