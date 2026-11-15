import http from 'node:http';
import net from 'node:net';
import { fetch as undiciFetch } from 'undici';
import { afterEach, expect, it, vi } from 'vitest';
import { publicFetch } from '../server/publicFetch.js';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

it.each([false, true])('connects only to the validated address with lookup all=%s, preserving Host and a delayed response body', async (all) => {
  vi.stubEnv('GLOGG_ALLOW_PRIVATE_FETCH', '');
  const hits: string[] = [];
  const publicSite = http.createServer((req, res) => {
    hits.push(`public:${req.headers.host}`);
    res.write('article ');
    setTimeout(() => res.end('completed'), 30);
  });
  const privateSite = http.createServer((_req, res) => { hits.push('private'); res.end('private service'); });
  for (const server of [publicSite, privateSite]) await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const selected: string[] = [];
  // Model a DNS rebind at the socket boundary. Every physical connection stays on loopback.
  vi.spyOn(net, 'connect').mockImplementation(((options: net.TcpNetConnectOpts) => {
    const socket = new net.Socket();
    const route = (address: string) => {
      selected.push(address);
      const target = address === '93.184.216.34' ? publicSite : privateSite;
      socket.connect({ host: '127.0.0.1', port: (target.address() as net.AddressInfo).port });
    };
    if (options.lookup) options.lookup(options.host!, { all, family: all ? 4 : 0 }, (error, address) => {
      if (error) socket.destroy(error);
      else route(typeof address === 'string' ? address : address[0].address);
    });
    else route('127.0.0.1'); // A second, unpinned DNS lookup changes the destination.
    return socket;
  }) as typeof net.connect);
  vi.stubGlobal('fetch', undiciFetch as unknown as typeof fetch);
  try {
    const lookup = vi.fn(async () => [{ address: '93.184.216.34' }]);
    const response = await publicFetch('http://rebinding.example/article', { signal: AbortSignal.timeout(2000) }, lookup);
    expect(await response.text()).toBe('article completed');
    expect(lookup).toHaveBeenCalledOnce();
    expect(selected).toEqual(['93.184.216.34']);
    expect(hits).toEqual(['public:rebinding.example']);
  } finally {
    for (const server of [publicSite, privateSite]) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }
});

it('does not start transport after cancellation during DNS resolution', async () => {
  vi.stubEnv('GLOGG_ALLOW_PRIVATE_FETCH', '');
  let resolve!: (value: { address: string }[]) => void;
  const fetch = vi.fn(async () => new Response('should not fetch'));
  vi.stubGlobal('fetch', fetch);
  const controller = new AbortController();
  const pending = publicFetch('https://cancelled.example', { signal: controller.signal }, () => new Promise((r) => { resolve = r; }));
  controller.abort(); resolve([{ address: '93.184.216.34' }]);
  await expect(pending).rejects.toThrow();
  expect(fetch).not.toHaveBeenCalled();
});

it('cancels the redirect body when redirects are forbidden', async () => {
  const cancelled = vi.fn();
  vi.stubGlobal('fetch', async () => new Response(new ReadableStream({ start(c) { c.enqueue(new Uint8Array([1])); }, cancel: cancelled }), { status: 302, headers: { Location: '/next' } }));
  await expect(publicFetch('https://example.com', { redirect: 'error' })).rejects.toThrow('Redirected');
  expect(cancelled).toHaveBeenCalledOnce();
});
