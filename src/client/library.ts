import { useCallback, useEffect, useState } from 'react';

export interface SavedItem { url: string; title: string; snippet: string; source: string; savedAt: string }
export const LIBRARY_KEY = 'glogg.library.v1';
export const safeSavedUrl = (url: string) => /^(https?:\/\/|magnet:\?)/i.test(url);

export function parseLibrary(raw: string | null): SavedItem[] {
  if (!raw) return [];
  const value: unknown = JSON.parse(raw);
  if (!Array.isArray(value)) throw new Error('Invalid saved library');
  const seen = new Set<string>();
  return value.filter((item): item is SavedItem => {
    if (!item || typeof item !== 'object') return false;
    const row = item as SavedItem;
    if (![row.url, row.title, row.snippet, row.source, row.savedAt].every((v) => typeof v === 'string') || !safeSavedUrl(row.url) || seen.has(row.url)) return false;
    seen.add(row.url);
    return true;
  });
}

export function libraryExport(items: SavedItem[]) {
  return JSON.stringify({ format: 'glogg-library', version: 1, exportedAt: new Date().toISOString(), items }, null, 2);
}

export function downloadLibrary(items: SavedItem[]) {
  const url = URL.createObjectURL(new Blob([libraryExport(items)], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `glogg-saved-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Persist before announcing success. A quota/privacy error never masquerades as a saved bookmark. */
export function useLibrary() {
  const [items, setItems] = useState<SavedItem[]>(() => {
    try { return parseLibrary(localStorage.getItem(LIBRARY_KEY)); } catch { return []; }
  });
  useEffect(() => {
    const update = (event: StorageEvent) => {
      if (event.key !== LIBRARY_KEY && event.key !== null) return;
      try { setItems(parseLibrary(localStorage.getItem(LIBRARY_KEY))); } catch { /* Keep the last readable library. */ }
    };
    window.addEventListener('storage', update);
    return () => window.removeEventListener('storage', update);
  }, []);
  const change = useCallback((update: (items: SavedItem[]) => SavedItem[]) => {
    // Read at mutation time so another tab's bookmarks are preserved.
    const next = update(parseLibrary(localStorage.getItem(LIBRARY_KEY)));
    localStorage.setItem(LIBRARY_KEY, JSON.stringify(next));
    setItems(next);
  }, []);
  return { items, change };
}
