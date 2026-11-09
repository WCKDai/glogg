/** Shared fixtures for the test suites. Nothing here touches the network. */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import type { RawSearchResult } from '../src/core/index.js';

/**
 * Points GLOGG_HOME at a fresh dir so tests never touch ~/.glogg. It lives in the
 * repo's ignored .tmp/ because the test runner won't import plugins from outside the project.
 */
export function useTempGloggHome(): string {
  const root = path.resolve(import.meta.dirname, '..', '.tmp');
  fs.mkdirSync(root, { recursive: true });
  const dir = fs.mkdtempSync(path.join(root, 'home-'));
  process.env.GLOGG_HOME = dir;
  return dir;
}

export interface Fixture {
  baseUrl: string;
  hits: string[];
  close: () => Promise<void>;
}

type Route = { status?: number; headers?: Record<string, string>; body?: string; delayMs?: number };

/** A local HTTP server answering from a route table; unknown paths get 404. */
export async function fixtureServer(routes: Record<string, Route | ((req: http.IncomingMessage) => Route)>): Promise<Fixture> {
  const hits: string[] = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url || '/', 'http://x');
    hits.push(`${req.method} ${url.pathname}`);
    const entry = routes[url.pathname];
    const route: Route = typeof entry === 'function' ? entry(req) : entry || { status: 404, body: 'not found' };
    const send = () => {
      res.writeHead(route.status ?? 200, { 'Content-Type': 'text/html; charset=utf-8', ...(route.headers || {}) });
      res.end(req.method === 'HEAD' ? undefined : route.body ?? '');
    };
    if (route.delayMs) setTimeout(send, route.delayMs);
    else send();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    hits,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

export async function startGloggServer(): Promise<{ baseUrl: string; port: number; close: () => Promise<void> }> {
  process.env.NODE_ENV = 'production';
  const { createGloggServer } = await import('../server/index.js');
  const app = await createGloggServer();
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    port,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** Raw request with full header control (fetch won't let tests set Host). */
export function rawRequest(
  port: number,
  opts: { method?: string; path: string; headers?: Record<string, string>; body?: string }
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, method: opts.method || 'GET', path: opts.path, headers: opts.headers },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve({ status: res.statusCode || 0, headers: res.headers, body }));
      }
    );
    req.on('error', reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

let seq = 0;
export function raw(partial: Partial<RawSearchResult> & { url: string }): RawSearchResult {
  return { title: `Result ${++seq}`, snippet: '', source: 'web', ...partial };
}

/** Median and p95 of a list of timings in ms. */
export function stats(samples: number[]): { median: number; p95: number; max: number } {
  const s = [...samples].sort((a, b) => a - b);
  const at = (q: number) => s[Math.min(s.length - 1, Math.floor(q * (s.length - 1)))];
  return { median: at(0.5), p95: at(0.95), max: s[s.length - 1] };
}
