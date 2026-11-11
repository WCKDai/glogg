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

// jsdom reports CSS it can't parse straight to the terminal, and since vitest 4 nothing quiets it: the extension's
// hostile-page tests feed it junk <style> on purpose, 67 stack traces a run. That one complaint is dropped here;
// anything else jsdom reports still shows. (`_virtualConsole` is jsdom's own handle on the window's console.)
const jsdomConsole = (globalThis as { window?: { _virtualConsole?: NodeJS.EventEmitter } }).window?._virtualConsole;
if (jsdomConsole) {
  const forward = jsdomConsole.listeners('jsdomError') as ((e: Error) => void)[];
  jsdomConsole.removeAllListeners('jsdomError');
  jsdomConsole.on('jsdomError', (e: Error) => {
    if (!e.message.startsWith('Could not parse CSS stylesheet')) for (const f of forward) f(e);
  });
}
