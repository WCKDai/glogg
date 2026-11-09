import React, { useEffect, useState } from 'react';
import { Plus, X } from 'lucide-react';
import {
  BangDefinition,
  BUILTIN_BANGS,
  CustomEndpointsConfig,
  DEFAULT_SLOP_DOMAINS,
  exportUBlacklistRuleset,
  parseRulesetDomains,
} from '../../core/browser.js';
import { api } from '../lib.js';

export interface SearchPrefs {
  maxPerDomain: number;
  stripSponsored: boolean;
  obscureWebOnly: boolean;
  preLlmOnly: boolean;
  newTab: boolean;
}

interface Props {
  prefs: SearchPrefs;
  setPrefs: (p: SearchPrefs) => void;
  blocked: string[];
  setBlocked: (d: string[]) => void;
  boosted: string[];
  setBoosted: (d: string[]) => void;
  customBangs: BangDefinition[];
  setCustomBangs: (b: BangDefinition[]) => void;
  adultMode: boolean;
  setAdultMode: (on: boolean) => void;
  /** A section to scroll to on open, e.g. 'adult' from the command palette. */
  focus?: string | null;
  onToast: (t: string, tone?: 'ok' | 'error' | 'info') => void;
}

const FIELDS: { group: string; note?: string; fields: { key: keyof CustomEndpointsConfig; label: string; placeholder?: string; secret?: boolean }[] }[] = [
  {
    group: 'Offcloud',
    note: 'Cloud-download magnets, torrents and links. Key from offcloud.com → Account → API.',
    fields: [{ key: 'offcloudApiKey', label: 'API key', secret: true }],
  },
  {
    group: 'NZB.life',
    note: 'Adds NZB.life results to Usenet searches (Newznab API).',
    fields: [
      { key: 'nzbLifeApiKey', label: 'API key', secret: true },
      { key: 'nzbLifeUrl', label: 'API URL', placeholder: 'https://api.nzb.life/api' },
    ],
  },
  {
    group: 'Marginalia',
    note: 'Small-web search. The shared key is rate-limited; ask marginalia-search.com for a free personal key.',
    fields: [{ key: 'marginaliaApiKey', label: 'API key', secret: true }],
  },
  {
    group: 'Stack Exchange',
    note: 'Without a key the API allows 300 requests a day per IP, which heavy use runs out of. A free key from stackapps.com allows 10,000.',
    fields: [{ key: 'stackexchangeKey', label: 'App key', secret: true }],
  },
  {
    group: 'Nextcloud',
    note: 'Save NZBs, torrents and pages to your cloud via WebDAV. Use an app password.',
    fields: [
      { key: 'nextcloudUrl', label: 'Server URL', placeholder: 'https://cloud.example.com' },
      { key: 'nextcloudUser', label: 'User' },
      { key: 'nextcloudAppPassword', label: 'App password', secret: true },
      { key: 'nextcloudFolder', label: 'Folder', placeholder: 'glogg' },
    ],
  },
  {
    group: 'aria2',
    note: 'Local download engine. Start it from Services, or point at your own.',
    fields: [
      { key: 'aria2RpcUrl', label: 'RPC URL', placeholder: 'http://localhost:6800/jsonrpc' },
      { key: 'aria2RpcSecret', label: 'RPC secret', secret: true },
    ],
  },
  {
    group: 'Search backends',
    note: 'Optional self-hosted indexes. Leave blank to skip.',
    fields: [
      { key: 'searxngUrl', label: 'SearXNG', placeholder: 'http://localhost:8080' },
      { key: 'bitmagnetUrl', label: 'Bitmagnet GraphQL', placeholder: 'http://localhost:3333/graphql' },
      { key: 'torznabUrl', label: 'Torznab URL', placeholder: 'http://localhost:9696/1/api' },
      { key: 'torznabApiKey', label: 'Torznab key', secret: true },
      { key: 'newznabUrl', label: 'Newznab URL', placeholder: 'http://localhost:5076/api' },
      { key: 'newznabApiKey', label: 'Newznab key', secret: true },
    ],
  },
];

export function SettingsView(props: Props) {
  const { prefs, setPrefs, blocked, setBlocked, boosted, setBoosted, customBangs, setCustomBangs, adultMode, setAdultMode, focus, onToast } = props;
  const [cfg, setCfg] = useState<CustomEndpointsConfig>({});
  const [dirty, setDirty] = useState(false);
  const [newBang, setNewBang] = useState({ trigger: '', name: '', url: '' });
  const [domainInput, setDomainInput] = useState('');
  const [ruleText, setRuleText] = useState('');
  const [showBuiltins, setShowBuiltins] = useState(false);

  useEffect(() => {
    if (focus) document.getElementById(`settings-${focus}`)?.scrollIntoView({ block: 'start' });
  }, [focus]);

  const [signedIn, setSignedIn] = useState(false);
  useEffect(() => {
    api<{ required: boolean; authenticated: boolean }>('/api/auth')
      .then((a) => setSignedIn(a.required && a.authenticated))
      .catch(() => undefined);
  }, []);
  const signOut = async () => {
    await api('/api/auth/logout', { method: 'POST' }).catch(() => undefined);
    window.location.reload();
  };

  useEffect(() => {
    api<{ config: CustomEndpointsConfig }>('/api/integrations')
      .then((r) => setCfg(r.config))
      .catch(() => undefined);
  }, []);

  const save = async () => {
    try {
      const r = await api<{ config: CustomEndpointsConfig }>('/api/integrations', { method: 'PUT', json: { config: cfg } });
      setCfg(r.config);
      setDirty(false);
      onToast('Integrations saved on this machine', 'ok');
    } catch (e) {
      onToast((e as Error).message, 'error');
    }
  };

  const addBang = (e: React.FormEvent) => {
    e.preventDefault();
    const trigger = newBang.trigger.replace(/^!/, '').trim().toLowerCase();
    if (!trigger || !newBang.url.includes('{q}')) {
      onToast('A bang needs a trigger and a URL containing {q}', 'error');
      return;
    }
    setCustomBangs([
      ...customBangs.filter((b) => b.trigger !== trigger),
      { trigger, name: newBang.name.trim() || trigger, url: newBang.url.trim(), category: 'web' },
    ]);
    setNewBang({ trigger: '', name: '', url: '' });
  };

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>Settings</h1>
          <p>Everything here is optional. Keys are stored on this machine (~/.glogg), never in the browser.</p>
        </div>
        {signedIn && (
          <button type="button" className="btn btn-sm" onClick={() => void signOut()}>
            Sign out
          </button>
        )}
      </header>

      <section className="section">
        <h2 className="section-title">Ranking</h2>
        <div className="settings-list">
          <Toggle
            label="Hide sponsored & affiliate results"
            hint="They're still listed under “filtered” at the bottom."
            on={prefs.stripSponsored}
            set={(v) => setPrefs({ ...prefs, stripSponsored: v })}
          />
          <Toggle
            label="Independent sites only"
            hint="Drop big-platform and content-farm domains entirely."
            on={prefs.obscureWebOnly}
            set={(v) => setPrefs({ ...prefs, obscureWebOnly: v })}
          />
          <Toggle
            label="Before ChatGPT (pre Nov 2022)"
            hint="Prefer pages published before LLM content floods."
            on={prefs.preLlmOnly}
            set={(v) => setPrefs({ ...prefs, preLlmOnly: v })}
          />
          <Toggle label="Open results in a new tab" on={prefs.newTab} set={(v) => setPrefs({ ...prefs, newTab: v })} />
          <div className="setting">
            <div>
              <div className="setting-label">Results per site</div>
              <div className="setting-hint">Stops one domain from taking over the page.</div>
            </div>
            <div className="segmented">
              {[1, 2, 3, 0].map((n) => (
                <button key={n} className={prefs.maxPerDomain === n ? 'active' : ''} onClick={() => setPrefs({ ...prefs, maxPerDomain: n })}>
                  {n === 0 ? '∞' : n}
                </button>
              ))}
            </div>
          </div>
        </div>
      </section>

      <AdultMode on={adultMode} set={setAdultMode} />

      <section className="section">
        <div className="section-title-row">
          <h2 className="section-title">Integrations</h2>
          <button className="btn btn-sm btn-primary" disabled={!dirty} onClick={save}>
            Save
          </button>
        </div>
        {FIELDS.map((g) => (
          <fieldset key={g.group} className="fieldset">
            <legend>{g.group}</legend>
            {g.note && <p className="setting-hint">{g.note}</p>}
            <div className="field-grid">
              {g.fields.map((f) => (
                <label key={f.key} className="field">
                  <span>{f.label}</span>
                  <input
                    className="input"
                    type={f.secret ? 'password' : 'text'}
                    autoComplete="off"
                    value={(cfg[f.key] as string) || ''}
                    placeholder={f.placeholder}
                    onFocus={(e) => f.secret && e.target.value.startsWith('••••') && e.target.select()}
                    onChange={(e) => {
                      setCfg({ ...cfg, [f.key]: e.target.value });
                      setDirty(true);
                    }}
                  />
                </label>
              ))}
            </div>
          </fieldset>
        ))}
      </section>

      <section className="section">
        <h2 className="section-title">Bangs</h2>
        <p className="setting-hint">
          Type <span className="mono">!trigger</span> anywhere in a query to jump to that site. Yours override the built-ins.
        </p>
        <form className="bang-form" onSubmit={addBang}>
          <input className="input mono" placeholder="!trigger" value={newBang.trigger} onChange={(e) => setNewBang({ ...newBang, trigger: e.target.value })} />
          <input className="input" placeholder="Name" value={newBang.name} onChange={(e) => setNewBang({ ...newBang, name: e.target.value })} />
          <input className="input" placeholder="https://example.com/search?q={q}" value={newBang.url} onChange={(e) => setNewBang({ ...newBang, url: e.target.value })} />
          <button className="btn btn-sm" type="submit">
            <Plus size={13} /> Add
          </button>
        </form>
        {customBangs.length > 0 && (
          <ul className="bang-list">
            {customBangs.map((b) => (
              <li key={b.trigger}>
                <span className="mono">!{b.trigger}</span>
                <span>{b.name}</span>
                <span className="muted truncate">{b.url}</span>
                <button className="icon-btn ghost" onClick={() => setCustomBangs(customBangs.filter((x) => x.trigger !== b.trigger))} aria-label="Remove">
                  <X size={13} />
                </button>
              </li>
            ))}
          </ul>
        )}
        <button className="link-btn" onClick={() => setShowBuiltins((s) => !s)}>
          {showBuiltins ? 'Hide' : 'Show'} {BUILTIN_BANGS.length} built-in bangs
        </button>
        {showBuiltins && (
          <ul className="bang-list compact">
            {BUILTIN_BANGS.map((b) => (
              <li key={b.trigger}>
                <span className="mono">!{b.trigger}</span>
                <span>{b.name}</span>
                <span className="muted">{b.category}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="section">
        <h2 className="section-title">Domains</h2>
        <form
          className="add-row"
          onSubmit={(e) => {
            e.preventDefault();
            const d = domainInput.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0];
            if (d) setBlocked(Array.from(new Set([d, ...blocked])));
            setDomainInput('');
          }}
        >
          <input className="input" placeholder="Hide a domain, e.g. contentfarm.com" value={domainInput} onChange={(e) => setDomainInput(e.target.value)} />
          <button className="btn btn-sm">Hide</button>
        </form>
        <DomainList title="Preferred" items={boosted} onRemove={(d) => setBoosted(boosted.filter((x) => x !== d))} />
        <DomainList
          title="Hidden"
          items={blocked}
          onRemove={(d) => setBlocked(blocked.filter((x) => x !== d))}
          action={
            <button className="link-btn" onClick={() => setBlocked(DEFAULT_SLOP_DOMAINS)}>
              Reset to defaults
            </button>
          }
        />

        <details className="details">
          <summary>Import / export (uBlacklist format)</summary>
          <textarea
            className="input textarea mono"
            value={ruleText || exportUBlacklistRuleset(blocked)}
            onChange={(e) => setRuleText(e.target.value)}
          />
          <div className="row-gap">
            <button
              className="btn btn-sm"
              onClick={() => {
                void navigator.clipboard?.writeText(ruleText || exportUBlacklistRuleset(blocked));
                onToast('Copied ruleset', 'ok');
              }}
            >
              Copy
            </button>
            <button
              className="btn btn-sm"
              onClick={() => {
                const parsed = parseRulesetDomains(ruleText);
                if (parsed.length) {
                  setBlocked(Array.from(new Set([...parsed, ...blocked])));
                  onToast(`Imported ${parsed.length} domains`, 'ok');
                }
              }}
            >
              Import from text
            </button>
          </div>
        </details>
      </section>
    </div>
  );
}

/**
 * 18+ mode. Kept out of the top bar and the rail so a stray click can't turn it on:
 * the switch only asks, and nothing changes until the confirmation. Turning it off is immediate.
 * The row is not a <label>, so only the switch itself responds.
 */
function AdultMode({ on, set }: { on: boolean; set: (v: boolean) => void }) {
  const [asking, setAsking] = useState(false);
  return (
    <section className="section" id="settings-adult">
      <h2 className="section-title">18+ mode</h2>
      <div className="settings-list">
        <div className="setting">
          <div>
            <div className="setting-label">Unfiltered results</div>
            <div className="setting-hint">
              Turns SafeSearch off for the engines glogg asks, and shows 18+ boards, forums, torrents and archive posts. Off unless you turn it on here.
            </div>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={on}
            aria-label="18+ mode"
            className={`switch switch-danger ${on ? 'on' : ''}`}
            onClick={() => (on ? set(false) : setAsking(true))}
          >
            <span />
          </button>
        </div>
        {asking && !on && (
          <div className="setting adult-confirm" role="alertdialog" aria-labelledby="adult-confirm-title">
            <div>
              <div className="setting-label" id="adult-confirm-title">
                Turn on 18+ mode?
              </div>
              <div className="setting-hint">Results can include explicit adult content. Only for people 18 or older.</div>
            </div>
            <div className="row-gap">
              <button type="button" className="btn btn-sm" onClick={() => setAsking(false)}>
                Cancel
              </button>
              <button
                type="button"
                className="btn btn-sm btn-danger"
                onClick={() => {
                  set(true);
                  setAsking(false);
                }}
              >
                I'm 18 or older, turn it on
              </button>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}

function Toggle({ label, hint, on, set }: { label: string; hint?: string; on: boolean; set: (v: boolean) => void }) {
  return (
    <label className="setting">
      <div>
        <div className="setting-label">{label}</div>
        {hint && <div className="setting-hint">{hint}</div>}
      </div>
      <button type="button" role="switch" aria-checked={on} className={`switch ${on ? 'on' : ''}`} onClick={() => set(!on)}>
        <span />
      </button>
    </label>
  );
}

function DomainList({ title, items, onRemove, action }: { title: string; items: string[]; onRemove: (d: string) => void; action?: React.ReactNode }) {
  return (
    <div className="domain-block">
      <div className="section-title-row">
        <h3 className="subhead">
          {title} <span className="muted">{items.length}</span>
        </h3>
        {action}
      </div>
      {items.length === 0 ? (
        <p className="empty">None.</p>
      ) : (
        <div className="chips">
          {items.slice(0, 80).map((d) => (
            <span key={d} className="chip chip-static">
              {d}
              <button onClick={() => onRemove(d)} aria-label={`Remove ${d}`}>
                <X size={11} />
              </button>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
