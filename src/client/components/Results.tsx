import React, { useCallback, useState } from 'react';
import {
  BookOpen,
  Check,
  ChevronDown,
  Copy,
  Download,
  EyeOff,
  Magnet,
  MoreHorizontal,
  Pin,
} from 'lucide-react';
import type {
  DownloadTargetId,
  InstantAnswerPayload,
  ScoredSearchResult,
} from '../../core/browser.js';
import { Favicon } from './Favicon.js';
import {
  relativeDate,
  SOURCE_LABELS,
  urlCrumb,
  useClickOutside,
  useDownloadTargets,
} from '../lib.js';

// ── Answer ─────────────────────────────────────────────────────────────────
export function AnswerCard({
  answer,
  onRead,
}: {
  answer: InstantAnswerPayload;
  onRead: (url: string) => void;
}) {
  // Say what it is: a quote from the top pages is not a verified answer.
  const quoted = answer.kind === 'knowledge-synthesis';
  const label =
    answer.kind === 'computation'
      ? 'Calculated'
      : answer.kind === 'technical-answer'
      ? 'Accepted answer'
      : quoted
      ? 'From the top results'
      : 'Answer';

  return (
    <section className={`answer ${quoted ? 'answer-quoted' : ''}`} aria-label="Answer">
      <div className="answer-eyebrow">
        <span className="answer-kind">{label}</span>
        {answer.primarySourceDomain && !quoted && <span>{answer.primarySourceDomain}</span>}
      </div>
      {!quoted && <h2 className="answer-title">{answer.title}</h2>}
      {answer.subtitle && <p className="answer-sub">{answer.subtitle}</p>}
      <p className="answer-body">{answer.directAnswer}</p>

      {answer.codeBlock && (
        <pre className="answer-code">
          <code>{answer.codeBlock}</code>
        </pre>
      )}

      {answer.takeaways && answer.takeaways.length > 0 && (
        <ul className="answer-takeaways">
          {answer.takeaways.slice(0, 4).map((t, i) => (
            <li key={i}>
              {t.text}
              <sup>{t.citationIndex}</sup>
            </li>
          ))}
        </ul>
      )}

      {answer.keyFacts && answer.keyFacts.length > 0 && (
        <dl className="answer-facts">
          {answer.keyFacts.slice(0, 6).map((f) => (
            <div key={f.label}>
              <dt>{f.label}</dt>
              <dd>{f.value}</dd>
            </div>
          ))}
        </dl>
      )}

      <div className="answer-foot">
        <div className="answer-cites">
          {answer.citations.slice(0, 5).map((c) => (
            <a key={c.url} href={c.url} target="_blank" rel="noreferrer" title={c.title} className="cite">
              <span className="cite-n">{c.index}</span>
              <Favicon domain={c.domain} size={12} />
              <span>{c.domain}</span>
            </a>
          ))}
        </div>
        {answer.primarySourceUrl && (
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => onRead(answer.primarySourceUrl!)}>
            <BookOpen size={13} /> Read source
          </button>
        )}
      </div>
    </section>
  );
}

// ── Send-to menu (download manager) ───────────────────────────────────────
export function SendMenu({
  url,
  onSend,
  compact,
  label = 'Send',
}: {
  url: string;
  onSend: (target: DownloadTargetId) => void;
  compact?: boolean;
  label?: string;
}) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  const ref = useClickOutside<HTMLDivElement>(close, open);
  const targets = useDownloadTargets();

  return (
    <div className="menu-wrap" ref={ref}>
      <div className="split">
        <button type="button" className="btn btn-sm btn-accent" onClick={() => onSend('auto')} title="Send to best destination">
          <Download size={13} />
          {!compact && label}
        </button>
        <button
          type="button"
          className="btn btn-sm btn-accent split-caret"
          onClick={() => setOpen((o) => !o)}
          aria-label="Choose destination"
          aria-expanded={open}
        >
          <ChevronDown size={13} />
        </button>
      </div>
      {open && (
        <div className="menu" role="menu">
          {targets.map((t) => (
            <button
              key={t.id}
              type="button"
              role="menuitem"
              onClick={() => {
                onSend(t.id);
                setOpen(false);
              }}
            >
              <span>{t.label}</span>
              <span className="menu-hint">{t.hint}</span>
            </button>
          ))}
          <div className="menu-sep" />
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              void navigator.clipboard?.writeText(url);
              setCopied(true);
              setTimeout(() => setCopied(false), 1400);
            }}
          >
            <span>{copied ? 'Copied' : 'Copy link'}</span>
            {copied ? <Check size={13} /> : <Copy size={13} />}
          </button>
        </div>
      )}
    </div>
  );
}

// ── Result row ─────────────────────────────────────────────────────────────
export function ResultItem({
  item,
  active,
  onHover,
  onRead,
  onSend,
  onPin,
  onMute,
  detailed,
  index = 0,
}: {
  item: ScoredSearchResult;
  /** Position in the list; staggers the entrance animation. */
  index?: number;
  active: boolean;
  /** Advanced view: show the ranking signals behind the result. */
  detailed?: boolean;
  onHover: () => void;
  onRead: (url: string) => void;
  onSend: (item: ScoredSearchResult, target: DownloadTargetId) => void;
  onPin: (domain: string) => void;
  onMute: (domain: string) => void;
}) {
  const [moreOpen, setMoreOpen] = useState(false);
  const closeMore = useCallback(() => setMoreOpen(false), []);
  const moreRef = useClickOutside<HTMLDivElement>(closeMore, moreOpen);
  const crumb = urlCrumb(item.url);
  const when = relativeDate(item.publishedAt);
  const isMagnet = item.url.startsWith('magnet:');
  const downloadable = Boolean(item.p2p?.magnetUri || item.p2p?.nzbUrl || item.p2p?.torrentUrl);

  return (
    <article
      className={`result ${active ? 'active' : ''}`}
      onMouseEnter={onHover}
      data-result-id={item.id}
      style={{ '--i': index } as React.CSSProperties}
    >
      <div className="result-meta">
        <Favicon domain={item.domain} />
        <span className="result-domain">{item.domain}</span>
        {crumb && <span className="result-crumb">{crumb}</span>}
        {item.isNsfw && <span className="tag tag-danger">18+</span>}
        {item.verdict === 'primary-source' && <span className="tag">primary</span>}
        {(item.source === 'chanboards' || item.source === 'wild-west') && (
          <span className="tag tag-accent">{SOURCE_LABELS[item.source]}</span>
        )}
      </div>

      <a className="result-title" href={item.url} target="_blank" rel="noreferrer">
        {item.title}
      </a>

      <p className="result-snippet">{item.snippet}</p>

      {detailed && (
        <div className="result-scores" aria-label="Ranking signals">
          <span title="How well the result matches your query">match {Math.round(item.relevanceScore)}</span>
          <span title="Signals of an independent, first-hand source">signal {Math.round(item.authenticityScore)}</span>
          <span className={item.slopScore >= 40 ? 'bad' : ''} title="SEO, affiliate and AI-filler signals">
            slop {Math.round(item.slopScore)}
          </span>
          {item.isPrimarySource && <span className="good">primary source</span>}
          {item.isIndieWeb && <span className="good">independent</span>}
          {item.isPreLlm && <span>pre-LLM</span>}
          {item.tld && <span>.{item.tld.replace(/^\./, '')}</span>}
        </div>
      )}

      <div className="result-foot">
        <span className="result-provenance">
          {SOURCE_LABELS[item.source] || item.source}
          {when && <> · {when}</>}
          {item.p2p && (
            <>
              {' '}
              · {item.p2p.sizeFormatted}
              {item.p2p.seeders !== undefined && <> · {item.p2p.seeders} seeds</>}
            </>
          )}
        </span>

        <div className="result-actions">
          {downloadable && (
            <SendMenu url={item.p2p?.magnetUri || item.p2p?.nzbUrl || item.p2p?.torrentUrl || item.url} onSend={(t) => onSend(item, t)} />
          )}
          {!isMagnet && (
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => onRead(item.url)} title="Read clean (r)">
              <BookOpen size={13} /> Read
            </button>
          )}
          <div className="menu-wrap" ref={moreRef}>
            <button
              type="button"
              className="icon-btn ghost"
              onClick={() => setMoreOpen((o) => !o)}
              aria-label="More actions"
              aria-expanded={moreOpen}
            >
              <MoreHorizontal size={15} />
            </button>
            {moreOpen && (
              <div className="menu menu-right" role="menu">
                {!downloadable && !isMagnet && (
                  <button type="button" role="menuitem" onClick={() => { onSend(item, 'auto'); setMoreOpen(false); }}>
                    <span>Save page</span>
                    <Download size={13} />
                  </button>
                )}
                <button type="button" role="menuitem" onClick={() => { onPin(item.rootDomain); setMoreOpen(false); }}>
                  <span>Prefer {item.rootDomain}</span>
                  <Pin size={13} />
                </button>
                <button type="button" role="menuitem" onClick={() => { onMute(item.rootDomain); setMoreOpen(false); }}>
                  <span>Hide {item.rootDomain}</span>
                  <EyeOff size={13} />
                </button>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    void navigator.clipboard?.writeText(item.url);
                    setMoreOpen(false);
                  }}
                >
                  <span>Copy link</span>
                  <Copy size={13} />
                </button>
                <a
                  role="menuitem"
                  href={`https://web.archive.org/web/*/${item.url}`}
                  target="_blank"
                  rel="noreferrer"
                  onClick={() => setMoreOpen(false)}
                >
                  <span>Wayback snapshots</span>
                </a>
              </div>
            )}
          </div>
        </div>
      </div>
    </article>
  );
}

// ── Torrents & NZBs ────────────────────────────────────────────────────────
export function ReleaseList({
  items,
  onSend,
}: {
  items: ScoredSearchResult[];
  onSend: (item: ScoredSearchResult, target: DownloadTargetId) => void;
}) {
  if (items.length === 0) {
    return <p className="empty">No releases found. Try a different scope, or a <span className="mono">!btdig</span> / <span className="mono">!nzb</span> bang.</p>;
  }
  return (
    <ul className="releases">
      {items.map((item) => {
        const p = item.p2p!;
        const isBt = p.protocol === 'bittorrent-dht';
        const link = p.magnetUri || p.nzbUrl || p.torrentUrl || item.url;
        return (
          <li key={item.id} className="release">
            <div className="release-icon" aria-hidden>
              {isBt ? <Magnet size={15} /> : <Download size={15} />}
            </div>
            <div className="release-main">
              <div className="release-title" title={item.title}>
                {item.title}
              </div>
              <div className="release-meta">
                <span>{p.indexerName}</span>
                <span>{p.sizeFormatted}</span>
                {isBt ? (
                  <span className={p.seeders && p.seeders > 10 ? 'ok' : ''}>
                    {p.seeders ?? 0} seeds · {p.leechers ?? 0} peers
                  </span>
                ) : (
                  <span>{p.usenetAgeDays !== undefined ? `${p.usenetAgeDays}d old` : p.newsgroup || 'usenet'}</span>
                )}
                {p.isAdultNsfw && <span className="tag tag-danger">18+</span>}
                {p.healthVerdict === 'suspect-spam' && <span className="tag tag-danger">suspect</span>}
              </div>
            </div>
            <div className="release-actions">
              {p.magnetUri && (
                <a className="icon-btn ghost" href={p.magnetUri} title="Open magnet in your client">
                  <Magnet size={15} />
                </a>
              )}
              <SendMenu url={link} onSend={(t) => onSend(item, t)} compact />
            </div>
          </li>
        );
      })}
    </ul>
  );
}
