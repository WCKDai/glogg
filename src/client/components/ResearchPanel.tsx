import React, { useState } from 'react';
import { ArrowUp, Check, Copy, RotateCcw, Sparkles } from 'lucide-react';
import { copyText, faviconUrl } from '../lib.js';
import type { ResearchState } from '../lib.js';
import { Markdown } from './Markdown.js';

function stageLabel(s: ResearchState): string {
  if (s.stage === 'done') {
    const secs = s.durationMs ? ` · ${(s.durationMs / 1000).toFixed(1)}s` : '';
    return s.mode === 'ai' ? `Answer · ${s.model}${secs}` : `Quoted from ${s.sources.length} source${s.sources.length === 1 ? '' : 's'}${secs}`;
  }
  if (s.stage === 'error') return 'Research stopped';
  return `${s.detail}…`;
}

function Turn({
  state,
  showQuestion,
  onRetry,
}: {
  state: ResearchState;
  showQuestion: boolean;
  onRetry?: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const busy = state.stage !== 'done' && state.stage !== 'error';
  return (
    <div className="research-turn">
      {showQuestion && <h3 className="research-q">{state.query}</h3>}
      <div className="research-eyebrow">
        <Sparkles size={13} className={busy ? 'pulse' : ''} />
        <span>{stageLabel(state)}</span>
        {!busy && state.answer && (
          <span className="research-tools">
            <button
              type="button"
              className="icon-btn ghost"
              title="Copy answer as Markdown"
              aria-label="Copy answer"
              onClick={() => {
                const refs = state.sources.map((s) => `[${s.index}]: ${s.url}`).join('\n');
                copyText(`${state.answer}\n\n${refs}`);
                setCopied(true);
                setTimeout(() => setCopied(false), 1400);
              }}
            >
              {copied ? <Check size={14} /> : <Copy size={14} />}
            </button>
            {onRetry && (
              <button type="button" className="icon-btn ghost" title="Research again" aria-label="Research again" onClick={onRetry}>
                <RotateCcw size={14} />
              </button>
            )}
          </span>
        )}
      </div>

      {state.sources.length > 0 && (
        <ol className="research-sources" aria-label="Sources">
          {state.sources.map((s) => (
            <li key={s.index}>
              <a
                href={s.url}
                target="_blank"
                rel="noreferrer noopener"
                title={s.read ? s.title : `${s.title} (couldn't read the page; used the search snippet)`}
                className={s.read ? '' : 'unread'}
              >
                <span className="n">{s.index}</span>
                <img src={faviconUrl(s.domain)} alt="" width={12} height={12} loading="lazy" />
                <span className="truncate">{s.domain}</span>
              </a>
            </li>
          ))}
        </ol>
      )}

      {state.answer ? (
        <Markdown text={state.answer} sources={state.sources} className={`md research-answer ${busy ? 'streaming' : ''}`} />
      ) : busy ? (
        <div className="skeleton-stack" aria-hidden>
          <div className="skeleton w-95" />
          <div className="skeleton w-80" />
          <div className="skeleton w-70" />
        </div>
      ) : null}

      {state.notice && <div className="notice notice-warn">{state.notice}</div>}
      {state.error && (
        <div className="notice notice-error">
          {state.error}
          {onRetry && (
            <button type="button" className="link-btn" onClick={onRetry}>
              Try again
            </button>
          )}
        </div>
      )}
    </div>
  );
}

export function ResearchPanel({
  thread,
  current,
  aiReady,
  onFollowUp,
  onRetry,
  onSetupAi,
}: {
  thread: ResearchState[];
  current: ResearchState;
  aiReady: boolean;
  onFollowUp: (q: string) => void;
  onRetry: () => void;
  onSetupAi: () => void;
}) {
  const [followUp, setFollowUp] = useState('');
  const done = current.stage === 'done';
  return (
    <section className="research" aria-label="Research" aria-busy={!done && current.stage !== 'error'}>
      {thread.map((t) => (
        <Turn key={t.id} state={t} showQuestion />
      ))}
      <Turn state={current} showQuestion={thread.length > 0} onRetry={onRetry} />

      {done && current.mode === 'extractive' && !aiReady && (
        <p className="research-hint">
          These are quotes from the pages.{' '}
          <button type="button" className="link-btn" onClick={onSetupAi}>
            Add a model
          </button>{' '}
          for a written answer. Ollama runs locally and needs no key.
        </p>
      )}

      {done && (
        <form
          className="research-follow"
          onSubmit={(e) => {
            e.preventDefault();
            const q = followUp.trim();
            if (!q) return;
            setFollowUp('');
            onFollowUp(q);
          }}
        >
          <input
            className="input"
            value={followUp}
            onChange={(e) => setFollowUp(e.target.value)}
            placeholder="Ask a follow-up…"
            aria-label="Follow-up question"
          />
          <button type="submit" className="icon-btn" disabled={!followUp.trim()} aria-label="Ask">
            <ArrowUp size={15} />
          </button>
        </form>
      )}
    </section>
  );
}
