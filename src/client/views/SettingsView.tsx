import { useFeatures } from '../capabilities.js';
import React, { useEffect, useRef, useState } from 'react';
import { Download, Plus, Upload, X } from 'lucide-react';
import {
  BangDefinition,
  BUILTIN_BANGS,
  CustomEndpointsConfig,
  DEFAULT_SLOP_DOMAINS,
  exportUBlacklistRuleset,
  parseRulesetDomains,
  SEARCH_SOURCES,
} from '../../core/browser.js';
import type { SearchLensId } from '../../core/browser.js';
import { api, applyProfile, cleanDomain, DOMAIN_RULES, readProfile, SCOPES } from '../lib.js';
import type { DomainRule, SettingsProfile, ThemePref } from '../lib.js';

/** How hard the junk filter is; each maps to the slop score above which a result is hidden. */
export type Strictness = 'relaxed' | 'balanced' | 'strict';
export const STRICTNESS_THRESHOLD: Record<Strictness, number> = { relaxed: 62, balanced: 48, strict: 36 };

export const ACCENTS = ['blue', 'green', 'violet', 'orange', 'rose', 'graphite'] as const;
export type Accent = (typeof ACCENTS)[number];

export interface SearchPrefs {
  maxPerDomain: number;
  stripSponsored: boolean;
  obscureWebOnly: boolean;
  preLlmOnly: boolean;
  newTab: boolean;
  strictness: Strictness;
  /** The scope a search starts in when the address doesn't say. */
  defaultScope: SearchLensId;
  density: 'comfortable' | 'compact';
  /** Site icons on result rows (fetched through glogg), or letters only. */
  siteIcons: boolean;
  /** j/k/o/r/d/m/? and / as shortcuts; off for screen readers and voice control (WCAG 2.1.4). */
  singleKeys: boolean;
  rememberHistory: boolean;
  /** Keys from SEARCH_SOURCES that searches skip. */
  disabledSources: string[];
  accent: Accent;
}

export const DEFAULT_PREFS: SearchPrefs = {
  maxPerDomain: 2,
  stripSponsored: true,
  obscureWebOnly: false,
  preLlmOnly: false,
  newTab: true,
  strictness: 'balanced',
  defaultScope: 'all',
  density: 'comfortable',
  siteIcons: true,
  singleKeys: true,
  rememberHistory: true,
  disabledSources: [],
  accent: 'blue',
};

interface Props {
  prefs: SearchPrefs;
  setPrefs: (p: SearchPrefs) => void;
  domains: Record<DomainRule, string[]>;
  setDomains: (d: Record<DomainRule, string[]>) => void;
  phrases: string[];
  setPhrases: (p: string[]) => void;
  customBangs: BangDefinition[];
  setCustomBangs: (b: BangDefinition[]) => void;
  theme: ThemePref;
  setTheme: (t: ThemePref) => void;
  historyCount: number;
  clearHistory: () => void;
  adultMode: boolean;
  setAdultMode: (on: boolean) => void;
  /** A section to scroll to on open, e.g. 'adult' from the command palette. */
  focus?: string | null;
  onToast: (t: string, tone?: 'ok' | 'error' | 'info') => void;
  onShowShortcuts: () => void;
}

const SECTIONS = [
  ['search', 'Search'],
  ['results', 'Results'],
  ['sources', 'Sources'],
  ['domains', 'Domains'],
  ['bangs', 'Bangs'],
  ['appearance', 'Appearance'],
  ['keyboard', 'Keyboard'],
  ['history', 'History'],
  ['adult', '18+'],
  ['integrations', 'Keys'],
  ['yours', 'Your settings'],
] as const;

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
    group: 'Brave Search',
    note: "Web results from Brave's own index. Its search page mostly answers glogg with a captcha; with a key from api-dashboard.search.brave.com, glogg uses the Search API instead. Paid per request, with free credit each month.",
    fields: [{ key: 'braveApiKey', label: 'API key', secret: true }],
  },
  {
    group: 'Mojeek Search',
    note: "Independent UK crawler index (mojeek.com/services/api). Queried only when a key is saved.",
    fields: [{ key: 'mojeekApiKey', label: 'API key', secret: true }],
  },
  {
    group: 'Kagi Search',
    note: 'Curated ad-free web index (kagi.com/settings?p=api). Queried only when a key is saved.',
    fields: [{ key: 'kagiApiKey', label: 'API key', secret: true }],
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
  const features = useFeatures();
  const { prefs, setPrefs, domains, setDomains, phrases, setPhrases, customBangs, setCustomBangs, theme, setTheme, adultMode, setAdultMode, focus, onToast } = props;
  const [cfg, setCfg] = useState<CustomEndpointsConfig>({});
  const [dirty, setDirty] = useState(false);
  const [newBang, setNewBang] = useState({ trigger: '', name: '', url: '' });
  const [domainInput, setDomainInput] = useState('');
  const [domainRule, setDomainRule] = useState<DomainRule>('hide');
  const [phraseInput, setPhraseInput] = useState('');
  const [ruleText, setRuleText] = useState('');
  const [showBuiltins, setShowBuiltins] = useState(false);
  const [savedHere, setSavedHere] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const set = <K extends keyof SearchPrefs>(key: K, value: SearchPrefs[K]) => setPrefs({ ...prefs, [key]: value });

  useEffect(() => {
    if (focus) document.getElementById(`settings-${focus}`)?.scrollIntoView({ block: 'start' });
  }, [focus]);

  const [signedIn, setSignedIn] = useState(false);
  useEffect(() => {
    api<{ required: boolean; authenticated: boolean }>('/api/auth')
      .then((a) => setSignedIn(a.required && a.authenticated))
      .catch(() => undefined);
    if (features.savedProfiles) api<{ savedAt: string }>('/api/profile')
      .then((p) => setSavedHere(p.savedAt))
      .catch(() => undefined);
  }, [features.savedProfiles]);
  const signOut = async () => {
    await api('/api/auth/logout', { method: 'POST' }).catch(() => undefined);
    window.location.reload();
  };

  useEffect(() => {
    if (!features.administration) return;
    api<{ config: CustomEndpointsConfig }>('/api/integrations')
      .then((r) => setCfg(r.config))
      .catch(() => undefined);
  }, [features.administration]);

  // Keys save with a button; leaving with unsaved ones asks first.
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  const save = async () => {
    try {
      const r = await api<{ config: CustomEndpointsConfig }>('/api/integrations', { method: 'PUT', json: { config: cfg } });
      setCfg(r.config);
      setDirty(false);
      onToast('Keys saved on this glogg', 'ok');
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
    if (!/^https?:\/\//i.test(newBang.url.trim())) {
      onToast('A bang URL starts with https:// or http://', 'error');
      return;
    }
    setCustomBangs([
      ...customBangs.filter((b) => b.trigger !== trigger),
      { trigger, name: newBang.name.trim() || trigger, url: newBang.url.trim(), category: 'web' },
    ]);
    setNewBang({ trigger: '', name: '', url: '' });
  };

  const addDomain = (e: React.FormEvent) => {
    e.preventDefault();
    const d = cleanDomain(domainInput);
    if (!d || !d.includes('.')) {
      onToast('Type a domain, like contentfarm.com', 'error');
      return;
    }
    const next = Object.fromEntries(DOMAIN_RULES.map((r) => [r.id, domains[r.id].filter((x) => x !== d)])) as Record<DomainRule, string[]>;
    next[domainRule] = [d, ...next[domainRule]];
    setDomains(next);
    setDomainInput('');
  };

  const addPhrase = (e: React.FormEvent) => {
    e.preventDefault();
    const phrase = phraseInput.trim();
    if (phrase.length < 2) return;
    setPhrases(Array.from(new Set([phrase, ...phrases])));
    setPhraseInput('');
  };

  const exportFile = () => {
    const blob = new Blob([JSON.stringify(readProfile(), null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `glogg-settings-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const importProfile = (profile: unknown, from: string) => {
    try {
      const n = applyProfile(profile);
      onToast(`Loaded ${n} settings from ${from}`, 'ok');
      // Every setting is read once at start, so start again with the new ones.
      setTimeout(() => window.location.reload(), 600);
    } catch (e) {
      onToast((e as Error).message, 'error');
    }
  };

  const importFile = async (file: File | undefined) => {
    if (!file) return;
    try {
      importProfile(JSON.parse(await file.text()), file.name);
    } catch {
      onToast("That file isn't readable JSON.", 'error');
    }
  };

  const saveHere = async () => {
    try {
      const r = await api<{ savedAt: string }>('/api/profile', { method: 'PUT', json: { settings: readProfile() } });
      setSavedHere(r.savedAt);
      onToast('Saved on this glogg: load them in any other browser', 'ok');
    } catch (e) {
      onToast((e as Error).message, 'error');
    }
  };

  const loadHere = async () => {
    try {
      const r = await api<{ settings: SettingsProfile }>('/api/profile');
      importProfile(r.settings, 'this glogg');
    } catch (e) {
      onToast((e as Error).message, 'error');
    }
  };

  const sourceOn = (key: string) => !prefs.disabledSources.includes(key);
  const setSource = (key: string, on: boolean) =>
    set('disabledSources', on ? prefs.disabledSources.filter((k) => k !== key) : [...prefs.disabledSources, key]);

  return (
    <div className="page settings-page">
      <header className="page-head">
        <div>
          <h1>Settings</h1>
          <p>Changes apply at once and stay in this browser.{features.administration && " Keys are kept by glogg on this machine."}{features.savedProfiles && " Save your settings to this glogg to use them elsewhere."}</p>
        </div>
        {signedIn && (
          <button type="button" className="btn btn-sm" onClick={() => void signOut()}>
            Sign out
          </button>
        )}
      </header>

      <nav className="settings-index" aria-label="Settings sections">
        {SECTIONS.filter(([id]) => id !== 'integrations' || features.administration).map(([id, label]) => (
          <a key={id} href={`#settings-${id}`} onClick={(e) => { e.preventDefault(); document.getElementById(`settings-${id}`)?.scrollIntoView({ block: 'start' }); }}>
            {label}
          </a>
        ))}
      </nav>

      <section className="section" id="settings-search">
        <h2 className="section-title">Search</h2>
        <div className="settings-list">
          <Choice
            label="Junk filter"
            hint="How readily glogg hides SEO farms, AI filler and affiliate pages."
            value={prefs.strictness}
            options={[['relaxed', 'Relaxed'], ['balanced', 'Balanced'], ['strict', 'Strict']]}
            set={(v) => set('strictness', v)}
          />
          <Choice
            label="Results per site"
            hint="Stops one domain from taking over the page."
            value={String(prefs.maxPerDomain)}
            options={[['1', '1'], ['2', '2'], ['3', '3'], ['0', 'Any']]}
            set={(v) => set('maxPerDomain', Number(v))}
          />
          <Toggle label="Hide sponsored and affiliate results" hint="They're still listed under “hidden” at the bottom." on={prefs.stripSponsored} set={(v) => set('stripSponsored', v)} />
          <Toggle label="Independent sites only" hint="Drop big-platform and content-farm domains entirely." on={prefs.obscureWebOnly} set={(v) => set('obscureWebOnly', v)} />
          <Toggle label="Before ChatGPT (before Nov 2022)" hint="Only pages published before LLM content flooded the web." on={prefs.preLlmOnly} set={(v) => set('preLlmOnly', v)} />
          <div className="setting">
            <div>
              <div className="setting-label" id="default-scope-label">Start searches in</div>
              <div className="setting-hint">The scope a new search uses; you can still switch on the results page.</div>
            </div>
            <select className="input select" aria-labelledby="default-scope-label" value={prefs.defaultScope} onChange={(e) => set('defaultScope', e.target.value as SearchLensId)}>
              {SCOPES.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.label}
                </option>
              ))}
            </select>
          </div>
        </div>
        <h3 className="subhead">Hidden phrases</h3>
        <p className="setting-hint">Results that mention any of these are hidden, wherever they come from.</p>
        <form className="add-row" onSubmit={addPhrase}>
          <input className="input" aria-label="Phrase to hide" placeholder="e.g. sponsored content, top 10" value={phraseInput} onChange={(e) => setPhraseInput(e.target.value)} />
          <button className="btn btn-sm">Hide phrase</button>
        </form>
        <Chips items={phrases} onRemove={(p) => setPhrases(phrases.filter((x) => x !== p))} empty="None yet." />
      </section>

      <section className="section" id="settings-results">
        <h2 className="section-title">Results</h2>
        <div className="settings-list">
          <Choice
            label="Density"
            hint="Compact fits more results on a screen: one-line snippets, tighter rows."
            value={prefs.density}
            options={[['comfortable', 'Comfortable'], ['compact', 'Compact']]}
            set={(v) => set('density', v)}
          />
          <Toggle label="Open results in a new tab" hint="For result links, Enter and o." on={prefs.newTab} set={(v) => set('newTab', v)} />
          <Toggle label="Site icons" hint="Fetched by glogg, so the sites on your results page aren't told to anyone. Off shows letters." on={prefs.siteIcons} set={(v) => set('siteIcons', v)} />
        </div>
      </section>

      <section className="section" id="settings-sources">
        <div className="section-title-row">
          <h2 className="section-title">Sources</h2>
          {prefs.disabledSources.length > 0 && (
            <button type="button" className="link-btn" onClick={() => set('disabledSources', [])}>
              Turn all on
            </button>
          )}
        </div>
        <p className="setting-hint">What a search asks. Turning off ones you never use makes searches lighter; the status bar shows how each one did.</p>
        <div className="settings-list">
          {SEARCH_SOURCES.map((src) => (
            <Toggle key={src.key} label={src.name} hint={src.about} on={sourceOn(src.key)} set={(v) => setSource(src.key, v)} />
          ))}
        </div>
      </section>

      <section className="section" id="settings-domains">
        <h2 className="section-title">Domains</h2>
        <p className="setting-hint">Tell glogg what you think of a site. Each result's ⋯ menu does the same.</p>
        <form className="add-row" onSubmit={addDomain}>
          <input className="input" aria-label="Domain" placeholder="contentfarm.com" value={domainInput} onChange={(e) => setDomainInput(e.target.value)} />
          <select className="input select" aria-label="What to do with it" value={domainRule} onChange={(e) => setDomainRule(e.target.value as DomainRule)}>
            {DOMAIN_RULES.map((r) => (
              <option key={r.id} value={r.id}>
                {r.verb}
              </option>
            ))}
          </select>
          <button className="btn btn-sm">Add</button>
        </form>
        {DOMAIN_RULES.map((r) => (
          <DomainList
            key={r.id}
            title={r.label}
            hint={r.hint}
            items={domains[r.id]}
            onRemove={(d) => setDomains({ ...domains, [r.id]: domains[r.id].filter((x) => x !== d) })}
            action={
              r.id === 'hide' ? (
                <ConfirmButton label="Reset to defaults" confirm={`Replace your ${domains.hide.length} hidden domains with the ${DEFAULT_SLOP_DOMAINS.length} defaults?`} onConfirm={() => setDomains({ ...domains, hide: DEFAULT_SLOP_DOMAINS })} />
              ) : undefined
            }
          />
        ))}

        <details className="details">
          <summary>Import / export hidden domains (uBlacklist format)</summary>
          <textarea
            className="input textarea mono"
            aria-label="Hidden domains as uBlacklist rules"
            value={ruleText || exportUBlacklistRuleset(domains.hide)}
            onChange={(e) => setRuleText(e.target.value)}
          />
          <div className="row-gap">
            <button
              className="btn btn-sm"
              onClick={() => {
                void navigator.clipboard?.writeText(ruleText || exportUBlacklistRuleset(domains.hide));
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
                  setDomains({ ...domains, hide: Array.from(new Set([...parsed, ...domains.hide])) });
                  onToast(`Imported ${parsed.length} domains`, 'ok');
                }
              }}
            >
              Import from text
            </button>
          </div>
        </details>
      </section>

      <section className="section" id="settings-bangs">
        <h2 className="section-title">Bangs</h2>
        <p className="setting-hint">
          Type <span className="mono">!trigger</span> anywhere in a query to jump to that site. Yours override the built-ins; add one with the same trigger to change it.
        </p>
        <form className="bang-form" onSubmit={addBang}>
          <input className="input mono" aria-label="Trigger" placeholder="!trigger" value={newBang.trigger} onChange={(e) => setNewBang({ ...newBang, trigger: e.target.value })} />
          <input className="input" aria-label="Name" placeholder="Name" value={newBang.name} onChange={(e) => setNewBang({ ...newBang, name: e.target.value })} />
          <input className="input" aria-label="Search URL with {q}" placeholder="https://example.com/search?q={q}" value={newBang.url} onChange={(e) => setNewBang({ ...newBang, url: e.target.value })} />
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
                <button type="button" className="link-btn" onClick={() => setNewBang({ trigger: b.trigger, name: b.name, url: b.url })}>
                  Edit
                </button>
                <button type="button" className="icon-btn ghost" onClick={() => setCustomBangs(customBangs.filter((x) => x.trigger !== b.trigger))} aria-label={`Remove !${b.trigger}`}>
                  <X size={13} />
                </button>
              </li>
            ))}
          </ul>
        )}
        <button type="button" className="link-btn" onClick={() => setShowBuiltins((s) => !s)} aria-expanded={showBuiltins}>
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

      <section className="section" id="settings-appearance">
        <h2 className="section-title">Appearance</h2>
        <div className="settings-list">
          <Choice label="Theme" value={theme} options={[['system', 'System'], ['light', 'Light'], ['dark', 'Dark']]} set={setTheme} />
          <div className="setting">
            <div>
              <div className="setting-label" id="accent-label">Accent</div>
              <div className="setting-hint">Links, focus rings and the active section.</div>
            </div>
            <div className="swatches" role="radiogroup" aria-labelledby="accent-label">
              {ACCENTS.map((a) => (
                <button key={a} type="button" role="radio" aria-checked={prefs.accent === a} aria-label={a} className={`swatch swatch-${a}`} onClick={() => set('accent', a)} />
              ))}
            </div>
          </div>
        </div>
      </section>

      <section className="section" id="settings-keyboard">
        <h2 className="section-title">Keyboard</h2>
        <div className="settings-list">
          <Toggle
            label="Single-key shortcuts"
            hint="j/k to move, o to open, r to read, d to save, m for the view, / to search, ? for help. Turn off if you use a screen reader or voice control; ⌘K and Esc always work."
            on={prefs.singleKeys}
            set={(v) => set('singleKeys', v)}
          />
        </div>
        <button type="button" className="link-btn" onClick={props.onShowShortcuts}>
          See every shortcut
        </button>
      </section>

      <section className="section" aria-labelledby="install-title">
        <h2 className="section-title" id="install-title">Install on iPhone</h2>
        <p className="setting-hint">In Safari, open Share, choose Add to Home Screen, then Add. Saved links work offline after the first online visit. Search and reading need a connection.</p>
      </section>

      <section className="section" id="settings-history">
        <h2 className="section-title">History</h2>
        <div className="settings-list">
          <Toggle label="Remember my searches" hint="Your last few searches, on the start screen. Only in this browser." on={prefs.rememberHistory} set={(v) => set('rememberHistory', v)} />
        </div>
        <button type="button" className="btn btn-sm" disabled={props.historyCount === 0} onClick={props.clearHistory}>
          Clear {props.historyCount > 0 ? props.historyCount : ''} recent searches
        </button>
      </section>

      <AdultMode on={adultMode} set={setAdultMode} />

      {features.administration && <section className="section" id="settings-integrations">
        <div className="section-title-row">
          <h2 className="section-title">Keys and services</h2>
          <button className="btn btn-sm btn-primary" disabled={!dirty} onClick={save}>
            {dirty ? 'Save' : 'Saved'}
          </button>
        </div>
        <p className="setting-hint">Kept by glogg on this machine (~/.glogg), never in the browser, and shown back only as their last four characters.</p>
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
      </section>}

      <section className="section" id="settings-yours">
        <h2 className="section-title">Your settings</h2>
        <p className="setting-hint">Export browser preferences as a file.{features.savedProfiles && " You can also keep them on this glogg for your other browsers and devices."}</p>
        <div className="row-gap wrap">
          <button type="button" className="btn btn-sm" onClick={exportFile}>
            <Download size={13} /> Export file
          </button>
          <button type="button" className="btn btn-sm" onClick={() => fileRef.current?.click()}>
            <Upload size={13} /> Import file
          </button>
          <input ref={fileRef} type="file" accept="application/json,.json" hidden aria-label="Settings file" onChange={(e) => void importFile(e.target.files?.[0])} />
          {features.savedProfiles && <><button type="button" className="btn btn-sm" onClick={() => void saveHere()}>
            Save to this glogg
          </button>
          <button type="button" className="btn btn-sm" disabled={!savedHere} onClick={() => void loadHere()}>
            Load from this glogg
          </button></>}
        </div>
        {features.savedProfiles && <p className="setting-hint">{savedHere ? `Last saved here ${new Date(savedHere).toLocaleString()}.` : 'Nothing saved on this glogg yet.'}</p>}
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
  const toggle = useRef<HTMLButtonElement>(null);
  const cancelButton = useRef<HTMLButtonElement>(null);
  // The question takes focus (on Cancel, the safe answer); Escape cancels and goes back to the switch.
  useEffect(() => {
    if (asking) cancelButton.current?.focus();
  }, [asking]);
  const cancel = () => {
    setAsking(false);
    toggle.current?.focus();
  };
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
            ref={toggle}
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
          <div
            className="setting adult-confirm"
            role="alertdialog"
            aria-labelledby="adult-confirm-title"
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.stopPropagation();
                cancel();
              }
            }}
          >
            <div>
              <div className="setting-label" id="adult-confirm-title">
                Turn on 18+ mode?
              </div>
              <div className="setting-hint">Results can include explicit adult content. Only for people 18 or older.</div>
            </div>
            <div className="row-gap">
              <button ref={cancelButton} type="button" className="btn btn-sm" onClick={cancel}>
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

function DomainList({ title, hint, items, onRemove, action }: { title: string; hint?: string; items: string[]; onRemove: (d: string) => void; action?: React.ReactNode }) {
  const [all, setAll] = useState(false);
  const shown = all ? items : items.slice(0, 60);
  return (
    <div className="domain-block">
      <div className="section-title-row">
        <h3 className="subhead">
          {title} <span className="muted">{items.length}</span>
        </h3>
        {action}
      </div>
      {hint && <p className="setting-hint">{hint}</p>}
      <Chips items={shown} onRemove={onRemove} empty="None." />
      {items.length > shown.length && (
        <button type="button" className="link-btn" onClick={() => setAll(true)}>
          Show all {items.length}
        </button>
      )}
    </div>
  );
}

function Choice<T extends string>({ label, hint, value, options, set }: { label: string; hint?: string; value: T; options: [T, string][]; set: (v: T) => void }) {
  const id = `choice-${label.replace(/\W+/g, '-').toLowerCase()}`;
  return (
    <div className="setting">
      <div>
        <div className="setting-label" id={id}>
          {label}
        </div>
        {hint && <div className="setting-hint">{hint}</div>}
      </div>
      <div className="segmented" role="radiogroup" aria-labelledby={id}>
        {options.map(([v, text]) => (
          <button key={v} type="button" role="radio" aria-checked={value === v} className={value === v ? 'active' : ''} onClick={() => set(v)}>
            {text}
          </button>
        ))}
      </div>
    </div>
  );
}

function Chips({ items, onRemove, empty }: { items: string[]; onRemove: (d: string) => void; empty: string }) {
  if (items.length === 0) return <p className="empty">{empty}</p>;
  return (
    <div className="chips">
      {items.map((d) => (
        <span key={d} className="chip chip-static">
          {d}
          <button type="button" onClick={() => onRemove(d)} aria-label={`Remove ${d}`}>
            <X size={11} />
          </button>
        </span>
      ))}
    </div>
  );
}

/** A button that asks before it does something you can't take back. */
function ConfirmButton({ label, confirm, onConfirm }: { label: string; confirm: string; onConfirm: () => void }) {
  const [asking, setAsking] = useState(false);
  if (!asking)
    return (
      <button type="button" className="link-btn" onClick={() => setAsking(true)}>
        {label}
      </button>
    );
  return (
    <span className="confirm-inline" role="alert">
      {confirm}
      <button type="button" className="link-btn" onClick={() => setAsking(false)}>
        Cancel
      </button>
      <button
        type="button"
        className="link-btn danger"
        onClick={() => {
          onConfirm();
          setAsking(false);
        }}
      >
        {label}
      </button>
    </span>
  );
}
