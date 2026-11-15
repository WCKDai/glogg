import React, { useMemo, useState } from 'react';
import { ArrowUpRight, BookOpen, Download, Search, Trash2 } from 'lucide-react';
import { downloadLibrary, type SavedItem } from '../library.js';

export function SavedView({ items, onRemove, onRead, onSearch, onToast }: {
  items: SavedItem[]; onRemove: (item: SavedItem) => void; onRead: (url: string) => void; onSearch: () => void; onToast: (text: string, tone?: 'ok' | 'error' | 'info') => void;
}) {
  const [query, setQuery] = useState('');
  const [order, setOrder] = useState('newest');
  const shown = useMemo(() => {
    const q = query.trim().toLocaleLowerCase();
    return items.filter((item) => `${item.title} ${item.url} ${item.snippet}`.toLocaleLowerCase().includes(q)).sort((a, b) => order === 'title' ? a.title.localeCompare(b.title) : b.savedAt.localeCompare(a.savedAt));
  }, [items, query, order]);
  return <div className="page page-wide library-page">
    <header className="page-head"><div><h1>Saved</h1></div>
      <button className="btn" disabled={!items.length} onClick={() => { try { downloadLibrary(items); } catch { onToast('Could not export your library. Try again.', 'error'); } }}><Download size={15} /> Export JSON</button>
    </header>
    <div className="privacy-note"><p>Bookmarks stay in this browser without server sync. Clearing browser data removes your library. Export a backup to keep it; opening the reader sends that page’s URL to glogg.</p></div>
    {items.length > 0 ? <>
      <div className="collection-toolbar"><label className="collection-search"><Search size={17} /><input className="input" aria-label="Search saved library" placeholder="Find a title, website or phrase…" value={query} onChange={(e) => setQuery(e.target.value)} /></label>
        <select className="select" aria-label="Sort saved items" value={order} onChange={(e) => setOrder(e.target.value)}><option value="newest">Recently saved</option><option value="title">Title A–Z</option></select>
      </div>
      <p className="collection-count" role="status">{shown.length} of {items.length} saved {items.length === 1 ? 'item' : 'items'}</p>
      {shown.length ? <div className="saved-grid">{shown.map((item) => {
        let domain = 'Magnet link';
        try { domain = new URL(item.url).hostname || domain; } catch { /* Validated before storage. */ }
        return <article className="saved-card" key={item.url}><div className="saved-site"><span className="truncate">{domain}</span></div>
          <h2><a href={item.url} target="_blank" rel="noreferrer">{item.title || item.url}<ArrowUpRight size={15} /></a></h2>
          {item.snippet && <p className="saved-snippet">{item.snippet}</p>}
          <div className="saved-foot"><span>{Number.isNaN(Date.parse(item.savedAt)) ? 'Saved' : new Date(item.savedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}</span><div className="row-gap">
            {!item.url.startsWith('magnet:') && <button className="btn btn-sm btn-ghost" aria-label={`Read ${item.title}`} onClick={() => onRead(item.url)}><BookOpen size={14} /> Read</button>}
            <button className="icon-btn ghost" aria-label={`Remove ${item.title} from saved library`} title="Remove from library" onClick={() => onRemove(item)}><Trash2 size={15} /></button>
          </div></div>
        </article>;
      })}</div> : <div className="collection-empty"><Search size={28} /><h2>No saved items match</h2><p>Try a different title, domain or phrase.</p><button className="btn" onClick={() => setQuery('')}>Clear search</button></div>}
    </> : <div className="collection-empty"><h2>No saved items yet</h2><p>Choose Save on a search result to keep it here.</p><button className="btn btn-primary" onClick={onSearch}><Search size={15} /> Search the web</button></div>}
  </div>;
}
