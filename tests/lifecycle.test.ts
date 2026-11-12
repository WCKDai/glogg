import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createShutdown, installProcessGuards, listenErrorMessage, MIN_NODE, nodeVersionProblem } from '../server/lifecycle';

describe('nodeVersionProblem', () => {
  it('accepts the minimum and anything newer', () => {
    expect(nodeVersionProblem(MIN_NODE)).toBeNull();
    expect(nodeVersionProblem('22.13.1')).toBeNull();
    expect(nodeVersionProblem('22.14.0')).toBeNull();
    expect(nodeVersionProblem('v24.0.0')).toBeNull();
    expect(nodeVersionProblem('26.8.1')).toBeNull();
  });

  it('refuses older versions and says which one is needed', () => {
    for (const v of ['22.12.9', '22.0.0', '20.18.0', 'v18.19.1']) {
      const msg = nodeVersionProblem(v);
      expect(msg).toContain(MIN_NODE);
      expect(msg).toContain(v.replace(/^v/, ''));
    }
  });

  it('treats missing or junk parts as zero rather than throwing', () => {
    expect(nodeVersionProblem('22.13')).toBeNull();
    expect(nodeVersionProblem('22')).not.toBeNull();
    expect(nodeVersionProblem('not-a-version')).not.toBeNull();
  });
});

describe('listenErrorMessage', () => {
  const err = (code: string) => Object.assign(new Error(`listen ${code}`), { code });

  it('explains a port in use and how to pick another', () => {
    const msg = listenErrorMessage(err('EADDRINUSE'), '127.0.0.1', 4173);
    expect(msg).toContain('4173');
    expect(msg).toContain('PORT=');
  });

  it('explains privileged ports and foreign addresses', () => {
    expect(listenErrorMessage(err('EACCES'), '0.0.0.0', 80)).toContain('below 1024');
    expect(listenErrorMessage(err('EADDRNOTAVAIL'), '10.9.9.9', 4173)).toContain('HOST=127.0.0.1');
  });

  it('falls back to the system message', () => {
    expect(listenErrorMessage(err('EWHATEVER'), 'h', 1)).toContain('listen EWHATEVER');
  });
});

describe('createShutdown', () => {
  let server: http.Server | undefined;
  afterEach(() => {
    server?.closeAllConnections();
    server?.close();
    server = undefined;
  });

  const listen = async (handler: http.RequestListener = (_q, r) => r.end('ok')) => {
    server = http.createServer(handler);
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
    return (server.address() as AddressInfo).port;
  };

  it('stops listening, runs onClose, then exits 0', async () => {
    const port = await listen();
    const order: string[] = [];
    const exit = vi.fn((code: number) => order.push(`exit:${code}`));
    const shutdown = createShutdown(server!, { log: () => {}, exit, onClose: () => void order.push('close') });
    await shutdown('SIGTERM');
    expect(order).toEqual(['close', 'exit:0']);
    expect(server!.listening).toBe(false);
    await expect(fetch(`http://127.0.0.1:${port}/`)).rejects.toThrow();
  });

  it('still exits 0 when onClose throws, and says what went wrong', async () => {
    await listen();
    const logs: string[] = [];
    const exit = vi.fn();
    const shutdown = createShutdown(server!, {
      log: (m) => logs.push(m),
      exit,
      onClose: () => {
        throw new Error('db already closed');
      },
    });
    await shutdown('SIGINT');
    expect(exit).toHaveBeenCalledWith(0);
    expect(logs.join('\n')).toContain('db already closed');
  });

  it('exits at once on a second signal', async () => {
    await listen();
    const exit = vi.fn();
    const shutdown = createShutdown(server!, { log: () => {}, exit });
    const first = shutdown('SIGINT');
    await shutdown('SIGINT');
    expect(exit).toHaveBeenCalledWith(1);
    await first;
  });

  it('gives a hanging request a deadline, then exits 1', async () => {
    const port = await listen(() => {
      /* never answers */
    });
    const pending = fetch(`http://127.0.0.1:${port}/`).catch(() => null);
    await new Promise((r) => setTimeout(r, 50));
    const exit = vi.fn();
    const shutdown = createShutdown(server!, { log: () => {}, exit, timeoutMs: 100 });
    void shutdown('SIGTERM');
    await new Promise((r) => setTimeout(r, 300));
    expect(exit).toHaveBeenCalledWith(1);
    await pending;
  });
});

describe('installProcessGuards', () => {
  it('logs unhandled rejections instead of crashing, and can be removed', () => {
    const logs: string[] = [];
    const before = process.listenerCount('unhandledRejection');
    const remove = installProcessGuards((m) => logs.push(m));
    expect(process.listenerCount('unhandledRejection')).toBe(before + 1);
    process.emit('unhandledRejection', new Error('upstream exploded'), Promise.resolve());
    expect(logs[0]).toContain('upstream exploded');
    remove();
    expect(process.listenerCount('unhandledRejection')).toBe(before);
  });
});
