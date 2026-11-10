import React, { useId, useState } from 'react';
import {
  ArrowUpRight,
  Box,
  Check,
  Cloud,
  CloudDownload,
  Copy,
  Download,
  Gauge,
  HardDriveDownload,
  Minus,
  Newspaper,
  Play,
  Puzzle,
  Radar,
  Search,
  Server,
  Sparkles,
  Wrench,
  X,
  Zap,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { OutputAction, OutputBlock, PluginCategory, PluginField, ToolResult, Tone } from '../../core/browser.js';
import { copyText, useLater } from '../lib.js';
import type { ToolRef } from '../lib.js';
import { Markdown } from './Markdown.js';

// ── Icons ──────────────────────────────────────────────────────────────────
// Named icons used by plugins; anything else falls back to its category's icon.
const ICONS: Record<string, LucideIcon> = {
  Box,
  Cloud,
  CloudDownload,
  Gauge,
  HardDriveDownload,
  Newspaper,
  Radar,
  Server,
  Sparkles,
  Wrench,
  Zap,
};

const CATEGORY_ICONS: Record<PluginCategory, LucideIcon> = {
  search: Search,
  debrid: Zap,
  storage: Cloud,
  usenet: Newspaper,
  osint: Radar,
  webtest: Gauge,
  ai: Sparkles,
  utility: Wrench,
};

export function PluginIcon({ icon, category, size = 15 }: { icon?: string; category?: PluginCategory; size?: number }) {
  const Icon = (icon && ICONS[icon]) || (category && CATEGORY_ICONS[category]) || Puzzle;
  return <Icon size={size} aria-hidden />;
}

// ── Forms (tool inputs and plugin settings share one field type) ──────────
export function FieldInput({
  field,
  value,
  onChange,
  autoFocus,
  id,
}: {
  field: PluginField;
  value: unknown;
  onChange: (v: unknown) => void;
  autoFocus?: boolean;
  /** Unique on the page: a tool's form and its plugin's settings can both have a "url". */
  id: string;
}) {
  const text = value === undefined || value === null ? '' : String(value);
  const required = Boolean(field.required);
  switch (field.type) {
    case 'textarea':
      return (
        <textarea
          id={id}
          className="input textarea"
          rows={4}
          required={required}
          value={text}
          placeholder={field.placeholder}
          autoFocus={autoFocus}
          onChange={(e) => onChange(e.target.value)}
        />
      );
    case 'select':
      return (
        <select id={id} className="input select" required={required} value={text} onChange={(e) => onChange(e.target.value)}>
          {(field.options || []).map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      );
    case 'toggle': {
      const on = value === true || value === 'true';
      return (
        <button type="button" id={id} className={`switch ${on ? 'on' : ''}`} role="switch" aria-checked={on} onClick={() => onChange(!on)}>
          <span />
        </button>
      );
    }
    default:
      return (
        <input
          id={id}
          className={`input ${field.type === 'url' ? 'mono' : ''}`}
          type={field.type === 'number' ? 'number' : field.type === 'password' || field.secret ? 'password' : 'text'}
          required={required}
          value={text}
          placeholder={field.placeholder}
          autoFocus={autoFocus}
          autoComplete="off"
          spellCheck={false}
          onChange={(e) => onChange(e.target.value)}
        />
      );
  }
}

export function ToolForm({
  fields,
  values,
  onChange,
  onSubmit,
  submitLabel = 'Run',
  busy,
  autoFocus,
}: {
  fields: PluginField[];
  values: Record<string, unknown>;
  onChange: (key: string, v: unknown) => void;
  onSubmit: () => void;
  submitLabel?: string;
  busy?: boolean;
  autoFocus?: boolean;
}) {
  // One short field: input and button share a row, like a search box.
  const inline = fields.length === 1 && fields[0].type !== 'textarea' && fields[0].type !== 'toggle';
  const base = useId();
  return (
    <form
      className={`tool-form ${inline ? 'inline' : ''}`}
      onSubmit={(e) => {
        e.preventDefault();
        // A submit from anywhere (Enter, a script) still needs the required fields.
        if (!e.currentTarget.checkValidity()) {
          e.currentTarget.reportValidity?.();
          return;
        }
        onSubmit();
      }}
    >
      {fields.map((f, i) => (
        <div key={f.key} className={`field ${f.type === 'toggle' ? 'field-toggle' : ''}`}>
          <label htmlFor={`${base}-${f.key}`}>
            {f.label}
            {f.required && <span className="req" aria-hidden> *</span>}
          </label>
          <FieldInput id={`${base}-${f.key}`} field={f} value={values[f.key]} onChange={(v) => onChange(f.key, v)} autoFocus={autoFocus && i === 0} />
          {f.help && <span className="field-help">{f.help}</span>}
        </div>
      ))}
      <button className="btn btn-primary" disabled={busy}>
        {busy ? <span className="spinner" aria-hidden /> : submitLabel === 'Run' ? <Play size={13} /> : null}
        {busy && submitLabel === 'Run' ? 'Running…' : submitLabel}
      </button>
    </form>
  );
}

// ── Output blocks ─────────────────────────────────────────────────────────
export interface ToolActionHandlers {
  onSend: (url: string, title?: string) => void;
  onRunTool: (tool: string, inputs: Record<string, unknown>) => void;
  onCopied?: () => void;
}

function toneClass(tone?: Tone): string {
  return tone ? `tone-${tone}` : '';
}

function CopyButton({ text, onCopied }: { text: string; onCopied?: () => void }) {
  const [done, setDone] = useState(false);
  const later = useLater();
  return (
    <button
      type="button"
      className="icon-btn ghost copy-btn"
      aria-label="Copy"
      title="Copy"
      onClick={() => {
        copyText(text);
        setDone(true);
        onCopied?.();
        later(() => setDone(false), 1200);
      }}
    >
      {done ? <Check size={13} /> : <Copy size={13} />}
    </button>
  );
}

function ActionButton({ action, handlers, small = true }: { action: OutputAction; handlers: ToolActionHandlers; small?: boolean }) {
  const cls = `btn ${small ? 'btn-sm' : ''} btn-ghost`;
  if (action.href) {
    return (
      <a className={cls} href={action.href} target="_blank" rel="noreferrer noopener">
        {action.label} <ArrowUpRight size={12} />
      </a>
    );
  }
  return (
    <button
      type="button"
      className={action.send ? `btn ${small ? 'btn-sm' : ''} btn-accent` : cls}
      onClick={() => {
        if (action.send) handlers.onSend(action.send.url, action.send.title);
        else if (action.run) handlers.onRunTool(action.run.tool, action.run.inputs);
        else if (action.copy !== undefined) {
          copyText(action.copy);
          handlers.onCopied?.();
        }
      }}
    >
      {action.send && <Download size={12} />}
      {action.copy !== undefined && <Copy size={12} />}
      {action.label}
    </button>
  );
}

function OutputBlockView({ block, handlers }: { block: OutputBlock; handlers: ToolActionHandlers }) {
  const title = 'title' in block && block.title ? <h4 className="out-title">{block.title}</h4> : null;
  switch (block.type) {
    case 'notice':
      return <div className={`notice ${block.tone ? `notice-${block.tone}` : ''}`}>{block.content}</div>;
    case 'kv':
      return (
        <div className="out-block">
          {title}
          <dl className="kv">
            {block.items.map((it, i) => (
              <div key={`${it.label}-${i}`} className="kv-row">
                <dt>{it.label}</dt>
                <dd className={toneClass(it.tone)}>
                  {it.href ? (
                    <a href={it.href} target="_blank" rel="noreferrer noopener">
                      {it.value}
                    </a>
                  ) : (
                    <span className="kv-value">{it.value}</span>
                  )}
                  {it.value && it.value.length > 8 && <CopyButton text={it.value} onCopied={handlers.onCopied} />}
                </dd>
              </div>
            ))}
          </dl>
        </div>
      );
    case 'table':
      return (
        <div className="out-block">
          {title}
          <div className="tbl-wrap">
            <table className="tbl">
              <thead>
                <tr>
                  {block.columns.map((c) => (
                    <th key={c}>{c}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {block.rows.map((row, i) => (
                  <tr key={i}>
                    {row.map((cell, j) => (
                      <td key={j}>{cell}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {block.rows.length === 0 && <p className="muted small">Nothing to show.</p>}
        </div>
      );
    case 'list':
      return (
        <div className="out-block">
          {title}
          {block.items.length === 0 ? (
            <p className="muted small">Nothing found.</p>
          ) : (
            <ul className="out-list">
              {block.items.map((it, i) => (
                <li key={i}>
                  <div className="out-list-main">
                    {it.href ? (
                      <a className="out-list-title" href={it.href} target="_blank" rel="noreferrer noopener">
                        {it.title}
                      </a>
                    ) : (
                      <span className="out-list-title">{it.title}</span>
                    )}
                    {it.subtitle && <span className="out-list-sub">{it.subtitle}</span>}
                  </div>
                  {it.badge && <span className={`tag ${it.tone ? `tag-${it.tone}` : ''}`}>{it.badge}</span>}
                  {it.actions && it.actions.length > 0 && (
                    <div className="out-list-actions">
                      {it.actions.map((a, j) => (
                        <ActionButton key={j} action={a} handlers={handlers} />
                      ))}
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      );
    case 'text':
      return (
        <div className="out-block">
          {title}
          <Markdown text={block.content} />
        </div>
      );
    case 'code':
      return (
        <div className="out-block">
          {title}
          <div className="out-code">
            <pre>
              <code>{block.content}</code>
            </pre>
            <CopyButton text={block.content} onCopied={handlers.onCopied} />
          </div>
        </div>
      );
    case 'stat':
      return (
        <div className="stats">
          {block.items.map((s) => (
            <div key={s.label} className="stat">
              <div className={`stat-value ${toneClass(s.tone)}`}>{s.value}</div>
              <div className="stat-label">{s.label}</div>
            </div>
          ))}
        </div>
      );
    case 'checks':
      return (
        <div className="out-block">
          {title}
          <ul className="checks">
            {block.items.map((c, i) => (
              <li key={i} className={c.pass === true ? 'pass' : c.pass === false ? 'fail' : 'na'}>
                <span className="check-icon" aria-label={c.pass === true ? 'Pass' : c.pass === false ? 'Fail' : 'Not applicable'}>
                  {c.pass === true ? <Check size={13} /> : c.pass === false ? <X size={13} /> : <Minus size={13} />}
                </span>
                <span className="check-label">{c.label}</span>
                {c.detail && <span className="check-detail">{c.detail}</span>}
              </li>
            ))}
          </ul>
        </div>
      );
    case 'actions':
      return (
        <div className="out-actions">
          {block.items.map((a, i) => (
            <ActionButton key={i} action={a} handlers={handlers} small={false} />
          ))}
        </div>
      );
    default:
      return null;
  }
}

export function ToolOutput({ result, handlers }: { result: ToolResult; handlers: ToolActionHandlers }) {
  return (
    <div className="tool-output">
      {result.blocks.map((b, i) => (
        <OutputBlockView key={i} block={b} handlers={handlers} />
      ))}
    </div>
  );
}

// ── Inline result for `>trigger` runs from the search box ──────────────────
export interface InlineToolRun {
  query: string;
  ref?: ToolRef;
  input: Record<string, unknown>;
  result?: ToolResult;
  loading: boolean;
  error?: string;
}

export function ToolCard({
  run,
  handlers,
  onOpenInTools,
  suggestions = [],
  onPick,
}: {
  run: InlineToolRun;
  handlers: ToolActionHandlers;
  onOpenInTools: () => void;
  suggestions?: ToolRef[];
  onPick?: (t: ToolRef) => void;
}) {
  const ref = run.ref;
  return (
    <section className="toolcard" aria-label={ref ? `${ref.tool.name} result` : 'Tool'} aria-busy={run.loading}>
      <header className="toolcard-head">
        <span className="toolcard-icon">
          <PluginIcon icon={ref?.icon} category={ref?.category} />
        </span>
        <div className="toolcard-title">
          <span className="toolcard-plugin">{ref ? ref.pluginName : 'Tools'}</span>
          <strong>{ref ? ref.tool.name : 'Unknown tool'}</strong>
        </div>
        {ref && (
          <button type="button" className="btn btn-ghost btn-sm" onClick={onOpenInTools}>
            Open in Tools <ArrowUpRight size={12} />
          </button>
        )}
      </header>
      {run.loading ? (
        <div className="toolcard-loading">
          <span className="spinner" aria-hidden /> Running {ref?.tool.name}…
        </div>
      ) : run.error ? (
        <>
          <div className="notice notice-warn">{run.error}</div>
          {suggestions.length > 0 && (
            <div className="chips toolcard-suggest">
              {suggestions.map((t) => (
                <button key={t.key} type="button" className="chip" onClick={() => onPick?.(t)} title={t.tool.description}>
                  <span className="mono">&gt;{t.tool.trigger}</span> {t.tool.name}
                </button>
              ))}
            </div>
          )}
        </>
      ) : run.result ? (
        <ToolOutput result={run.result} handlers={handlers} />
      ) : null}
    </section>
  );
}
