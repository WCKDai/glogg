import React, { useEffect, useState } from 'react';
import { Download, ExternalLink, X } from 'lucide-react';
import type { DownloadTargetId, PageAutopsyReport } from '../../core/browser.js';
import { api } from '../lib.js';
import { Favicon } from './Favicon.js';
import { SendMenu } from './Results.js';

export function ReaderSheet({
  url,
  onClose,
  onNavigate,
  onSend,
}: {
  url: string;
  onClose: () => void;
  onNavigate: (url: string) => void;
  onSend: (url: string, title: string, target: DownloadTargetId) => void;
}) {
  const [report, setReport] = useState<PageAutopsyReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showFluff, setShowFluff] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setReport(null);
    setError(null);
    api<PageAutopsyReport>('/api/inspect', { method: 'POST', json: { url } })
      .then((r) => !cancelled && setReport(r))
      .catch((e: Error) => !cancelled && setError(e.message));
    return () => {
      cancelled = true;
    };
  }, [url]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  let domain = '';
  try {
    domain = new URL(url).hostname.replace(/^www\./, '');
  } catch {
    domain = url;
  }

  const sections = report?.sections.filter((s) => showFluff || !s.isFluffPreamble) ?? [];
  const fluffCount = report?.stats.fluffPreambleParagraphs ?? 0;

  return (
    <>
      <div className="scrim" onClick={onClose} />
      <aside className="sheet" role="dialog" aria-label="Reader">
        <header className="sheet-bar">
          <Favicon domain={domain} />
          <span className="sheet-domain">{domain}</span>
          <div className="sheet-bar-actions">
            <SendMenu url={url} onSend={(t) => onSend(url, report?.title || domain, t)} label="Save" />
            <a className="btn btn-ghost btn-sm" href={url} target="_blank" rel="noreferrer">
              Original <ExternalLink size={12} />
            </a>
            <button type="button" className="icon-btn ghost" onClick={onClose} aria-label="Close reader (Esc)">
              <X size={16} />
            </button>
          </div>
        </header>

        <div className="sheet-body">
          {!report && !error && (
            <div className="skeleton-stack" aria-busy="true" aria-label="Loading the page">
              <div className="skeleton h-28 w-80" />
              <div className="skeleton h-14 w-40" />
              <div className="skeleton h-14 w-100" />
              <div className="skeleton h-14 w-95" />
              <div className="skeleton h-14 w-70" />
            </div>
          )}

          {error && (
            <div className="notice notice-error">
              Couldn't load this page cleanly ({error}).{' '}
              <a href={url} target="_blank" rel="noreferrer">
                Open the original
              </a>{' '}
              or try the{' '}
              <a href={`https://web.archive.org/web/2/${url}`} target="_blank" rel="noreferrer">
                Wayback copy
              </a>
              .
            </div>
          )}

          {report && (
            <article className="reader">
              <h1 className="reader-title">{report.title}</h1>
              <p className="reader-meta">
                {report.byline && <>{report.byline} · </>}
                {report.publishedDate && <>{report.publishedDate.slice(0, 10)} · </>}
                {report.stats.estimatedCleanReadMinutes} min read
                {report.stats.bloatReductionPercent > 0 && <> · {report.stats.bloatReductionPercent}% lighter</>}
                {report.stats.totalScriptsRemoved > 0 && <> · {report.stats.totalScriptsRemoved} trackers removed</>}
              </p>

              {report.coreTakeaway && (
                <div className="reader-takeaway">
                  <span>In short</span>
                  <p>{report.coreTakeaway}</p>
                </div>
              )}

              {fluffCount > 0 && (
                <button type="button" className="link-btn" onClick={() => setShowFluff((s) => !s)}>
                  {showFluff ? 'Hide' : 'Show'} {fluffCount} intro paragraph{fluffCount === 1 ? '' : 's'} of filler
                </button>
              )}

              <div className="reader-content">
                {sections.map((sec) => {
                  if (sec.tag === 'h1' || sec.tag === 'h2' || sec.tag === 'h3') {
                    return <h3 key={sec.id}>{sec.text}</h3>;
                  }
                  if (sec.tag === 'pre') {
                    return (
                      <pre key={sec.id}>
                        <code>{sec.text}</code>
                      </pre>
                    );
                  }
                  if (sec.tag === 'blockquote') return <blockquote key={sec.id}>{sec.text}</blockquote>;
                  return (
                    <p key={sec.id} className={sec.isFluffPreamble ? 'fluff' : sec.isCoreAnswer ? 'core' : ''}>
                      {sec.text}
                    </p>
                  );
                })}
              </div>

              {report.primarySources.length > 0 && (
                <section className="reader-sources">
                  <h4>Sources this page cites</h4>
                  <ul>
                    {report.primarySources.slice(0, 10).map((ps, i) => (
                      <li key={`${ps.url}-${i}`}>
                        <button type="button" className="link-btn" onClick={() => onNavigate(ps.url)}>
                          {ps.text || ps.domain}
                        </button>
                        <span className="muted">
                          {ps.sourceTypeLabel ? `${ps.sourceTypeLabel} · ` : ''}
                          {ps.domain}
                        </span>
                      </li>
                    ))}
                  </ul>
                </section>
              )}

              {report.links.some((l) => l.kind === 'magnet-p2p') && (
                <section className="reader-sources">
                  <h4>Magnets on this page</h4>
                  <ul>
                    {report.links
                      .filter((l) => l.kind === 'magnet-p2p')
                      .slice(0, 8)
                      .map((l, i) => (
                        <li key={i}>
                          <span>{l.text || 'magnet'}</span>
                          <button type="button" className="btn btn-ghost btn-sm" onClick={() => onSend(l.url, l.text, 'auto')}>
                            <Download size={12} /> Send
                          </button>
                        </li>
                      ))}
                  </ul>
                </section>
              )}
            </article>
          )}
        </div>
      </aside>
    </>
  );
}
