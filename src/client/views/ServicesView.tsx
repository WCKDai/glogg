import React, { useCallback, useEffect, useState } from 'react';
import { ExternalLink, Play, RefreshCw, RotateCcw, Square, Terminal } from 'lucide-react';
import type { ContainerStackReport } from '../../core/browser.js';
import { api } from '../lib.js';

type Action = 'up' | 'stop' | 'restart' | 'logs' | 'stack-up' | 'stack-down' | 'start-daemon';

export function ServicesView({ onToast }: { onToast: (t: string, tone?: 'ok' | 'error' | 'info') => void }) {
  const [stack, setStack] = useState<ContainerStackReport | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [log, setLog] = useState('');

  const load = useCallback(async () => {
    try {
      setStack(await api<ContainerStackReport>('/api/containers'));
    } catch (e) {
      onToast((e as Error).message, 'error');
    }
  }, [onToast]);

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 8000);
    return () => clearInterval(t);
  }, [load]);

  const act = async (action: Action, serviceId?: string) => {
    const key = `${action}-${serviceId || 'all'}`;
    setBusy(key);
    try {
      const r = await api<{ ok: boolean; command: string; output: string; stack?: ContainerStackReport }>(
        '/api/containers/action',
        { method: 'POST', json: { action, serviceId } }
      );
      if (r.stack) setStack(r.stack);
      if (action === 'logs' || !r.ok) setLog(`$ ${r.command}\n${r.output}`);
      onToast(r.ok ? `${r.command || action} — done` : `Failed: ${r.command}`, r.ok ? 'ok' : 'error');
    } catch (e) {
      onToast((e as Error).message, 'error');
    } finally {
      setBusy(null);
    }
  };

  const running = stack?.services.filter((s) => s.state === 'running').length ?? 0;

  return (
    <div className="page">
      <header className="page-head">
        <h1>Services</h1>
        <p>Self-hosted engines glogg can use. All optional — search works without any of them.</p>
      </header>

      <div className="toolbar">
        {stack && (
          <span className={`status ${stack.daemonRunning ? 'ok' : 'off'}`}>
            <span className="dot" />
            {stack.activeRuntime === 'none' ? 'No container runtime' : stack.activeRuntime}
            {' · '}
            {stack.daemonRunning ? `${running}/${stack.services.length} running` : 'daemon stopped'}
          </span>
        )}
        <div className="toolbar-spacer" />
        {stack && !stack.daemonRunning && (
          <button className="btn btn-sm" disabled={!!busy} onClick={() => act('start-daemon')}>
            <Play size={13} /> Start runtime
          </button>
        )}
        <button className="btn btn-sm btn-primary" disabled={!!busy} onClick={() => act('stack-up')}>
          {busy === 'stack-up-all' ? 'Starting…' : 'Start all'}
        </button>
        <button className="btn btn-sm" disabled={!!busy} onClick={() => act('stack-down')}>
          Stop all
        </button>
        <button className="icon-btn ghost" onClick={() => void load()} aria-label="Refresh">
          <RefreshCw size={14} />
        </button>
      </div>

      <ul className="services">
        {(stack?.services ?? []).map((svc) => {
          const isUp = svc.state === 'running';
          const b = (a: Action) => busy === `${a}-${svc.id}`;
          return (
            <li key={svc.id} className="service">
              <span className={`dot ${isUp ? 'ok' : svc.state === 'stopped' ? 'warn' : ''}`} />
              <div className="service-main">
                <div className="service-name">
                  {svc.name}
                  <span className="service-cat">{svc.category}</span>
                </div>
                <div className="service-meta">
                  {svc.statusText} · <span className="mono">{svc.ports.join(', ')}</span>
                </div>
              </div>
              <div className="service-actions">
                {isUp ? (
                  <>
                    <a className="btn btn-ghost btn-sm" href={svc.webUrl} target="_blank" rel="noreferrer">
                      Open <ExternalLink size={12} />
                    </a>
                    <button className="icon-btn ghost" disabled={!!busy} onClick={() => act('restart', svc.id)} title="Restart">
                      <RotateCcw size={14} className={b('restart') ? 'spin' : ''} />
                    </button>
                    <button className="icon-btn ghost" disabled={!!busy} onClick={() => act('stop', svc.id)} title="Stop">
                      <Square size={13} />
                    </button>
                  </>
                ) : (
                  <button className="btn btn-sm" disabled={!!busy} onClick={() => act('up', svc.id)}>
                    {b('up') ? 'Starting…' : 'Start'}
                  </button>
                )}
                <button className="icon-btn ghost" onClick={() => act('logs', svc.id)} title="Logs">
                  <Terminal size={14} />
                </button>
              </div>
            </li>
          );
        })}
      </ul>

      {log && (
        <section className="section">
          <div className="section-title-row">
            <h2 className="section-title">Output</h2>
            <button className="link-btn" onClick={() => setLog('')}>
              Clear
            </button>
          </div>
          <pre className="log">{log}</pre>
        </section>
      )}
    </div>
  );
}
