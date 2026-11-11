import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { ArrowUpRight, Play, RefreshCw, Square, Trash2 } from 'lucide-react';
import { PLUGIN_CATEGORY_LABELS } from '../../core/browser.js';
import type { PluginCategory, PluginContainerStatus, PluginInfo, ToolResult } from '../../core/browser.js';
import { api, defaultInputs, runTool } from '../lib.js';
import { PluginIcon, ToolForm, ToolOutput } from '../components/ToolKit.js';
import type { ToolActionHandlers } from '../components/ToolKit.js';

export interface ToolsTarget {
  pluginId: string;
  toolId?: string;
  input?: Record<string, unknown>;
  result?: ToolResult;
  autorun?: boolean;
}

interface Props {
  plugins: PluginInfo[] | null;
  userDir: string;
  target: ToolsTarget | null;
  onReload: () => Promise<void>;
  onChanged: () => void;
  onToast: (t: string, tone?: 'ok' | 'error' | 'info') => void;
  handlers: Pick<ToolActionHandlers, 'onSend' | 'onCopied'>;
  /** Plugins without settings of their own read keys from Settings → Keys. */
  onOpenSettings: () => void;
}

const CATEGORY_ORDER: PluginCategory[] = ['debrid', 'storage', 'usenet', 'osint', 'webtest', 'ai', 'utility', 'search'];

/** Not configured, and either a setting is required or a tool needs the settings. */
export function needsSetup(p: PluginInfo): boolean {
  if (p.configured) return false;
  return Boolean(p.settings?.some((f) => f.required)) || p.tools.some((t) => t.requiresSettings);
}

function matches(p: PluginInfo, q: string): boolean {
  if (!q) return true;
  const hay = [p.name, p.description, p.category, ...p.tools.flatMap((t) => [t.name, t.trigger || '', t.description])]
    .join(' ')
    .toLowerCase();
  return q
    .toLowerCase()
    .split(/\s+/)
    .every((w) => hay.includes(w));
}

export function ToolsView({ plugins, userDir, target, onReload, onChanged, onToast, handlers, onOpenSettings }: Props) {
  const [filter, setFilter] = useState('');
  const [selected, setSelected] = useState<string | null>(target?.pluginId ?? null);
  const [toolByPlugin, setToolByPlugin] = useState<Record<string, string>>({});
  const [inputs, setInputs] = useState<Record<string, Record<string, unknown>>>({});
  const [results, setResults] = useState<Record<string, ToolResult | undefined>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, Record<string, unknown>>>({});
  const [saving, setSaving] = useState(false);
  const [container, setContainer] = useState<Record<string, PluginContainerStatus>>({});
  const [containerBusy, setContainerBusy] = useState(false);
  const [reloading, setReloading] = useState(false);

  const usable = useMemo(() => (plugins || []).filter((p) => !p.error), [plugins]);
  const broken = useMemo(() => (plugins || []).filter((p) => p.error), [plugins]);
  const visible = useMemo(() => usable.filter((p) => matches(p, filter)), [usable, filter]);
  const groups = useMemo(() => {
    const order = [...CATEGORY_ORDER, ...new Set(visible.map((p) => p.category))].filter((c, i, a) => a.indexOf(c) === i);
    return order.map((c) => ({ category: c, items: visible.filter((p) => p.category === c) })).filter((g) => g.items.length > 0);
  }, [visible]);

  const ordered = groups.flatMap((g) => g.items);
  const plugin = usable.find((p) => p.id === selected) || ordered.find((p) => !needsSetup(p)) || ordered[0] || usable[0];
  const toolId = plugin ? toolByPlugin[plugin.id] || plugin.tools[0]?.id : undefined;
  const tool = plugin?.tools.find((t) => t.id === toolId);
  const toolKey = plugin && tool ? `${plugin.id}/${tool.id}` : '';

  const run = useCallback(
    async (pluginId: string, id: string, input: Record<string, unknown>) => {
      const key = `${pluginId}/${id}`;
      setBusy(key);
      try {
        const result = await runTool(pluginId, id, input);
        setResults((r) => ({ ...r, [key]: result }));
      } catch (e) {
        setResults((r) => ({ ...r, [key]: { blocks: [{ type: 'notice', tone: 'bad', content: (e as Error).message }] } }));
      } finally {
        setBusy((b) => (b === key ? null : b));
      }
    },
    []
  );

  // Deep links: palette entries, "Open in Tools" and output actions that run another tool.
  const open = useCallback(
    (t: ToolsTarget) => {
      const p = usable.find((x) => x.id === t.pluginId);
      if (!p) return;
      const id = t.toolId && p.tools.some((x) => x.id === t.toolId) ? t.toolId : p.tools[0]?.id;
      setFilter('');
      setSelected(p.id);
      if (!id) return;
      setToolByPlugin((m) => ({ ...m, [p.id]: id }));
      const key = `${p.id}/${id}`;
      const tl = p.tools.find((x) => x.id === id)!;
      const input = { ...defaultInputs(tl.inputs), ...(t.input || {}) };
      setInputs((m) => ({ ...m, [key]: input }));
      if (t.result) setResults((r) => ({ ...r, [key]: t.result }));
      else if (t.autorun) void run(p.id, id, input);
    },
    [usable, run]
  );

  useEffect(() => {
    if (target) open(target);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target, plugins === null]);

  const loadContainer = useCallback(async (id: string) => {
    try {
      const s = await api<PluginContainerStatus>(`/api/plugins/${encodeURIComponent(id)}/container`);
      setContainer((c) => ({ ...c, [id]: s }));
    } catch {
      // Status is best-effort; the buttons still work.
    }
  }, []);

  useEffect(() => {
    if (plugin?.container) void loadContainer(plugin.id);
  }, [plugin?.id, plugin?.container, loadContainer]);

  if (!plugins) {
    return (
      <div className="page page-wide">
        <div className="skeleton-stack" aria-busy="true" aria-label="Loading tools">
          <div className="skeleton w-40" />
          <div className="skeleton w-80" />
          <div className="skeleton w-70" />
        </div>
      </div>
    );
  }

  const toolHandlers: ToolActionHandlers = {
    ...handlers,
    onRunTool: (ref, input) => {
      const [pluginId, id] = ref.split('/');
      open({ pluginId, toolId: id, input, autorun: true });
    },
  };

  const values = plugin ? { ...(plugin.values || {}), ...(drafts[plugin.id] || {}) } : {};
  const settingsFields = (plugin?.settings || []).map((f) =>
    (f.secret || f.type === 'password') && String(values[f.key] || '').startsWith('••••')
      ? { ...f, help: `Saved. Type to replace it, or clear the field to remove it.${f.help ? ` ${f.help}` : ''}` }
      : f
  );

  const saveSettings = async () => {
    if (!plugin) return;
    setSaving(true);
    try {
      const res = await api<{ configured: boolean }>(`/api/plugins/${encodeURIComponent(plugin.id)}/settings`, {
        method: 'PUT',
        json: { values: drafts[plugin.id] || {} },
      });
      setDrafts((d) => ({ ...d, [plugin.id]: {} }));
      onToast(res.configured ? `${plugin.name} is ready` : `${plugin.name} settings saved`, 'ok');
      onChanged();
    } catch (e) {
      onToast((e as Error).message, 'error');
    } finally {
      setSaving(false);
    }
  };

  const containerAction = async (action: 'up' | 'down' | 'remove') => {
    if (!plugin) return;
    setContainerBusy(true);
    onToast(action === 'up' ? `Starting ${plugin.name}… (first run pulls the image)` : `${action === 'down' ? 'Stopping' : 'Removing'} ${plugin.name}…`, 'info');
    try {
      const s = await api<PluginContainerStatus & { output: string }>(`/api/plugins/${encodeURIComponent(plugin.id)}/container`, {
        method: 'POST',
        json: { action },
      });
      setContainer((c) => ({ ...c, [plugin.id]: s }));
      onToast(`${plugin.name}: ${s.state}`, 'ok');
    } catch (e) {
      onToast((e as Error).message, 'error');
    } finally {
      setContainerBusy(false);
    }
  };

  const setupNeeded = Boolean(plugin && needsSetup(plugin));
  const cs = plugin ? container[plugin.id] : undefined;
  const toolInput = toolKey ? inputs[toolKey] ?? defaultInputs(tool!.inputs) : {};

  return (
    <div className="page page-wide tools-page">
      <header className="page-head">
        <div>
          <h1>Tools</h1>
          <p>
            Every tool is a plugin. Type <kbd>&gt;</kbd> in any search box to run one, e.g. <span className="mono">&gt;dns example.com</span>.
          </p>
        </div>
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          disabled={reloading}
          onClick={async () => {
            setReloading(true);
            try {
              await onReload();
              onToast('Plugins reloaded', 'ok');
            } catch (e) {
              onToast((e as Error).message, 'error');
            } finally {
              setReloading(false);
            }
          }}
        >
          <RefreshCw size={13} className={reloading ? 'spin' : ''} /> Reload
        </button>
      </header>

      <div className="tools">
        <nav className="tools-nav" aria-label="Plugins">
          <input
            className="input"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter tools…"
            aria-label="Filter tools"
          />
          {groups.map((g) => (
            <div key={g.category} className="tools-group">
              <div className="tools-group-title">{PLUGIN_CATEGORY_LABELS[g.category] || g.category}</div>
              {g.items.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  className={`tools-item ${plugin?.id === p.id ? 'active' : ''}`}
                  onClick={() => setSelected(p.id)}
                  aria-current={plugin?.id === p.id}
                >
                  <PluginIcon icon={p.icon} category={p.category} size={14} />
                  <span className="truncate">{p.name}</span>
                  {needsSetup(p) && <span className="dot warn" title="Needs setup" />}
                </button>
              ))}
            </div>
          ))}
          {groups.length === 0 && <p className="muted small">No tool matches “{filter}”.</p>}
          {broken.length > 0 && (
            <div className="tools-group">
              <div className="tools-group-title">Didn't load</div>
              {broken.map((p) => (
                <div key={p.id} className="tools-item broken" title={p.error}>
                  <span className="truncate">{p.id}</span>
                </div>
              ))}
            </div>
          )}
        </nav>

        {plugin && (
          <div className="tools-main">
            <div className="plugin-head">
              <span className="plugin-icon">
                <PluginIcon icon={plugin.icon} category={plugin.category} size={18} />
              </span>
              <div className="plugin-head-text">
                <h2>{plugin.name}</h2>
                <p>{plugin.description}</p>
              </div>
              <div className="plugin-badges">
                {setupNeeded ? <span className="tag tag-warn">Needs setup</span> : <span className="tag tag-ok">Ready</span>}
                {plugin.source === 'user' && <span className="tag">Yours</span>}
                {plugin.homepage && (
                  <a className="btn btn-ghost btn-sm" href={plugin.homepage} target="_blank" rel="noreferrer noopener">
                    Site <ArrowUpRight size={12} />
                  </a>
                )}
              </div>
            </div>

            {plugin.tools.length > 1 && (
              <div className="tool-tabs" role="tablist" aria-label={`${plugin.name} tools`}>
                {plugin.tools.map((t) => (
                  <button
                    key={t.id}
                    type="button"
                    role="tab"
                    aria-selected={t.id === toolId}
                    className={`tool-tab ${t.id === toolId ? 'active' : ''}`}
                    onClick={() => setToolByPlugin((m) => ({ ...m, [plugin.id]: t.id }))}
                    title={t.description}
                  >
                    {t.name}
                  </button>
                ))}
              </div>
            )}

            {tool && (
              <div className="tool-pane" role="tabpanel">
                <p className="tool-desc">
                  {tool.description}
                  {tool.trigger && (
                    <span className="tool-trigger">
                      Shortcut <span className="mono">&gt;{tool.trigger}</span>
                    </span>
                  )}
                </p>
                {tool.requiresSettings && setupNeeded ? (
                  plugin.settings?.length ? (
                    <div className="notice notice-warn">Add your {plugin.name} settings below to use this.</div>
                  ) : (
                    <div className="notice notice-warn">
                      Set up {plugin.name} in Settings → Keys to use this.
                      <button type="button" className="link-btn" onClick={onOpenSettings}>
                        Open Settings
                      </button>
                    </div>
                  )
                ) : tool.inputs.length > 0 ? (
                  <ToolForm
                    key={toolKey}
                    fields={tool.inputs}
                    values={toolInput}
                    onChange={(k, v) => setInputs((m) => ({ ...m, [toolKey]: { ...toolInput, [k]: v } }))}
                    onSubmit={() => void run(plugin.id, tool.id, toolInput)}
                    busy={busy === toolKey}
                    autoFocus
                  />
                ) : (
                  <button type="button" className="btn btn-primary" disabled={busy === toolKey} onClick={() => void run(plugin.id, tool.id, {})}>
                    {busy === toolKey ? <span className="spinner" aria-hidden /> : <Play size={13} />} {busy === toolKey ? 'Running…' : 'Run'}
                  </button>
                )}
                {results[toolKey] && busy !== toolKey && <ToolOutput result={results[toolKey]!} handlers={toolHandlers} />}
              </div>
            )}

            {plugin.container && (
              <div className="plugin-section">
                <h3 className="section-title">Container</h3>
                <div className="container-box">
                  <div className="container-info">
                    <span className="mono truncate">{plugin.container.image}</span>
                    <span className={`tag ${cs?.state === 'running' ? 'tag-ok' : ''}`}>{cs ? cs.state : '…'}</span>
                  </div>
                  <div className="row-gap">
                    {cs?.state === 'running' ? (
                      <button type="button" className="btn btn-sm" disabled={containerBusy} onClick={() => void containerAction('down')}>
                        <Square size={12} /> Stop
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="btn btn-sm btn-accent"
                        disabled={containerBusy || cs?.state === 'unavailable'}
                        onClick={() => void containerAction('up')}
                      >
                        <Play size={12} /> Start
                      </button>
                    )}
                    {cs?.state === 'stopped' && (
                      <button type="button" className="btn btn-sm btn-ghost" disabled={containerBusy} onClick={() => void containerAction('remove')}>
                        <Trash2 size={12} /> Remove
                      </button>
                    )}
                    {cs?.state === 'running' && plugin.container.webUrl && (
                      <a className="btn btn-sm btn-ghost" href={plugin.container.webUrl} target="_blank" rel="noreferrer noopener">
                        Open <ArrowUpRight size={12} />
                      </a>
                    )}
                  </div>
                </div>
                {cs?.detail && <p className="setting-hint">{cs.detail}</p>}
              </div>
            )}

            {settingsFields.length > 0 && (
              <details className="plugin-section plugin-settings" open={setupNeeded} key={plugin.id}>
                <summary className="section-title">Settings</summary>
                <ToolForm
                  fields={settingsFields}
                  values={values}
                  onChange={(k, v) => setDrafts((d) => ({ ...d, [plugin.id]: { ...(d[plugin.id] || {}), [k]: v } }))}
                  onSubmit={() => void saveSettings()}
                  submitLabel={saving ? 'Saving…' : 'Save'}
                  busy={saving}
                />
                <p className="setting-hint">Stored on this machine in ~/.glogg/plugins.json. Keys are never sent to the browser.</p>
              </details>
            )}
          </div>
        )}
      </div>

      <footer className="tools-foot">
        Add your own tool: make a folder in <span className="mono">{userDir || '~/.glogg/plugins'}</span> with an{' '}
        <span className="mono">index.mjs</span> that exports a plugin, then press Reload. Start from{' '}
        <span className="mono">plugins/_template</span>.
      </footer>
    </div>
  );
}
