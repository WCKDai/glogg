import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, expect, it, vi } from 'vitest';
import { useTempGloggHome } from './helpers.js';

useTempGloggHome();
const search = await import('../server/federatedSearch.js');
const { searchBitmagnetGraphQL } = await import('../server/p2pIndexer.js');
const { fetchUpstream } = await import('../server/upstream.js');
afterEach(() => { vi.unstubAllGlobals(); search.clearSearchCache(); search.resetSourceHealth(); });

it('closes upstream bodies that stall after headers, even after search returns early', async () => {
  let closed = 0;
  const upstream = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.write('{');
    res.on('close', () => closed++);
  });
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
  const fetch = globalThis.fetch;
  vi.stubGlobal('fetch', (input: string | URL | Request, init?: RequestInit) => {
    const href = String(input);
    return href.startsWith(url) ? fetch(input, init) : Promise.resolve(new Response('', { status: 404 }));
  });
  let bitmagnetDone = false;
  const bitmagnet = searchBitmagnetGraphQL('test', url).then(() => { bitmagnetDone = true; });
  try {
    await search.executeFederatedSearch('site:example.com timeout', { endpoints: { searxngUrl: url } });
    await new Promise((resolve) => setTimeout(resolve, 2600));
    expect(bitmagnetDone).toBe(true);
    expect(closed).toBe(2);
  } finally {
    upstream.closeAllConnections();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
    await bitmagnet;
  }
}, 10_000);

it.each([404, 500])('cancels a stalled HTTP %s body before freeing upstream work', async (status) => {
  let closed = false;
  const upstream = http.createServer((_req, res) => {
    res.writeHead(status, { 'Content-Type': 'text/html' }); res.write('error page');
    res.on('close', () => { closed = true; });
  });
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  try {
    const response = await fetchUpstream(`http://127.0.0.1:${(upstream.address() as AddressInfo).port}`);
    expect(response.status).toBe(status);
    await vi.waitFor(() => expect(closed).toBe(true), { timeout: 500 });
  } finally { upstream.closeAllConnections(); await new Promise<void>((r) => upstream.close(() => r())); }
});
