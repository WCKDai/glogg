/**
 * Process lifecycle: a clear message when glogg can't listen, a Node version check,
 * a clean shutdown on SIGINT/SIGTERM, and stray promise rejections logged instead of
 * taking the whole server down mid-search.
 */
import type { Server } from 'node:http';

export const MIN_NODE = '22.13.0';

function parts(v: string): number[] {
  return v
    .replace(/^v/, '')
    .split('.')
    .map((n) => Number.parseInt(n, 10) || 0);
}

/** A sentence explaining why this Node is too old, or null when it's new enough. */
export function nodeVersionProblem(version: string = process.versions.node, min: string = MIN_NODE): string | null {
  const have = parts(version);
  const need = parts(min);
  for (let i = 0; i < 3; i++) {
    if ((have[i] ?? 0) > (need[i] ?? 0)) return null;
    if ((have[i] ?? 0) < (need[i] ?? 0)) {
      return `glogg needs Node.js ${min} or newer (this is ${version.replace(/^v/, '')}). The deep index uses node:sqlite, which older versions lack. Install a current Node from https://nodejs.org or with nvm/fnm.`;
    }
  }
  return null;
}

/** What to tell someone whose glogg couldn't open its port. */
export function listenErrorMessage(err: NodeJS.ErrnoException, host: string, port: number): string {
  switch (err.code) {
    case 'EADDRINUSE':
      return `Port ${port} on ${host} is already in use; another glogg may be running. Stop it, or start this one with PORT=<another port>.`;
    case 'EACCES':
      return `Not allowed to listen on ${host}:${port}. Ports below 1024 need extra privileges; use PORT=4173 or another high port.`;
    case 'EADDRNOTAVAIL':
      return `${host} isn't an address of this machine. Use HOST=127.0.0.1 (this machine only) or HOST=0.0.0.0 (every interface).`;
    default:
      return `glogg couldn't listen on ${host}:${port}: ${err.message}`;
  }
}

export interface ShutdownOptions {
  /** Run once the server stops accepting connections (close databases, stop timers). */
  onClose?: () => void | Promise<void>;
  /** Give open requests this long before exiting anyway. */
  timeoutMs?: number;
  log?: (msg: string) => void;
  exit?: (code: number) => void;
}

/**
 * Returns a shutdown function: stop accepting connections, close idle keep-alive sockets,
 * run `onClose`, and exit. A second call (a second Ctrl-C) exits at once.
 */
export function createShutdown(server: Server, opts: ShutdownOptions = {}): (signal: string) => Promise<void> {
  const log = opts.log ?? ((m: string) => console.log(m));
  const exit = opts.exit ?? ((code: number) => process.exit(code));
  const timeoutMs = opts.timeoutMs ?? 5000;
  let stopping = false;
  return async (signal: string) => {
    if (stopping) {
      exit(1);
      return;
    }
    stopping = true;
    log(`glogg: ${signal} received, shutting down…`);
    const force = setTimeout(() => {
      log('glogg: open requests took too long; exiting anyway.');
      server.closeAllConnections?.();
      exit(1);
    }, timeoutMs);
    force.unref?.();
    const closed = new Promise<void>((resolve) => server.close(() => resolve()));
    server.closeIdleConnections?.();
    await closed;
    try {
      await opts.onClose?.();
    } catch (e) {
      log(`glogg: error while shutting down: ${e instanceof Error ? e.message : String(e)}`);
    }
    clearTimeout(force);
    exit(0);
  };
}

/** Logs rejections nobody handled, rather than letting one upstream's failure stop every search. */
export function installProcessGuards(log: (msg: string) => void = (m) => console.error(m)): () => void {
  const onRejection = (reason: unknown) => {
    log(`glogg: unhandled rejection: ${reason instanceof Error ? (reason.stack ?? reason.message) : String(reason)}`);
  };
  process.on('unhandledRejection', onRejection);
  return () => {
    process.off('unhandledRejection', onRejection);
  };
}
