// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { PwaStatus } from '../src/client/components/PwaStatus.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let host: HTMLDivElement;
const originalWorker = Object.getOwnPropertyDescriptor(navigator, 'serviceWorker');
const originalOnline = Object.getOwnPropertyDescriptor(navigator, 'onLine');
const online = (value: boolean) => Object.defineProperty(navigator, 'onLine', { configurable: true, value });
const mount = async () => {
  host = document.createElement('div'); document.body.append(host);
  await act(async () => { root = createRoot(host); root.render(<PwaStatus />); });
};
beforeEach(() => { vi.stubEnv('PROD', true); vi.stubGlobal('isSecureContext', true); online(true); });
afterEach(async () => {
  await act(async () => root?.unmount()); host?.remove();
  if (originalWorker) Object.defineProperty(navigator, 'serviceWorker', originalWorker);
  else Reflect.deleteProperty(navigator, 'serviceWorker');
  if (originalOnline) Object.defineProperty(navigator, 'onLine', originalOnline);
  else Reflect.deleteProperty(navigator, 'onLine');
  vi.unstubAllGlobals(); vi.unstubAllEnvs();
});
function workerApi(registration: unknown) {
  const api = Object.assign(new EventTarget(), { controller: {}, register: vi.fn().mockResolvedValue(registration) });
  Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: api });
  return api;
}
it('shows offline limitations and clears them when the connection returns', async () => {
  vi.stubEnv('PROD', false); online(false); await mount();
  expect(host.textContent).toContain('Saved links are available');
  expect(host.textContent).toContain('search and reading need a connection');
  online(true); await act(async () => window.dispatchEvent(new Event('online')));
  expect(host.textContent).toBe('');
  online(false); await act(async () => window.dispatchEvent(new Event('offline')));
  expect(host.textContent).toContain('Offline.');
});
it('offers a waiting update and only activates it after the user asks', async () => {
  const worker = Object.assign(new EventTarget(), { postMessage: vi.fn() });
  const registration = Object.assign(new EventTarget(), { waiting: worker, installing: null });
  const api = workerApi(registration); await mount();
  expect(api.register).toHaveBeenCalledWith('/sw.js', { updateViaCache: 'none' });
  expect(worker.postMessage).not.toHaveBeenCalled();
  expect(host.textContent).toContain('Update ready.');
  await act(async () => host.querySelector('button')!.click());
  expect(worker.postMessage).toHaveBeenCalledWith({ type: 'SKIP_WAITING' });
});
it('does not mistake the first installation for an available update', async () => {
  const registration = Object.assign(new EventTarget(), { waiting: new EventTarget(), installing: null });
  const api = workerApi(registration);
  Object.assign(api, { controller: null });
  await mount(); expect(host.textContent).toBe('');
});
it('notices an update installed after startup', async () => {
  const worker = Object.assign(new EventTarget(), { postMessage: vi.fn() });
  const registration = Object.assign(new EventTarget(), { waiting: null as typeof worker | null, installing: null as typeof worker | null });
  workerApi(registration); await mount();
  expect(host.textContent).toBe('');
  registration.installing = worker;
  await act(async () => registration.dispatchEvent(new Event('updatefound')));
  registration.waiting = worker;
  await act(async () => worker.dispatchEvent(new Event('statechange')));
  expect(host.textContent).toContain('Update ready.');
});
it('reports a failed installation without claiming offline readiness', async () => {
  const api = workerApi(null); api.register.mockRejectedValue(new Error('install failed'));
  await mount(); expect(host.textContent).toContain('Offline access could not be prepared');
});
it('does not attempt registration on an insecure origin', async () => {
  vi.stubGlobal('isSecureContext', false); const api = workerApi(null);
  await mount(); expect(api.register).not.toHaveBeenCalled();
});
