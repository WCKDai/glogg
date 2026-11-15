import { afterEach, expect, it, vi } from 'vitest';
import { clearInstantAnswerCache, prefetchInstantAnswer } from '../server/answerEngine.js';

afterEach(() => { vi.unstubAllGlobals(); clearInstantAnswerCache(); });
it('keeps answer work pending until sibling lookups settle after malformed upstream metadata', async () => {
  let resolve!: (r: Response) => void;
  let delayed = false;
  vi.stubGlobal('fetch', (input: string | URL) => {
    const url = String(input);
    if (url.includes('wikipedia.org')) return Promise.resolve(Response.json({ query: { pages: { one: { title: 3, extract: 'A long enough extract about the solar system and its planets for this test.' } } } }));
    if (url.includes('api.duckduckgo.com')) {
      if (!delayed) { delayed = true; return new Promise<Response>((r) => { resolve = r; }); }
      return Promise.resolve(Response.json({}));
    }
    return Promise.resolve(new Response('', { status: 404 }));
  });
  let settled = false;
  const work = prefetchInstantAnswer('what is the solar system')!;
  void work.then(() => { settled = true; }, () => { settled = true; });
  try {
    await new Promise((r) => setTimeout(r, 10));
    expect(settled).toBe(false);
  } finally { resolve(Response.json({})); }
  await expect(work).resolves.toHaveLength(3);
});
