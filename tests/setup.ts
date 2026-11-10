/**
 * Runs before every test file. Tests never reach the internet: a request to
 * anything but this machine fails at once, naming the address, instead of
 * waiting on the network and passing or failing by luck. Stub fetch, or serve
 * a fixture on 127.0.0.1 (helpers.ts), to test code that goes online.
 */
const realFetch = globalThis.fetch;

// Fixtures live on 127.0.0.1, so glogg may fetch private addresses here; tests of that guard turn it back off.
process.env.GLOGG_ALLOW_PRIVATE_FETCH ??= '1';

const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

export function isLocalUrl(input: string | URL | Request): boolean {
  const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  let url: URL;
  try {
    url = new URL(href, 'http://localhost');
  } catch {
    return true; // fetch itself rejects it
  }
  if (url.protocol === 'data:' || url.protocol === 'blob:') return true;
  return LOCAL_HOSTS.has(url.hostname) || url.hostname.endsWith('.localhost');
}

globalThis.fetch = function guardedFetch(input: string | URL | Request, init?: RequestInit) {
  if (!isLocalUrl(input)) {
    const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    return Promise.reject(new TypeError(`Tests must not reach the network: ${href}`));
  }
  return realFetch(input, init);
} as typeof fetch;
