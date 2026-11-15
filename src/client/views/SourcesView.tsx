import React, { useEffect, useMemo, useState } from 'react';
import { ArrowUpRight, Search } from 'lucide-react';
import { api } from '../lib.js';
import type { SearchPrefs } from './SettingsView.js';

export interface SourceConnector { id: string; name: string; description: string; category: string; homepage: string; requiresKey?: boolean }
export function SourcesView({ prefs, onPrefs }: { prefs: SearchPrefs; onPrefs: (prefs: SearchPrefs) => void }) {
  const [sources, setSources] = useState<SourceConnector[] | null>(null);
  const [error, setError] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState('all');
  useEffect(() => {
    const ctrl = new AbortController();
    setError(false);
    api<{ sources: SourceConnector[] }>('/api/sources', { signal: ctrl.signal }).then((data) => {
      if (!Array.isArray(data.sources) || data.sources.some((s) => !s || !['id', 'name', 'description', 'category', 'homepage'].every((key) => typeof s[key as keyof SourceConnector] === 'string'))) throw new Error('Invalid catalog');
      if (!ctrl.signal.aborted) setSources(data.sources);
    }).catch(() => { if (!ctrl.signal.aborted) setError(true); });
    return () => ctrl.abort();
  }, [attempt]);
  const categories = useMemo(() => [...new Set(sources?.map((s) => s.category))].sort(), [sources]);
  const shown = sources?.filter((s) => (category === 'all' || category === s.category) && `${s.name} ${s.description} ${s.category}`.toLowerCase().includes(query.toLowerCase().trim())) ?? [];
  const disabled = new Set(prefs.disabledSources);
  return <div className="page page-wide sources-page">
    <header className="page-head"><div><h1>Search sources</h1></div></header>
    <div className="privacy-note"><p>These choices stay in this browser and apply to your next search. Enabled sources are used when relevant to your scope. Some need server configuration; enabled does not mean connected.</p></div>
    {error ? <div className="collection-empty" role="alert"><h2>Sources are unavailable</h2><p>The catalog could not be loaded. Your source preferences are unchanged.</p><button className="btn" onClick={() => setAttempt((n) => n + 1)}>Try again</button></div> : sources === null ? <p role="status" className="collection-count">Loading source catalog…</p> : <>
      <div className="collection-toolbar"><label className="collection-search"><Search size={17} /><input className="input" aria-label="Filter sources" placeholder="Find a source or topic…" value={query} onChange={(e) => setQuery(e.target.value)} /></label><select className="select" aria-label="Source category" value={category} onChange={(e) => setCategory(e.target.value)}><option value="all">All categories</option>{categories.map((cat) => <option key={cat} value={cat}>{cat}</option>)}</select></div>
      <div className="collection-summary"><p role="status">{shown.length} shown · {sources.filter((s) => !disabled.has(s.id)).length} of {sources.length} enabled</p>{sources.some((s) => disabled.has(s.id)) && <button className="link-btn" onClick={() => onPrefs({ ...prefs, disabledSources: prefs.disabledSources.filter((id) => !sources.some((s) => s.id === id)) })}>Enable all sources</button>}</div>
      <div className="source-grid">{shown.map((source) => <article className={`source-card ${disabled.has(source.id) ? 'source-disabled' : ''}`} key={source.id}>
        <div className="source-card-head"><span className="source-category">{source.category}</span><button type="button" className={`switch ${disabled.has(source.id) ? '' : 'on'}`} role="switch" aria-label={`Enable ${source.name}`} aria-checked={!disabled.has(source.id)} onClick={() => onPrefs({ ...prefs, disabledSources: disabled.has(source.id) ? prefs.disabledSources.filter((id) => id !== source.id) : [...prefs.disabledSources, source.id] })}><span /></button></div>
        <h2>{source.name}</h2><p>{source.description}</p><div className="source-card-foot"><span>{disabled.has(source.id) ? 'Disabled' : 'Enabled'}{source.requiresKey ? ' · API key required' : ''}</span>{/^https?:\/\//.test(source.homepage) && <a href={source.homepage} target="_blank" rel="noreferrer" aria-label={`Visit ${source.name}`}>Website <ArrowUpRight size={13} /></a>}</div>
      </article>)}</div>
      {shown.length === 0 && <div className="collection-empty"><Search size={28} /><h2>No matching sources</h2><p>Try another keyword or category.</p><button className="btn" onClick={() => { setQuery(''); setCategory('all'); }}>Clear filters</button></div>}
    </>}
  </div>;
}
