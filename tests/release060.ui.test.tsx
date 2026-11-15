// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { quickCalc } from '../src/client/components/CommandPalette.js';
import { SearchBox } from '../src/client/components/SearchBox.js';
import { AtlasView } from '../src/client/views/AtlasView.js';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

describe('0.6.0 client UI: SearchBox live calculation pill, quickCalc & AtlasView source refresh', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('evaluates chmod and display resolutions in quickCalc and renders a copyable pill in SearchBox', async () => {
    expect(quickCalc('chmod 755')?.directAnswer).toBe('rwxr-xr-x (0755)');
    expect(quickCalc('chmod rwxr-x---')?.directAnswer).toBe('0750 (rwxr-x---)');
    expect(quickCalc('1920x1080')?.directAnswer).toBe('16:9 · 2.07 MP');
    expect(quickCalc('0x1080')).toBeNull();

    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });

    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    act(() => {
      root.render(
        <SearchBox
          value="chmod 755"
          onChange={() => {}}
          onSubmit={() => {}}
          customBangs={[]}
          tools={[]}
        />
      );
    });

    const calcBtn = container.querySelector('button[aria-label^="Copy instant result"]') as HTMLButtonElement | null;
    expect(calcBtn).not.toBeNull();
    expect(calcBtn!.textContent).toContain('= rwxr-xr-x (0755)');

    await act(async () => {
      calcBtn!.click();
    });
    expect(writeText).toHaveBeenCalledWith('rwxr-xr-x (0755)');

    // Color swatch inside SearchBox pill
    act(() => {
      root.render(
        <SearchBox
          value="#ff5733"
          onChange={() => {}}
          onSubmit={() => {}}
          customBangs={[]}
          tools={[]}
        />
      );
    });
    const colorBtn = container.querySelector('button[aria-label^="Copy instant result"]');
    expect(colorBtn?.querySelector('span')).not.toBeNull();

    act(() => root.unmount());
    container.remove();
  });

  it('renders an on-demand Refresh button for user-added feeds in AtlasView and calls POST /api/deep/sources/:id/refresh', async () => {
    const toasts: [string, string?][] = [];
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes('/api/directory')) {
        return new Response(JSON.stringify({ items: [] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (url.endsWith('/api/deep') && (!init?.method || init.method === 'GET')) {
        return new Response(
          JSON.stringify({
            available: true,
            crawling: false,
            active: 0,
            counts: { visited: 1, unchanged: 0, failed: 0, posts: 3 },
            lastError: null,
            seededAt: Date.now(),
            seeding: false,
            posts: 3,
            byKind: [{ kind: 'blog', sources: 1, visited: 1, failing: 0, posts: 3 }],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      if (url.includes('/api/deep/sites')) {
        return new Response(
          JSON.stringify({
            total: 1,
            counts: { blog: 1, site: 0, board: 0, forum: 0 },
            items: [
              {
                id: 77,
                url: 'https://notes.example/feed.xml',
                site: 'notes.example',
                title: 'Notes Example',
                kind: 'blog',
                origin: 'user',
                nsfw: 0,
                posts: 4,
                fetched_at: Date.now(),
                status: 'ok',
                error: null,
              },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      if (url.endsWith('/api/deep/sources/77/refresh') && init?.method === 'POST') {
        return new Response(
          JSON.stringify({
            visit: 'ok',
            source: { id: 77, site: 'notes.example', posts: 6 },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
    });

    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <AtlasView
          onRead={() => {}}
          uncensored={false}
          onToast={(m, t) => toasts.push([m, t])}
        />
      );
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });

    // Switch to Blogs tab so Directory renders user-added blog feed rows
    const blogsTab = Array.from(container.querySelectorAll<HTMLButtonElement>('button[role="tab"]')).find((b) =>
      b.textContent?.includes('Blogs')
    );
    expect(blogsTab).toBeDefined();
    await act(async () => {
      blogsTab!.click();
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });

    const refreshBtn = container.querySelector('button[aria-label="Refresh notes.example"]') as HTMLButtonElement | null;
    expect(refreshBtn).not.toBeNull();

    await act(async () => {
      refreshBtn!.click();
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });

    expect(fetchMock.mock.calls.some(([u, i]) => String(u).endsWith('/api/deep/sources/77/refresh') && i?.method === 'POST')).toBe(true);
    expect(toasts.some(([msg, tone]) => msg.includes('Refreshed notes.example (6 posts)') && tone === 'ok')).toBe(true);

    act(() => root.unmount());
    container.remove();
  });
});
