// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AtlasView } from '../src/client/views/AtlasView.js';
import { FeaturesContext, PRIVATE_FEATURES, SAFE_FEATURES } from '../src/client/capabilities.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const site = { title: 'Useful small site', url: 'https://small.example/', domain: 'small.example', description: 'Independent notes.', category: 'essays-culture', tags: [], era: 'pre-llm' };
let container: HTMLDivElement, root: Root, requests: string[];
const onToast = vi.fn();
const flush = async () => { for (let i = 0; i < 4; i++) await act(async () => new Promise(resolve => setTimeout(resolve, 0))); };
const render = async (administration = false) => {
  await act(async () => root.render(<FeaturesContext.Provider value={administration ? PRIVATE_FEATURES : SAFE_FEATURES}><AtlasView onRead={() => undefined} uncensored={false} onToast={onToast} /></FeaturesContext.Provider>));
  await flush();
};
const tab = (label: string) => [...container.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find(button => button.textContent?.startsWith(label));

beforeEach(() => {
  requests = []; onToast.mockClear();
  window.history.replaceState({}, '', '/atlas');
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
  vi.spyOn(window, 'open').mockImplementation(() => null);
  vi.stubGlobal('fetch', async (input: string) => {
    const path = new URL(input, 'http://localhost').pathname; requests.push(path);
    const data = path === '/api/directory' ? { items: [site] }
      : path === '/api/deep' ? { available: true, crawling: false, posts: 0, byKind: [] }
      : path === '/api/deep/sites' ? { available: true, total: 1, items: [{ id: 1, url: 'https://blog.example/feed', site: 'blog.example', title: 'A personal blog', kind: 'blog', origin: 'smallweb', posts: 0, nsfw: 0 }], counts: { blog: 1 } }
      : { error: 'Nothing indexed yet' };
    return new Response(JSON.stringify(data), { status: path === '/api/deep/random' ? 404 : 200, headers: { 'Content-Type': 'application/json' } });
  });
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('Atlas public capabilities', () => {
  it.each(['/atlas', '/atlas?tab=index'])('shows the public directory without operator state at %s', async (path) => {
    window.history.replaceState({}, '', path);
    await render();
    expect(tab('Deep index')).toBeUndefined();
    expect(tab('Hand-picked')?.getAttribute('aria-selected')).toBe('true');
    expect(container.querySelector('a[href="https://small.example/"]')).not.toBeNull();
    expect(container.textContent).not.toMatch(/Paused|on disk|deep\.db|Build the deep index|posts indexed/);
    expect(requests).toEqual(['/api/directory']);
  });

  it('retains public blog browsing without requesting crawl status', async () => {
    await render();
    await act(async () => tab('Blogs')!.click()); await flush();
    expect(container.textContent).toContain('A personal blog');
    expect(requests).toContain('/api/deep/sites');
    expect(requests).not.toContain('/api/deep');
    expect(container.textContent).not.toContain('Build the deep index');
  });

  it('opens a hand-picked site for public Surprise me without requiring a local index', async () => {
    await render();
    const surprise = [...container.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent?.includes('Surprise me'))!;
    await act(async () => surprise.click()); await flush();
    expect(window.open).toHaveBeenCalledWith(site.url, '_blank', 'noopener,noreferrer');
    expect(requests).not.toContain('/api/deep/random');
    expect(onToast).not.toHaveBeenCalled();
  });

  it('restores the private index deep link when administration becomes available', async () => {
    window.history.replaceState({}, '', '/atlas?tab=index');
    await render();
    expect(requests).not.toContain('/api/deep');
    await render(true);
    expect(tab('Deep index')?.getAttribute('aria-selected')).toBe('true');
    expect(container.textContent).toContain('Build the deep index');
    expect(requests.filter(path => path === '/api/deep')).toHaveLength(1);
  });
});
