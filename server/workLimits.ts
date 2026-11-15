import type { RequestHandler } from 'express';
import { envNumber } from './env.js';

export class BusyError extends Error {
  readonly status = 503;
  constructor() { super('This glogg is busy. Please try again shortly.'); }
}

/** No waiting queue: reject excess work before it allocates upstream requests. */
export function createWorkLimit(max: number) {
  if (!Number.isSafeInteger(max) || max < 1) throw new Error('Work limit must be a positive integer');
  let active = 0;
  return {
    get active() { return active; },
    acquire(): () => void {
      if (active >= max) throw new BusyError();
      active++;
      let released = false;
      return () => { if (!released) { released = true; active--; } };
    },
  };
}

export function configuredLimit(name: string, fallback: number): number {
  return Math.min(10_000, Math.floor(envNumber(name, fallback, { min: 1 })));
}

/** This separate HTTP bound includes body parsing; search permits outlive responses. */
export function apiCapacity(max = configuredLimit('GLOGG_MAX_API_REQUESTS', 64)): RequestHandler {
  const limit = createWorkLimit(max);
  return (req, res, next) => {
    if (!req.path.startsWith('/api/') || ['/api/health', '/api/capabilities'].includes(req.path)) return next();
    let release: () => void;
    try { release = limit.acquire(); }
    catch { res.setHeader('Retry-After', '1'); res.setHeader('Cache-Control', 'no-store'); res.status(503).json({ error: new BusyError().message }); return; }
    res.once('finish', release);
    res.once('close', release);
    next();
  };
}

/** Keep the permit until all launched work settles, including work past an early response. */
export function runWithCapacity<T>(
  limit: ReturnType<typeof createWorkLimit>,
  run: (track: <V>(work: Promise<V>) => Promise<V>) => Promise<T>
): Promise<T> {
  const release = limit.acquire();
  const pending = new Set<Promise<unknown>>();
  const track = <V>(work: Promise<V>): Promise<V> => {
    pending.add(work);
    void work.then(() => pending.delete(work), () => pending.delete(work));
    return work;
  };
  const finish = () => { void Promise.allSettled([...pending]).then(release); };
  try { return run(track).finally(finish); }
  catch (error) { finish(); throw error; }
}
