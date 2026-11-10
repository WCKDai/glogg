import React, { useCallback, useEffect, useState } from 'react';
import { Check, Cloud, Download, HardDrive, Link2, Magnet, Trash2, X } from 'lucide-react';
import type { DownloadJob, DownloadManagerReport, DownloadTargetId } from '../../core/browser.js';
import { api, relativeDate, sendToDownloads, targetLabel, useDownloadTargets } from '../lib.js';

const KIND_ICON: Record<DownloadJob['kind'], React.ReactNode> = {
  magnet: <Magnet size={15} />,
  torrent: <Magnet size={15} />,
  nzb: <Download size={15} />,
  'direct-file': <HardDrive size={15} />,
  'web-archive': <Link2 size={15} />,
};

export function DownloadsView({
  onToast,
  onOpenSettings,
}: {
  onToast: (t: string, tone?: 'ok' | 'error' | 'info') => void;
  onOpenSettings: () => void;
}) {
  const [report, setReport] = useState<DownloadManagerReport | null>(null);
  const [url, setUrl] = useState('');
  const [target, setTarget] = useState<DownloadTargetId>('auto');
  const [busy, setBusy] = useState(false);
  const targets = useDownloadTargets();
  const labelFor = (t: string) => targetLabel(t, targets);

  // Polling every few seconds: one failure shows as a line on the page, not a toast each time.
  // What went wrong with the last poll: the server's reason, or that glogg can't be reached at all.
  const [problem, setProblem] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      setReport(await api<DownloadManagerReport>('/api/downloads'));
      setProblem(null);
    } catch (e) {
      const msg = e instanceof Error ? e.message : '';
      setProblem(/failed to fetch|networkerror|load failed/i.test(msg) || !msg ? "Can't reach glogg right now" : msg);
    }
  }, []);

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 4000);
    return () => clearInterval(t);
  }, [load]);

  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!url.trim()) return;
    setBusy(true);
    try {
      const { job } = await sendToDownloads({ url: url.trim(), target });
      onToast(job.status === 'failed' ? job.statusDetail : `Sent to ${labelFor(job.target)}`, job.status === 'failed' ? 'error' : 'ok');
      setUrl('');
      void load();
    } catch (err) {
      onToast((err as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };

  // A refusal ("stop the download first") is said, not swallowed.
  const remove = async (id: string) => {
    try {
      await api(`/api/downloads/${id}`, { method: 'DELETE' });
    } catch (e) {
      onToast((e as Error).message, 'error');
    }
    void load();
  };

  const integ = report?.integrations;
  const jobs = report?.jobs ?? [];
  const active = jobs.filter((j) => j.status === 'downloading' || j.status === 'queued');
  const done = jobs.filter((j) => !(j.status === 'downloading' || j.status === 'queued'));

  return (
    <div className="page">
      {problem && (
        <div className="notice notice-error" role="alert">
          {problem}; trying again every few seconds.
        </div>
      )}
      <header className="page-head">
        <h1>Downloads</h1>
        <p>Paste a magnet, .torrent, .nzb or any file URL. glogg routes it to Offcloud, aria2, Nextcloud, or this machine.</p>
      </header>

      <form className="add-row" onSubmit={add}>
        <input
          className="input"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="magnet:?xt=… · https://…/file.nzb · https://…/debian.iso"
          aria-label="URL to download"
        />
        <select className="input select" value={target} onChange={(e) => setTarget(e.target.value as DownloadTargetId)} aria-label="Destination">
          {targets.map((t) => (
            <option key={t.id} value={t.id}>
              {t.label}
            </option>
          ))}
        </select>
        <button className="btn btn-primary" disabled={busy || !url.trim()}>
          {busy ? 'Sending…' : 'Send'}
        </button>
      </form>

      {integ && (
        <div className="destinations">
          <Destination name="Offcloud" on={integ.offcloudConfigured} icon={<Cloud size={14} />} />
          <Destination name="aria2" on={integ.aria2Reachable} icon={<Download size={14} />} />
          <Destination name="Nextcloud" on={integ.nextcloudConfigured} icon={<Cloud size={14} />} />
          <Destination name="NZB.life" on={integ.nzbLifeConfigured} icon={<Download size={14} />} />
          {(report?.pluginTargets || []).map((t) => (
            <Destination key={t.id} name={t.label} on={t.configured} icon={<Download size={14} />} />
          ))}
          <span className="destinations-local" title={integ.localDownloadsDir}>
            <HardDrive size={14} /> {integ.localDownloadsDir.replace(/^\/Users\/[^/]+/, '~')}
          </span>
          <button type="button" className="link-btn" onClick={onOpenSettings}>
            Configure
          </button>
        </div>
      )}

      {active.length > 0 && (
        <section className="section">
          <h2 className="section-title">In progress</h2>
          <ul className="jobs">{active.map((j) => <JobRow key={j.id} job={j} onRemove={remove} />)}</ul>
        </section>
      )}

      <section className="section">
        <div className="section-title-row">
          <h2 className="section-title">History</h2>
          {done.length > 0 && (
            <button
              type="button"
              className="link-btn"
              onClick={async () => {
                try {
                  await api('/api/downloads/finished', { method: 'DELETE' });
                } catch (e) {
                  onToast((e as Error).message, 'error');
                }
                void load();
              }}
            >
              Clear
            </button>
          )}
        </div>
        {done.length === 0 ? (
          <p className="empty">Nothing yet. Use “Send” on any torrent, NZB, or result.</p>
        ) : (
          <ul className="jobs">{done.map((j) => <JobRow key={j.id} job={j} onRemove={remove} />)}</ul>
        )}
      </section>
    </div>
  );
}

function Destination({ name, on, icon }: { name: string; on: boolean; icon: React.ReactNode }) {
  return (
    <span className={`destination ${on ? 'on' : ''}`}>
      {icon} {name} {on ? <Check size={12} aria-hidden /> : <X size={12} aria-hidden />}
      <span className="sr-only">{on ? '(set up)' : '(not set up)'}</span>
    </span>
  );
}

function JobRow({ job, onRemove }: { job: DownloadJob; onRemove: (id: string) => void }) {
  const targets = useDownloadTargets();
  const running = job.status === 'downloading' || job.status === 'queued';
  return (
    <li className={`job job-${job.status}`}>
      <div className="job-icon">{KIND_ICON[job.kind]}</div>
      <div className="job-main">
        <div className="job-title" title={job.sourceUrl}>
          {job.title}
        </div>
        <div className="job-meta">
          <span>{targetLabel(job.target, targets)}</span>
          <span>{job.statusDetail}</span>
          {job.sizeFormatted && <span>{job.sizeFormatted}</span>}
          <span>{relativeDate(job.createdAt)}</span>
        </div>
        {running && (
          <div className="progress" role="progressbar" aria-label={job.title} aria-valuemin={0} aria-valuemax={100} aria-valuenow={job.progressPercent}>
            <div style={{ width: `${Math.max(3, job.progressPercent)}%` }} />
          </div>
        )}
      </div>
      {job.destinationUrl?.startsWith('http') && (
        <a className="btn btn-ghost btn-sm" href={job.destinationUrl} target="_blank" rel="noreferrer">
          Open
        </a>
      )}
      <button type="button" className="icon-btn ghost" onClick={() => onRemove(job.id)} aria-label="Remove">
        <Trash2 size={14} />
      </button>
    </li>
  );
}
