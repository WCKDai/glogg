import React, { useCallback, useEffect, useState } from 'react';
import { Command } from 'lucide-react';
import type { RankedSearchResponse } from '../../core/browser.js';
import { plural, useClickOutside } from '../lib.js';
import type { Mode, ResearchState } from '../lib.js';

/** Names for the server's source tasks (metrics.sourceTimings keys). */
const SOURCE_NAMES: Record<string, string> = {
  searxng: 'SearXNG',
  ddg: 'DuckDuckGo',
  brave: 'Brave',
  se: 'Stack Exchange',
  wiki: 'Wikipedia',
  hn: 'Hacker News',
  github: 'GitHub',
  marginalia: 'Marginalia',
  wiby: 'Wiby',
  lemmy: 'Lemmy',
  fediverse: 'Fediverse',
  gdelt: 'GDELT news',
  archive: 'Internet Archive',
  openalex: 'OpenAlex',
  arxiv: 'arXiv',
  p2p: 'Torrents & Usenet',
  chanLive: '4chan',
  chanArchive: 'Chan archives',
  forums: 'Old-web forums',
  deep: 'Deep index (local)',
  mwmbl: 'Mwmbl',
  discourse: 'Discourse forums (live)',
};

const STATUS_ORDER = { ok: 0, empty: 1, late: 2, error: 3, resting: 4 } as const;

type Timing = NonNullable<RankedSearchResponse['metrics']['sourceTimings']>[string];

export function sourceSummary(timings: Record<string, Timing> = {}) {
  const all = Object.values(timings);
  const answered = all.filter((t) => t.status === 'ok' || t.status === 'empty').length;
  const late = all.filter((t) => t.status === 'late' || t.status === 'error').length;
  return { total: all.length, answered, late, resting: all.filter((t) => t.status === 'resting').length };
}

export function StatusBar({
  data,
  loading,
  busyLabel,
  research,
  mode,
  toolCount,
  onToggleMode,
  onOpenPalette,
}: {
  data: RankedSearchResponse | null;
  loading: boolean;
  busyLabel?: string;
  research: ResearchState | null;
  mode: Mode;
  toolCount: number;
  onToggleMode: () => void;
  onOpenPalette: () => void;
}) {
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  const ref = useClickOutside<HTMLDivElement>(close, open);

  // A new search (or leaving the results) closes the breakdown.
  useEffect(() => setOpen(false), [data]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  const timings = data?.metrics.sourceTimings || {};
  const summary = sourceSummary(timings);
  const ms = data?.metrics.durationMs ?? 0;
  const rows = Object.entries(timings).sort(
    ([, a], [, b]) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || a.ms - b.ms
  );
  const slowest = Math.max(1, ...rows.map(([, t]) => t.ms));
  const researching = research && research.stage !== 'done' && research.stage !== 'error';

  return (
    <div className="statusbar" role="status" aria-live="polite" ref={ref}>
      {loading || busyLabel ? (
        <span className="sb-item">
          <span className="sb-dot busy" aria-hidden />
          {busyLabel || 'Searching…'}
        </span>
      ) : data && summary.total > 0 ? (
        <button
          type="button"
          className="sb-item"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          title="Which sources answered, and how fast"
        >
          <span className={`sb-dot ${summary.late ? 'warn' : 'ok'}`} aria-hidden />
          {summary.answered}/{summary.total} sources
          {summary.late > 0 && <span className="sb-hide-sm">· {summary.late} late</span>}
        </button>
      ) : (
        <span className="sb-item">
          <span className="sb-dot ok" aria-hidden />
          Ready · {plural(toolCount, 'tool')}
        </span>
      )}

      {data && !loading && (
        <span className="sb-item">
          {ms < 40 ? 'cached' : `${(ms / 1000).toFixed(2)} s`}
        </span>
      )}

      {research && mode === 'advanced' && (
        <span className="sb-item sb-hide-sm">
          {researching ? (
            <>
              <span className="sb-dot busy" aria-hidden /> {research.detail.toLowerCase()}…
            </>
          ) : research.stage === 'done' ? (
            <span className="sb-accent">
              answer · {research.mode === 'ai' ? research.model : 'quoted'} · {((research.durationMs ?? 0) / 1000).toFixed(1)} s
            </span>
          ) : (
            'research stopped'
          )}
        </span>
      )}

      <span className="sb-spacer" />

      <button type="button" className="sb-item" onClick={onToggleMode} title="Switch view (m)">
        {mode === 'advanced' ? 'Advanced' : 'Simple'}
      </button>
      <button type="button" className="sb-item sb-hide-sm" onClick={onOpenPalette} title="Command palette (⌘K)">
        <Command size={11} /> K
      </button>

      {open && data && (
        <div className="sb-pop" role="dialog" aria-label="Sources">
          <h3>
            Sources · {(ms / 1000).toFixed(2)} s
          </h3>
          {rows.map(([key, t]) => (
            <React.Fragment key={key}>
              <div className="sb-row">
                <span className={`sb-dot ${t.status === 'ok' ? 'ok' : t.status === 'late' || t.status === 'error' ? 'warn' : ''}`} aria-hidden />
                <span className="truncate">{SOURCE_NAMES[key] || key}</span>
                <span className="sb-num">{t.count || ''}</span>
                <span className={`sb-status s-${t.status}`}>
                  {t.status === 'ok' || t.status === 'empty' ? `${t.ms} ms` : t.status === 'resting' ? 'resting' : t.status}
                </span>
              </div>
              {(t.status === 'ok' || t.status === 'empty') && (
                <div className="sb-bar" aria-hidden>
                  <span style={{ width: `${Math.max(3, (t.ms / slowest) * 100)}%` }} />
                </div>
              )}
            </React.Fragment>
          ))}
        </div>
      )}
    </div>
  );
}
