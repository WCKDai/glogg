import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowUpRight,
  ChevronDown,
  Command,
  Compass,
  Download,
  History,
  Magnet,
  Moon,
  Search,
  Server,
  Settings,
  Sparkles,
  Sun,
  Wrench,
} from 'lucide-react';
import {
  BangDefinition,
  DEFAULT_BOOSTED_DOMAINS,
  DEFAULT_SLOP_DOMAINS,
  parseToolTrigger,
  resolveBang,
} from '../core/browser.js';
import type {
  DownloadManagerReport,
  DownloadTargetId,
  PluginDownloadTargetInfo,
  RankedSearchResponse,
  ResearchDepth,
  ResearchEvent,
  ScoredSearchResult,
  SearchLensId,
} from '../core/browser.js';
import { SearchBox } from './components/SearchBox.js';
import { SignIn } from './components/SignIn.js';
import { Shortcuts } from './components/Shortcuts.js';
import { AnswerCard, ReleaseList, ResultItem } from './components/Results.js';
import { ReaderSheet } from './components/ReaderSheet.js';
import { CommandPalette, PaletteCommand } from './components/CommandPalette.js';
import { AdvancedRail } from './components/AdvancedRail.js';
import { Favicon } from './components/Favicon.js';
import { StatusBar } from './components/StatusBar.js';
import { ResearchPanel } from './components/ResearchPanel.js';
import { ToolCard } from './components/ToolKit.js';
import type { InlineToolRun, ToolActionHandlers } from './components/ToolKit.js';
import { DownloadsView } from './views/DownloadsView.js';
import { ServicesView } from './views/ServicesView.js';
import { AtlasView } from './views/AtlasView.js';
import { DEFAULT_PREFS, SearchPrefs, SettingsView, STRICTNESS_THRESHOLD } from './views/SettingsView.js';
import { ToolsView } from './views/ToolsView.js';
import type { ToolsTarget } from './views/ToolsView.js';
import {
  api,
  DownloadTargetsContext,
  indexTools,
  inputsFromTrigger,
  isTypingTarget,
  LATE_REFRESH_MS,
  mergeLateResults,
  mergeTargets,
  reduceResearch,
  runTool,
  plural,
  SCOPES,
  sendToDownloads,
  SIGN_IN_EVENT,
  SOURCE_LABELS,
  streamEvents,
  streamSearch,
  SiteIconsContext,
  withDomainRule,
  targetLabel,
  useLocalStorage,
  useToasts,
} from './lib.js';
import type { DomainRule, Mode, PluginsResponse, ResearchState, ThemePref, View } from './lib.js';



const RELEASE_SCOPES: SearchLensId[] = ['p2p-magnet', 'usenet-nzb'];
/** Tools offered on the start screen, in this order, when installed. */
const QUICK_TRIGGERS = ['dns', 'whois', 'headers', 'tls', 'hash', 'rd', 'nzb', 'ip'];
const HISTORY_MAX = 8;
const NO_PLUGINS: PluginsResponse = { plugins: [], userDir: '' };

/** Every section has its own address, so Back, refresh, bookmarks and "open in new tab" work. */
const VIEW_PATHS: Record<View, string> = {
  search: '/',
  tools: '/tools',
  atlas: '/atlas',
  downloads: '/downloads',
  services: '/services',
  settings: '/settings',
};

const VIEW_TITLES: Record<View, string> = {
  search: 'glogg',
  tools: 'Tools — glogg',
  atlas: 'Atlas — glogg',
  downloads: 'Downloads — glogg',
  services: 'Services — glogg',
  settings: 'Settings — glogg',
};

function viewFromPath(pathname: string): View {
  const path = pathname.replace(/\/+$/, '') || '/';
  return (Object.keys(VIEW_PATHS) as View[]).find((v) => VIEW_PATHS[v] === path) ?? 'search';
}

/** What the address says; `scope` is null when it says none, so your default scope applies. */
function readUrlState(): { q: string; scope: SearchLensId | null; view: View } {
  const params = new URLSearchParams(window.location.search);
  const scope = params.get('scope') as SearchLensId | null;
  return {
    q: params.get('q') || '',
    scope: scope && SCOPES.some((s) => s.id === scope) ? scope : null,
    view: viewFromPath(window.location.pathname),
  };
}

/** True when no source answered at all (each failed, ran out of time or turned glogg away), as opposed to none matching. */
function allSourcesFailed(data: RankedSearchResponse): boolean {
  const asked = Object.values(data.metrics.sourceTimings || {}).filter((t) => t.status !== 'off' && t.status !== 'resting' && t.status !== 'unset');
  return asked.length > 0 && asked.every((t) => t.status === 'error' || t.status === 'late' || t.status === 'refused');
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

function pushUrl(url: string) {
  if (`${window.location.pathname}${window.location.search}` !== url) window.history.pushState({}, '', url);
}

interface SearchOpts {
  scope?: SearchLensId;
  push?: boolean;
  uncensored?: boolean;
  /** Re-run with these prefs (the rail changes them and searches at once). */
  prefs?: SearchPrefs;
  /** Same question, new filters: keep the research answer instead of paying for a new one. */
  keepResearch?: boolean;
  /** Earlier research turns when this search is a follow-up question. */
  history?: ResearchState[];
  /** The search came from the address (a reload, Back, or the browser's search box), not a click. */
  fromAddress?: boolean;
}

export function App() {
  // ── Persistent preferences ────────────────────────────────────────────
  const [themePref, setThemePref] = useLocalStorage<ThemePref>('glogg.theme', 'system');
  const [storedPrefs, setPrefs] = useLocalStorage<SearchPrefs>('glogg.prefs', DEFAULT_PREFS);
  // Settings added later start at their defaults.
  const prefs = useMemo(() => ({ ...DEFAULT_PREFS, ...storedPrefs }), [storedPrefs]);
  const [blocked, setBlocked] = useLocalStorage<string[]>('glogg.blocked', DEFAULT_SLOP_DOMAINS.slice(0, 35));
  const [boosted, setBoosted] = useLocalStorage<string[]>('glogg.boosted', DEFAULT_BOOSTED_DOMAINS.slice(0, 30));
  const [lowered, setLowered] = useLocalStorage<string[]>('glogg.lowered', []);
  const [pinned, setPinned] = useLocalStorage<string[]>('glogg.pinned', []);
  const [phrases, setPhrases] = useLocalStorage<string[]>('glogg.phrases', []);
  const domains = useMemo<Record<DomainRule, string[]>>(() => ({ pin: pinned, raise: boosted, lower: lowered, hide: blocked }), [pinned, boosted, lowered, blocked]);
  const setDomains = useCallback(
    (d: Record<DomainRule, string[]>) => {
      setPinned(d.pin);
      setBoosted(d.raise);
      setLowered(d.lower);
      setBlocked(d.hide);
    },
    [setPinned, setBoosted, setLowered, setBlocked]
  );
  const [customBangs, setCustomBangs] = useLocalStorage<BangDefinition[]>('glogg.bangs', []);
  const [uncensored, setUncensored] = useLocalStorage<boolean>('glogg.uncensored', false);
  const [mode, setMode] = useLocalStorage<Mode>('glogg.mode', 'simple');
  const [researchAuto, setResearchAuto] = useLocalStorage<boolean>('glogg.research.auto', true);
  const [researchDepth, setResearchDepth] = useLocalStorage<ResearchDepth>('glogg.research.depth', 'quick');
  const [history, setHistory] = useLocalStorage<string[]>('glogg.history', []);

  // ── Session state ─────────────────────────────────────────────────────
  const initial = useMemo(readUrlState, []);
  const [view, setView] = useState<View>(initial.view);
  const [input, setInput] = useState(initial.q);
  const [submitted, setSubmitted] = useState('');
  const [scope, setScope] = useState<SearchLensId>(initial.scope ?? prefs.defaultScope);
  const [data, setData] = useState<RankedSearchResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [active, setActive] = useState(0);
  const activeRef = useRef(0);
  activeRef.current = active;
  // An early batch is on screen and the full ranking is still coming.
  const [refining, setRefining] = useState(false);
  const [sourceFilter, setSourceFilter] = useState<string | null>(null);
  const [readerUrl, setReaderUrl] = useState<string | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  // A password-protected glogg asks for a sign-in on load, and again whenever a session runs out.
  const [signInNeeded, setSignInNeeded] = useState(false);
  useEffect(() => {
    const ask = () => setSignInNeeded(true);
    window.addEventListener(SIGN_IN_EVENT, ask);
    api<{ required: boolean; authenticated: boolean }>('/api/auth')
      .then((a) => setSignInNeeded(a.required && !a.authenticated))
      .catch(() => undefined);
    return () => window.removeEventListener(SIGN_IN_EVENT, ask);
  }, []);
  const [showFiltered, setShowFiltered] = useState(false);
  const [scrolled, setScrolled] = useState(false);
  const [activeDownloads, setActiveDownloads] = useState(0);
  const [systemDark, setSystemDark] = useState(() => window.matchMedia('(prefers-color-scheme: dark)').matches);
  const [plugins, setPlugins] = useState<PluginsResponse | null>(null);
  const [pluginTargets, setPluginTargets] = useState<PluginDownloadTargetInfo[]>([]);
  const [toolRun, setToolRun] = useState<InlineToolRun | null>(null);
  const [toolsTarget, setToolsTarget] = useState<ToolsTarget | null>(null);
  const [research, setResearch] = useState<ResearchState | null>(null);
  const [thread, setThread] = useState<ResearchState[]>([]);

  const { toasts, push: toast } = useToasts();
  const searchRef = useRef<HTMLInputElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const researchAbortRef = useRef<AbortController | null>(null);
  const toolAbortRef = useRef<AbortController | null>(null);
  const researchSeq = useRef(0);
  const pluginsReq = useRef<Promise<PluginsResponse> | null>(null);

  const tools = useMemo(() => indexTools(plugins?.plugins || []), [plugins]);
  const quickTools = useMemo(
    () => QUICK_TRIGGERS.map((tr) => tools.find((t) => t.tool.trigger === tr)).filter((t): t is NonNullable<typeof t> => Boolean(t)).slice(0, 6),
    [tools]
  );
  const targets = useMemo(() => mergeTargets(pluginTargets), [pluginTargets]);
  const aiPlugin = plugins?.plugins.find((p) => p.id === 'ai');
  const aiReady = Boolean(aiPlugin?.configured);
  const aiLabel = useMemo(() => {
    if (!aiPlugin?.configured) return null;
    const provider = aiPlugin.values?.provider || '';
    const option = aiPlugin.settings?.find((f) => f.key === 'provider')?.options?.find((o) => o.value === provider);
    return `${option?.label || provider}${aiPlugin.values?.model ? ` · ${aiPlugin.values.model}` : ''}`;
  }, [aiPlugin]);

  // Always-fresh snapshot for async handlers and key bindings.
  const live = useRef({ domains, prefs, blocked, boosted, lowered, pinned, phrases, uncensored, customBangs, scope, submitted, mode, researchAuto, researchDepth, targets, data, research, thread });
  live.current = { domains, prefs, blocked, boosted, lowered, pinned, phrases, uncensored, customBangs, scope, submitted, mode, researchAuto, researchDepth, targets, data, research, thread };

  // ── Theme ─────────────────────────────────────────────────────────────
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = (e: MediaQueryListEvent) => setSystemDark(e.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);
  const isDark = themePref === 'dark' || (themePref === 'system' && systemDark);
  useEffect(() => {
    document.documentElement.classList.toggle('dark', isDark);
    document.documentElement.dataset.accent = prefs.accent;
    document.documentElement.classList.toggle('light', !isDark);
    // The browser's own chrome matches the page, whichever theme you picked.
    document.querySelectorAll('meta[name="theme-color"]').forEach((m) => m.setAttribute('content', isDark ? '#0f0f10' : '#f6f6f4'));
  }, [isDark, prefs.accent]);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 4);
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  // ── Plugins ───────────────────────────────────────────────────────────
  const loadPluginList = useCallback(() => {
    const req = api<PluginsResponse>('/api/plugins').catch(() => NO_PLUGINS);
    pluginsReq.current = req;
    void req.then(setPlugins);
    return req;
  }, []);

  useEffect(() => {
    void loadPluginList();
  }, [loadPluginList]);

  // ── Downloads ─────────────────────────────────────────────────────────
  const refreshDownloadBadge = useCallback(() => {
    api<DownloadManagerReport>('/api/downloads')
      .then((r) => {
        setActiveDownloads(r.jobs.filter((j) => j.status === 'queued' || j.status === 'downloading').length);
        setPluginTargets(r.pluginTargets || []);
      })
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    refreshDownloadBadge();
    const t = setInterval(refreshDownloadBadge, 12_000);
    return () => clearInterval(t);
  }, [refreshDownloadBadge]);

  const reloadPlugins = useCallback(async () => {
    const req = api<PluginsResponse>('/api/plugins/reload', { method: 'POST' });
    pluginsReq.current = req.catch(() => NO_PLUGINS);
    setPlugins(await req);
    refreshDownloadBadge();
  }, [refreshDownloadBadge]);

  const send = useCallback(
    async (url: string, title: string, target: DownloadTargetId, sizeFormatted?: string) => {
      const label = targetLabel(target, live.current.targets);
      try {
        const { job } = await sendToDownloads({ url, title, target, sizeFormatted });
        const dest = targetLabel(job.target, live.current.targets);
        toast(job.status === 'failed' ? `${dest}: ${job.statusDetail}` : `Sent to ${dest}`, job.status === 'failed' ? 'error' : 'ok');
        refreshDownloadBadge();
      } catch (e) {
        toast(`${label}: ${e instanceof Error ? e.message : 'failed'}`, 'error');
      }
    },
    [toast, refreshDownloadBadge]
  );

  const sendItem = useCallback(
    (item: ScoredSearchResult, target: DownloadTargetId) => {
      const link = item.p2p?.magnetUri || item.p2p?.nzbUrl || item.p2p?.torrentUrl || item.url;
      void send(link, item.title, target, item.p2p?.sizeFormatted);
    },
    [send]
  );

  /** Go to a section, with its own address and title. */
  const navigate = useCallback((v: View) => {
    setView(v);
    pushUrl(VIEW_PATHS[v]);
    document.title = VIEW_TITLES[v];
  }, []);

  const openTools = useCallback(
    (target?: ToolsTarget) => {
      setToolsTarget(target ?? null);
      navigate('tools');
    },
    [navigate]
  );

  const toolHandlers = useMemo<ToolActionHandlers>(
    () => ({
      onSend: (url, title) => void send(url, title || url, 'auto'),
      onRunTool: (key, input) => {
        const [pluginId, toolId] = key.split('/');
        openTools({ pluginId, toolId, input, autorun: true });
      },
      onCopied: () => toast('Copied', 'ok'),
    }),
    [send, toast, openTools]
  );

  // ── Research ──────────────────────────────────────────────────────────
  const startResearch = useCallback(async (query: string, res: RankedSearchResponse, history: ResearchState[] = []) => {
    researchAbortRef.current?.abort();
    const ctrl = new AbortController();
    researchAbortRef.current = ctrl;
    const id = ++researchSeq.current;
    setResearch({ id, query, stage: 'reading', detail: 'Reading sources', sources: [], answer: '' });
    const apply = (e: ResearchEvent) => {
      if (!ctrl.signal.aborted) setResearch((s) => (s && s.id === id ? reduceResearch(s, e) : s));
    };
    const hidden = new Set(live.current.blocked);
    try {
      await streamEvents<ResearchEvent>(
        '/api/research',
        {
          query,
          candidates: res.results
            .filter((r) => !hidden.has(r.rootDomain))
            .slice(0, 16)
            .map((r) => ({ title: r.title, url: r.url, snippet: r.snippet, source: r.source })),
          instantAnswer: res.instantAnswer,
          depth: live.current.researchDepth,
          history: history.map((t) => ({ query: t.query, answer: t.answer })),
        },
        ctrl.signal,
        apply
      );
    } catch (e) {
      if (!ctrl.signal.aborted) apply({ type: 'error', message: e instanceof Error ? e.message : 'Research failed' });
    }
  }, []);

  const stopWork = useCallback(() => {
    abortRef.current?.abort();
    researchAbortRef.current?.abort();
    toolAbortRef.current?.abort();
  }, []);

  // ── Search ────────────────────────────────────────────────────────────
  const openUrl = useCallback((url: string) => {
    if (live.current.prefs.newTab) window.open(url, '_blank', 'noopener,noreferrer');
    else window.location.href = url;
  }, []);

  /** `>trigger rest`: run a plugin tool and show its output in place of results. */
  const runInlineTool = useCallback(
    async (q: string, trigger: { trigger: string; rest: string }, push = true) => {
      stopWork();
      const ctrl = new AbortController();
      toolAbortRef.current = ctrl;
      setView('search');
      setInput(q);
      setSubmitted(q);
      setLoading(false);
      setError(null);
      setData(null);
      setResearch(null);
      setThread([]);
      if (push) pushUrl(`/?q=${encodeURIComponent(q)}`);
      document.title = `${q} — glogg`;
      if (live.current.prefs.rememberHistory) setHistory((h) => [q, ...h.filter((x) => x !== q)].slice(0, HISTORY_MAX));

      const list = indexTools((await (pluginsReq.current ?? loadPluginList())).plugins);
      if (ctrl.signal.aborted) return;
      const ref = list.find((t) => t.tool.trigger === trigger.trigger);
      if (!ref) {
        setToolRun({ query: q, input: {}, loading: false, error: `No tool uses >${trigger.trigger}. Try one of these:` });
        return;
      }
      const toolInput = inputsFromTrigger(ref.tool, trigger.rest);
      setToolRun({ query: q, ref, input: toolInput, loading: true });
      try {
        const result = await runTool(ref.pluginId, ref.tool.id, toolInput, ctrl.signal);
        if (!ctrl.signal.aborted) setToolRun({ query: q, ref, input: toolInput, result, loading: false });
      } catch (e) {
        if (!ctrl.signal.aborted) setToolRun({ query: q, ref, input: toolInput, loading: false, error: e instanceof Error ? e.message : 'Tool failed' });
      }
    },
    [stopWork, loadPluginList, setHistory]
  );

  const runSearch = useCallback(
    async (raw: string, opts: SearchOpts = {}) => {
      const q = raw.trim();
      if (!q) return;
      const s = live.current;

      const trigger = parseToolTrigger(q);
      if (trigger) {
        void runInlineTool(q, trigger, opts.push !== false);
        return;
      }

      const bang = resolveBang(q, s.customBangs);
      if (bang) {
        // From the address bar (glogg as your browser's search engine) there was no click, so a new
        // tab would be blocked as a popup: go there in this tab instead, as a redirect would.
        if (opts.fromAddress) window.location.replace(bang.url);
        else openUrl(bang.url);
        return;
      }

      const nextScope = opts.scope ?? s.scope;
      const nextUncensored = opts.uncensored ?? s.uncensored;
      const p = opts.prefs ?? s.prefs;
      const researchNow = s.mode === 'advanced' && s.researchAuto && !opts.keepResearch;
      setView('search');
      setInput(q);
      setSubmitted(q);
      setScope(nextScope);
      setLoading(true);
      setError(null);
      setActive(0);
      setSourceFilter(null);
      setShowFiltered(false);
      setRevealed([]);
      setToolRun(null);
      toolAbortRef.current?.abort();
      if (!opts.keepResearch) {
        researchAbortRef.current?.abort();
        setThread(opts.history ?? []);
        setResearch(researchNow ? { id: -1, query: q, stage: 'searching', detail: 'Searching', sources: [], answer: '' } : null);
      }

      if (opts.push !== false) pushUrl(`/?q=${encodeURIComponent(q)}${nextScope !== 'all' ? `&scope=${nextScope}` : ''}`);
      document.title = `${q} — glogg`;
      if (!opts.keepResearch && s.prefs.rememberHistory) setHistory((h) => [q, ...h.filter((x) => x !== q)].slice(0, HISTORY_MAX));

      abortRef.current?.abort();
      const ctrl = new AbortController();
      abortRef.current = ctrl;
      const body = {
        query: q,
        compact: true,
        config: {
          lens: nextScope,
          maxPerDomain: p.maxPerDomain,
          slopThreshold: STRICTNESS_THRESHOLD[p.strictness] ?? 48,
          preLlmOnly: p.preLlmOnly,
          obscureWebOnly: p.obscureWebOnly,
          stripSponsored: p.stripSponsored,
          uncensoredMode: nextUncensored,
          blockedDomains: s.blocked,
          boostedDomains: s.boosted,
          loweredDomains: s.lowered,
          pinnedDomains: s.pinned,
          blockedPhrases: s.phrases,
          disabledSources: p.disabledSources,
        },
      };
      try {
        // Streamed: an early batch as soon as the main sources have enough, then the full ranking.
        const got: { final?: RankedSearchResponse; early?: boolean } = {};
        await streamSearch(body, ctrl.signal, (e) => {
          if (ctrl.signal.aborted) return;
          if (e.type === 'error') throw new Error(e.error);
          if (e.type === 'partial') {
            got.early = true;
            setData(e.response);
            setLoading(false);
            setRefining(true);
            if (!opts.keepResearch) window.scrollTo({ top: 0 });
            return;
          }
          got.final = e.response;
          // Re-rank only while nobody has started on the early batch; after that, new results join below.
          const untouched = activeRef.current === 0 && window.scrollY < 40;
          setData((cur) => {
            if (!got.early || untouched || !cur) return e.response;
            const merged = mergeLateResults(cur, e.response) ?? e.response;
            return { ...merged, partial: undefined };
          });
        });
        const res = got.final;
        if (ctrl.signal.aborted || !res) return;
        // Slow sources missed the cut but keep running server-side; pick them up shortly.
        if (Object.values(res.metrics.sourceTimings || {}).some((t) => t.status === 'late')) {
          setTimeout(() => {
            if (abortRef.current !== ctrl || ctrl.signal.aborted) return;
            api<RankedSearchResponse>('/api/search', { method: 'POST', signal: ctrl.signal, json: body })
              .then((more) => {
                if (abortRef.current === ctrl) setData((cur) => mergeLateResults(cur, more));
              })
              .catch(() => undefined);
          }, LATE_REFRESH_MS);
        }
        if (!opts.keepResearch && !got.early) window.scrollTo({ top: 0 });
        if (researchNow) void startResearch(q, res, opts.history ?? []);
      } catch (e) {
        if (ctrl.signal.aborted) return;
        // "Failed to fetch" is the browser's way of saying glogg itself couldn't be reached.
        const msg = e instanceof Error ? e.message : '';
        setError(/failed to fetch|networkerror|load failed/i.test(msg) ? "Couldn't reach glogg. Check your connection, then try again." : msg || 'Search failed');
        setData(null);
        if (researchNow) setResearch(null);
      } finally {
        if (!ctrl.signal.aborted) {
          setLoading(false);
          setRefining(false);
        }
      }
    },
    [openUrl, runInlineTool, startResearch, setHistory]
  );

  const goHome = useCallback(() => {
    stopWork();
    setView('search');
    setSubmitted('');
    setInput('');
    setData(null);
    setError(null);
    setLoading(false);
    setToolRun(null);
    setResearch(null);
    setThread([]);
    document.title = 'glogg';
    pushUrl('/');
    setTimeout(() => searchRef.current?.focus(), 0);
  }, [stopWork]);

  const prefill = useCallback((text: string) => {
    setView('search');
    setInput(text);
    setTimeout(() => searchRef.current?.focus(), 0);
  }, []);

  // Initial URL + back/forward
  useEffect(() => {
    if (initial.q) void runSearch(initial.q, { scope: initial.scope ?? live.current.prefs.defaultScope, push: false, fromAddress: true });
    else if (initial.view !== 'search') document.title = VIEW_TITLES[initial.view];
    const onPop = () => {
      const { q, scope: sc, view: v } = readUrlState();
      if (v !== 'search') {
        setView(v);
        document.title = VIEW_TITLES[v];
      } else if (q) void runSearch(q, { scope: sc ?? live.current.prefs.defaultScope, push: false, fromAddress: true });
      else {
        stopWork();
        setSubmitted('');
        setInput('');
        setData(null);
        setToolRun(null);
        setResearch(null);
        setView('search');
      }
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Derived results ───────────────────────────────────────────────────
  const isReleaseScope = RELEASE_SCOPES.includes(scope);
  const blockedSet = useMemo(() => new Set(blocked), [blocked]);

  // Hidden results you asked to see anyway join the end of the list.
  const [revealed, setRevealed] = useState<string[]>([]);
  const visible = useMemo<ScoredSearchResult[]>(() => {
    if (!data) return [];
    const shown = data.filteredSlop.filter((r) => revealed.includes(r.id));
    const base = [...data.results.filter((r) => !blockedSet.has(r.rootDomain)), ...shown];
    return sourceFilter ? base.filter((r) => r.source === sourceFilter) : base;
  }, [data, blockedSet, sourceFilter, revealed]);

  const releases = useMemo<ScoredSearchResult[]>(() => {
    if (!data) return [];
    const p2p = data.p2pResults.length ? data.p2pResults : data.results.filter((r) => r.p2p);
    return p2p.filter((r) => r.p2p && (!r.p2p.isAdultNsfw || uncensored));
  }, [data, uncensored]);

  const allSourceCounts = useMemo(() => {
    if (!data) return [] as [string, number][];
    const counts = new Map<string, number>();
    data.results.forEach((r) => !blockedSet.has(r.rootDomain) && counts.set(r.source, (counts.get(r.source) || 0) + 1));
    return [...counts.entries()].sort((a, b) => b[1] - a[1]);
  }, [data, blockedSet]);
  const sourceCounts = allSourceCounts.slice(0, 7);
  const unfilteredCount = allSourceCounts.reduce((n, [, c]) => n + c, 0);

  const navList = isReleaseScope ? releases : visible;
  const activeItem = navList[active];

  // Moving through results with the keyboard is spoken; hovering isn't.
  const movedByKey = useRef(false);
  const [announcement, setAnnouncement] = useState('');
  useEffect(() => {
    if (!movedByKey.current || !activeItem) return;
    movedByKey.current = false;
    setAnnouncement(`${active + 1} of ${navList.length}: ${activeItem.title}, ${activeItem.domain}`);
  }, [active, activeItem, navList.length]);

  /** From the reader: the previous or next readable result, without closing it. */
  const stepReader = useCallback(
    (delta: -1 | 1) => {
      for (let i = activeRef.current + delta; i >= 0 && i < navList.length; i += delta) {
        if (!navList[i].url.startsWith('magnet:')) {
          setActive(i);
          setReaderUrl(navList[i].url);
          return;
        }
      }
    },
    [navList]
  );

  useEffect(() => {
    if (!activeItem) return;
    document.querySelector(`[data-result-id="${CSS.escape(activeItem.id)}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [activeItem]);

  // ── Actions ───────────────────────────────────────────────────────────
  const ruleDomain = useCallback(
    (d: string, rule: DomainRule) => {
      setDomains(withDomainRule(live.current.domains, d, rule));
      const said: Record<DomainRule, string> = { pin: `Pinned ${d}: on top when it matches`, raise: `Raised ${d}`, lower: `Lowered ${d}`, hide: `Hidden ${d}` };
      toast(said[rule], 'ok');
    },
    [setDomains, toast]
  );

  /** 18+ mode turns on only in Settings, after a confirmation; turning it off works from anywhere. */
  const setAdultMode = useCallback(
    (next: boolean) => {
      if (next === live.current.uncensored) return;
      setUncensored(next);
      toast(next ? '18+ on: unfiltered, SafeSearch off' : '18+ off', 'info');
      if (live.current.submitted && !parseToolTrigger(live.current.submitted)) {
        void runSearch(live.current.submitted, { uncensored: next, push: false, keepResearch: true });
      }
    },
    [setUncensored, toast, runSearch]
  );

  const [settingsFocus, setSettingsFocus] = useState<string | null>(null);
  const openSettings = useCallback(
    (section: string | null = null) => {
      setSettingsFocus(section);
      navigate('settings');
    },
    [navigate]
  );

  const switchScope = useCallback(
    (id: SearchLensId) => {
      if (live.current.submitted && !parseToolTrigger(live.current.submitted)) void runSearch(live.current.submitted, { scope: id });
      else setScope(id);
    },
    [runSearch]
  );

  const applyPrefs = useCallback(
    (next: SearchPrefs) => {
      setPrefs(next);
      if (live.current.submitted) void runSearch(live.current.submitted, { prefs: next, push: false, keepResearch: true });
    },
    [setPrefs, runSearch]
  );

  const switchMode = useCallback(
    (next: Mode) => {
      setMode(next);
      const s = live.current;
      if (next === 'simple') {
        researchAbortRef.current?.abort();
        setResearch((r) => (r && r.stage !== 'done' && r.stage !== 'error' ? null : r));
      } else if (s.data && s.submitted && !s.research && s.researchAuto) {
        void startResearch(s.submitted, s.data);
      }
    },
    [setMode, startResearch]
  );

  const digDeeper = useCallback(() => {
    // Advanced view stays on, so say so: later searches come with a researched answer too.
    if (live.current.mode !== 'advanced') toast('Advanced view: searches now come with a researched answer. Press m to switch back.', 'info');
    setMode('advanced');
    const s = live.current;
    if (s.data && s.submitted && !s.research) void startResearch(s.submitted, s.data);
  }, [setMode, startResearch, toast]);

  const followUp = useCallback(
    (q: string) => {
      const s = live.current;
      const history = s.research && s.research.stage === 'done' ? [...s.thread, s.research] : s.thread;
      void runSearch(q, { history });
    },
    [runSearch]
  );

  const retryResearch = useCallback(() => {
    const s = live.current;
    if (s.data && s.submitted) void startResearch(s.submitted, s.data, s.thread);
  }, [startResearch]);

  const setupAi = useCallback(() => openTools({ pluginId: 'ai', toolId: 'test' }), [openTools]);
  const toggleTheme = useCallback(() => setThemePref(isDark ? 'light' : 'dark'), [isDark, setThemePref]);

  // ── Keyboard ──────────────────────────────────────────────────────────
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPaletteOpen((o) => !o);
        return;
      }
      if (paletteOpen || shortcutsOpen || readerUrl || e.metaKey || e.ctrlKey || e.altKey) return;
      if (isTypingTarget(e.target)) return;
      // Character keys only when you want them (WCAG 2.1.4); arrows and Enter always work.
      if (e.key.length === 1 && !live.current.prefs.singleKeys) return;

      if (e.key === '?') {
        e.preventDefault();
        setShortcutsOpen(true);
        return;
      }
      if (e.key === '/') {
        e.preventDefault();
        searchRef.current?.focus();
        searchRef.current?.select();
        return;
      }
      if (e.key === 'm') {
        switchMode(live.current.mode === 'advanced' ? 'simple' : 'advanced');
        return;
      }
      if (view !== 'search' || navList.length === 0 || toolRun) return;

      if (e.key === 'j' || e.key === 'ArrowDown') {
        e.preventDefault();
        movedByKey.current = true;
        setActive((i) => Math.min(i + 1, navList.length - 1));
      } else if (e.key === 'k' || e.key === 'ArrowUp') {
        e.preventDefault();
        movedByKey.current = true;
        setActive((i) => Math.max(i - 1, 0));
      } else if (e.key === 'Enter' || e.key === 'o') {
        if (e.key === 'Enter' && e.target instanceof HTMLElement && e.target.closest('button, a')) return;
        if (activeItem) openUrl(activeItem.p2p?.magnetUri && isReleaseScope ? activeItem.p2p.magnetUri : activeItem.url);
      } else if (e.key === 'r') {
        if (activeItem && !activeItem.url.startsWith('magnet:')) setReaderUrl(activeItem.url);
      } else if (e.key === 'd') {
        if (activeItem) sendItem(activeItem, 'auto');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [paletteOpen, shortcutsOpen, readerUrl, view, navList, activeItem, isReleaseScope, openUrl, sendItem, switchMode, toolRun]);

  // ── Command palette ───────────────────────────────────────────────────
  const commands = useMemo<PaletteCommand[]>(() => {
    const c: PaletteCommand[] = [
      { id: 'v-home', label: 'New search', group: 'Go to', hint: 'home', run: goHome },
      { id: 'v-tools', label: 'Tools', group: 'Go to', keywords: 'plugins debrid osint whois dns cloud usenet test', run: () => openTools() },
      { id: 'v-dl', label: 'Downloads', group: 'Go to', keywords: 'aria2 offcloud nextcloud queue', run: () => navigate('downloads') },
      { id: 'v-atlas', label: 'Atlas: blogs, boards, forums and hand-picked sites', group: 'Go to', keywords: 'indie small web directory deep index chan imageboard forum surprise', run: () => navigate('atlas') },
      { id: 'v-svc', label: 'Services — self-hosted containers', group: 'Go to', keywords: 'docker podman searxng bitmagnet ipfs', run: () => navigate('services') },
      { id: 'v-set', label: 'Settings', group: 'Go to', keywords: 'keys api integrations bangs domains', run: () => openSettings() },
      {
        id: 'm-mode',
        label: mode === 'advanced' ? 'Simple view' : 'Advanced view: research answers, filters, signals',
        group: 'View',
        hint: 'm',
        keywords: 'mode deep research perplexity ai answer',
        run: () => switchMode(mode === 'advanced' ? 'simple' : 'advanced'),
      },
      {
        id: 'm-depth',
        label: researchDepth === 'deep' ? 'Quick research (reads 5 pages)' : 'Deep research (reads 8 pages)',
        group: 'View',
        run: () => setResearchDepth(researchDepth === 'deep' ? 'quick' : 'deep'),
      },
      { id: 'm-ai', label: aiReady ? `Research model: ${aiLabel}` : 'Set up a research model (AI)', group: 'View', keywords: 'byok ollama openai anthropic key', run: setupAi },
    ];
    SCOPES.forEach((s) =>
      c.push({
        id: `s-${s.id}`,
        label: submitted ? `${s.label}: “${submitted}”` : `Scope: ${s.label}`,
        group: 'Scope',
        hint: s.hint,
        keywords: s.id,
        run: () => switchScope(s.id),
      })
    );
    c.push(
      uncensored
        ? { id: 't-18', label: 'Turn 18+ off', group: 'Toggle', keywords: 'nsfw uncensored safesearch adult', run: () => setAdultMode(false) }
        : { id: 't-18', label: '18+ mode (in Settings)', group: 'Go to', keywords: 'nsfw uncensored safesearch adult', run: () => openSettings('adult') },
      { id: 'h-keys', label: 'Keyboard shortcuts', group: 'Help', keywords: 'keys hotkeys help ?', run: () => setShortcutsOpen(true) },
      { id: 't-theme', label: isDark ? 'Light theme' : 'Dark theme', group: 'Toggle', run: toggleTheme },
      { id: 't-sys', label: 'Follow system theme', group: 'Toggle', run: () => setThemePref('system') },
      {
        id: 't-sponsored',
        label: prefs.stripSponsored ? 'Show sponsored results inline' : 'Hide sponsored results',
        group: 'Toggle',
        run: () => applyPrefs({ ...prefs, stripSponsored: !prefs.stripSponsored }),
      },
      {
        id: 't-indie',
        label: prefs.obscureWebOnly ? 'Allow big platforms' : 'Independent sites only',
        group: 'Toggle',
        run: () => applyPrefs({ ...prefs, obscureWebOnly: !prefs.obscureWebOnly }),
      },
      {
        id: 't-prellm',
        label: prefs.preLlmOnly ? 'Any date' : 'Before ChatGPT only (pre Nov 2022)',
        group: 'Toggle',
        run: () => applyPrefs({ ...prefs, preLlmOnly: !prefs.preLlmOnly }),
      }
    );
    tools.forEach((t) =>
      c.push({
        id: `tool-${t.key}`,
        label: t.tool.name,
        group: `Tools · ${t.pluginName}`,
        hint: t.tool.trigger ? `>${t.tool.trigger}` : undefined,
        keywords: `${t.pluginName} ${t.category} ${t.tool.description}`,
        run: () =>
          t.tool.trigger && t.tool.inputs.length > 0 ? prefill(`>${t.tool.trigger} `) : openTools({ pluginId: t.pluginId, toolId: t.tool.id }),
      })
    );
    if (activeItem) {
      c.push(
        { id: 'a-read', label: `Read “${activeItem.title.slice(0, 48)}”`, group: 'Selected result', hint: 'r', run: () => setReaderUrl(activeItem.url) },
        { id: 'a-send', label: 'Send selected to downloads', group: 'Selected result', hint: 'd', run: () => sendItem(activeItem, 'auto') },
        { id: 'a-pin', label: `Pin ${activeItem.rootDomain} on top`, group: 'Selected result', run: () => ruleDomain(activeItem.rootDomain, 'pin') },
        { id: 'a-lower', label: `Lower ${activeItem.rootDomain}`, group: 'Selected result', run: () => ruleDomain(activeItem.rootDomain, 'lower') },
        { id: 'a-hide', label: `Hide ${activeItem.rootDomain}`, group: 'Selected result', run: () => ruleDomain(activeItem.rootDomain, 'hide') }
      );
    }
    data?.compiledQuery.escapeUrls.slice(0, 8).forEach((e) =>
      c.push({ id: `e-${e.id}`, label: `Search on ${e.name}`, group: 'Elsewhere', hint: e.description, run: () => openUrl(e.url) })
    );
    return c;
  }, [goHome, openTools, mode, switchMode, researchDepth, setResearchDepth, aiReady, aiLabel, setupAi, submitted, uncensored, isDark, prefs, tools, activeItem, data, switchScope, setAdultMode, openSettings, toggleTheme, setThemePref, applyPrefs, prefill, sendItem, ruleDomain, openUrl]);

  // ── Render ────────────────────────────────────────────────────────────
  const isHome = view === 'search' && !submitted;
  const advanced = mode === 'advanced';
  const searchBoxProps = {
    value: input,
    onChange: setInput,
    onSubmit: (q: string) => void runSearch(q),
    customBangs,
    uncensored,
    tools,
  };

  const resultsBody = loading ? (
    <ResultsSkeleton />
  ) : error ? (
    <div className="search-problem" role="alert">
      <p>{error}</p>
      <button type="button" className="btn btn-sm" onClick={() => void runSearch(submitted, { push: false })}>
        Try again
      </button>
    </div>
  ) : data ? (
    <>
      <div className="status-line">
        {!advanced && !isReleaseScope && sourceCounts.length > 1 ? (
          <div className="chips">
            <button type="button" className={`chip ${!sourceFilter ? 'active' : ''}`} onClick={() => setSourceFilter(null)}>
              All
            </button>
            {sourceCounts.map(([src, n]) => (
              <button
                key={src}
                type="button"
                className={`chip ${sourceFilter === src ? 'active' : ''}`}
                onClick={() => {
                  setSourceFilter(sourceFilter === src ? null : src);
                  setActive(0);
                }}
              >
                {SOURCE_LABELS[src] || src} <span className="count">{n}</span>
              </button>
            ))}
          </div>
        ) : (
          <span />
        )}
        <span className="status-count">
          {navList.length} result{navList.length === 1 ? '' : 's'} · {(data.metrics.durationMs / 1000).toFixed(1)}s
        </span>
        {!advanced && !isReleaseScope && (
          <button type="button" className="link-btn dig" onClick={digDeeper} title="Advanced view: read the sources and write a cited answer">
            <Sparkles size={12} /> Dig deeper
          </button>
        )}
      </div>

      {!isReleaseScope && !sourceFilter && data.instantAnswer && !(advanced && research) && (
        <AnswerCard answer={data.instantAnswer} onRead={setReaderUrl} />
      )}

      {isReleaseScope ? (
        <ReleaseList items={releases} onSend={sendItem} />
      ) : visible.length === 0 ? (
        allSourcesFailed(data) ? (
          <div className="search-problem" role="alert">
            <p>None of the sources answered. They may be down, or this machine may be offline.</p>
            <button type="button" className="btn btn-sm" onClick={() => void runSearch(submitted, { push: false })}>
              Try again
            </button>
          </div>
        ) : (
          <p className="empty">
            No results for “{submitted}”{data.filteredSlop.length > 0 ? `; ${plural(data.metrics.filteredSlopCount || data.filteredSlop.length, 'result')} hidden below` : ''}. Try fewer words, another scope, or one of the engines below.
          </p>
        )
      ) : (
        <div className={`results${prefs.density === 'compact' ? ' compact' : ''}`} role="list" aria-label={`${plural(visible.length, 'result')}`}>
          {visible.map((item, i) => (
            <React.Fragment key={item.id}>
              {i === 3 && !sourceFilter && releases.length > 0 && (
                <div role="listitem">
                <button type="button" className="banner" onClick={() => switchScope(scope === 'usenet-nzb' ? 'usenet-nzb' : 'p2p-magnet')}>
                  <Magnet size={15} />
                  <span>
                    <strong>{releases.length}</strong> {releases.length === 1 ? 'torrent or NZB matches' : 'torrents & NZBs match'} this
                  </span>
                  <span className="go">View →</span>
                </button>
                </div>
              )}
              <ResultItem
                item={item}
                index={i}
                active={i === active}
                detailed={advanced}
                onHover={() => setActive(i)}
                onRead={setReaderUrl}
                onSend={sendItem}
                onRule={ruleDomain}
                newTab={prefs.newTab}
              />
            </React.Fragment>
          ))}
        </div>
      )}

      {data.filteredSlop.length > 0 && (
        <>
          <button type="button" className="more-toggle" onClick={() => setShowFiltered((s) => !s)} aria-expanded={showFiltered}>
            <ChevronDown size={14} style={{ transform: showFiltered ? 'rotate(180deg)' : undefined, transition: 'transform .15s' }} />
            {(data.metrics.filteredSlopCount || data.filteredSlop.length).toLocaleString()} hidden
            {data.metrics.sponsoredRemovedCount > 0 && <> · {data.metrics.sponsoredRemovedCount} sponsored</>}
            {data.metrics.demotedDuplicateDomainsCount > 0 && <> · {plural(data.metrics.demotedDuplicateDomainsCount, 'repeat')}</>}
          </button>
          {showFiltered && (
            <div className="filtered-list">
              {data.filteredSlop
                .filter((r) => !revealed.includes(r.id))
                .slice(0, 40)
                .map((r) => (
                  <div key={r.id} className="filtered-row">
                    <a href={r.url} target={prefs.newTab ? '_blank' : undefined} rel="noreferrer" className="truncate">
                      {r.title}
                    </a>
                    <span className="why">{r.demotedReason || (r.isSponsored ? 'Sponsored or affiliate' : r.verdict.replace(/-/g, ' '))}</span>
                    <button type="button" className="link-btn" onClick={() => setRevealed((v) => [...v, r.id])} aria-label={`Show ${r.title} anyway`}>
                      Show
                    </button>
                  </div>
                ))}
            </div>
          )}
        </>
      )}

      {data.compiledQuery.escapeUrls.length > 0 && (
        <section className="escape" aria-label="Search elsewhere">
          <div className="escape-title">Not it? Try “{submitted}” on</div>
          <div className="chips">
            {data.compiledQuery.escapeUrls.slice(0, 12).map((e) => (
              <a key={e.id} className="chip" href={e.url} target="_blank" rel="noreferrer" title={e.description}>
                <Favicon domain={hostOf(e.url)} size={12} />
                {e.name}
                <ArrowUpRight size={11} />
              </a>
            ))}
          </div>
        </section>
      )}
    </>
  ) : null;

  return (
    <DownloadTargetsContext.Provider value={targets}>
    <SiteIconsContext.Provider value={prefs.siteIcons}>
      <div className="shell">
        <a className="skip-link" href="#main">
          Skip to content
        </a>
        <nav className="appnav" aria-label="Sections">
          <button type="button" className="appnav-logo" onClick={goHome} aria-label="glogg home" title="glogg">
            <img src="/logo.png" alt="" width={28} height={28} />
          </button>
          <NavButton label="Search" aria="Search home" href="/" icon={<Search size={18} />} active={view === 'search'} onClick={goHome} />
          <NavButton label="Tools" href={VIEW_PATHS.tools} icon={<Wrench size={18} />} active={view === 'tools'} onClick={() => openTools()} />
          <NavButton label="Atlas" href={VIEW_PATHS.atlas} icon={<Compass size={18} />} active={view === 'atlas'} onClick={() => navigate('atlas')} />
          <NavButton
            label="Downloads"
            href={VIEW_PATHS.downloads}
            icon={<Download size={18} />}
            active={view === 'downloads'}
            onClick={() => navigate('downloads')}
            badge={activeDownloads}
          />
          <NavButton label="Services" href={VIEW_PATHS.services} icon={<Server size={18} />} active={view === 'services'} onClick={() => navigate('services')} />
          <div className="appnav-fill" />
          {uncensored && (
            <button type="button" className="adult-pill" onClick={() => setAdultMode(false)} title="18+ mode is on. Click to turn it off." aria-label="Turn 18+ off">
              18+
            </button>
          )}
          <NavButton label="Settings" href={VIEW_PATHS.settings} icon={<Settings size={18} />} active={view === 'settings'} onClick={() => openSettings()} />
        </nav>

        <header className={`topbar ${scrolled ? 'scrolled' : ''}`}>
          <div className="topbar-search">{!isHome && <SearchBox ref={searchRef} {...searchBoxProps} busy={loading || Boolean(toolRun?.loading)} />}</div>
          {/* Visible on every screen, phones included (they have no status bar). */}
          {view === 'search' && (loading || refining) && (
            <div className="search-progress" role="progressbar" aria-label={loading ? 'Searching' : 'Waiting for slower sources'} aria-valuetext={loading ? 'Searching' : 'More results coming'} />
          )}
          <div className="topbar-tools">
            <button type="button" className="kbd-btn" onClick={() => setPaletteOpen(true)} aria-label="Command palette" title="Command palette">
              <Command size={12} />
              <span className="kbd-btn-k">K</span>
            </button>
            <button type="button" className="icon-btn ghost" onClick={toggleTheme} title={isDark ? 'Light theme' : 'Dark theme'} aria-label="Toggle theme">
              {isDark ? <Sun size={16} /> : <Moon size={16} />}
            </button>
          </div>
        </header>

        <main className="main" id="main" tabIndex={-1}>
          <div className="sr-only" aria-live="polite">
            {announcement}
          </div>
          {isHome && (
            <section className="home">
              <div className="home-head">
                <h1 className="home-tagline">
                  <span className="home-name">glogg</span>
                  {advanced ? 'Ask anything. Cited answers from the real web.' : 'The whole web, minus the junk.'}
                </h1>
                <div className="segmented home-mode" role="radiogroup" aria-label="View">
                  {(['simple', 'advanced'] as const).map((m) => (
                    <button
                      key={m}
                      type="button"
                      role="radio"
                      aria-checked={mode === m}
                      className={mode === m ? 'active' : ''}
                      onClick={() => switchMode(m)}
                      title={m === 'advanced' ? 'Cited answers, filters and ranking signals' : 'Just answers and sites'}
                    >
                      {m === 'simple' ? 'Simple' : 'Advanced'}
                    </button>
                  ))}
                </div>
              </div>
              <div className="home-search">
                <SearchBox ref={searchRef} {...searchBoxProps} size="hero" autoFocus />
              </div>
              <div className="scopes home-scopes" role="radiogroup" aria-label="Scope">
                {SCOPES.map((s) => (
                  <button
                    key={s.id}
                    type="button"
                    role="radio"
                    aria-checked={scope === s.id}
                    className={`scope ${scope === s.id ? 'active' : ''}`}
                    onClick={() => setScope(s.id)}
                    title={s.hint}
                  >
                    {s.label}
                  </button>
                ))}
              </div>
              <div className="home-panels">
                <section className="home-panel" aria-label="Recent searches">
                  <div className="home-panel-head">
                    <span>Recent</span>
                    {history.length > 0 && (
                      <button type="button" onClick={() => setHistory([])}>
                        Clear
                      </button>
                    )}
                  </div>
                  {history.length === 0 ? (
                    <p className="home-empty">Your searches and tool runs show up here.</p>
                  ) : (
                    history.slice(0, 6).map((h) => (
                      <button key={h} type="button" className="home-item" onClick={() => void runSearch(h)} title={h}>
                        {h.startsWith('>') ? <Wrench size={13} /> : <History size={13} />}
                        <span className="truncate">{h}</span>
                      </button>
                    ))
                  )}
                </section>
                <section className="home-panel" aria-label="Tools">
                  <div className="home-panel-head">
                    <span>Tools</span>
                    <button type="button" onClick={() => openTools()}>
                      All {tools.length || ''}
                    </button>
                  </div>
                  {quickTools.length === 0 ? (
                    <p className="home-empty">Loading tools…</p>
                  ) : (
                    quickTools.map((t) => (
                      <button key={t.key} type="button" className="home-item" onClick={() => prefill(`>${t.tool.trigger} `)} title={t.tool.description}>
                        <span className="mono">&gt;{t.tool.trigger}</span>
                        <span className="truncate">{t.tool.name}</span>
                        <span className="home-item-meta">{t.pluginName}</span>
                      </button>
                    ))
                  )}
                </section>
              </div>
              {/* Each hint does what it says, for a tap as well as the key. */}
              <div className="home-hint">
                <button type="button" onClick={() => prefill('!')}>
                  <kbd>!</kbd> other engines
                </button>
                <button type="button" onClick={() => prefill('>')}>
                  <kbd>&gt;</kbd> tools
                </button>
                <button type="button" onClick={() => setPaletteOpen(true)}>
                  <kbd>⌘</kbd>
                  <kbd>K</kbd> commands
                </button>
                <button type="button" onClick={() => switchMode(advanced ? 'simple' : 'advanced')}>
                  <kbd>m</kbd> {advanced ? 'simple' : 'advanced'} view
                </button>
                <button type="button" onClick={() => setShortcutsOpen(true)}>
                  <kbd>?</kbd> all shortcuts
                </button>
              </div>
            </section>
          )}

          {view === 'search' && submitted && toolRun && (
            <div className="results-wrap">
              <ToolCard
                run={toolRun}
                handlers={toolHandlers}
                onOpenInTools={() =>
                  toolRun.ref &&
                  openTools({ pluginId: toolRun.ref.pluginId, toolId: toolRun.ref.tool.id, input: toolRun.input, result: toolRun.result })
                }
                suggestions={toolRun.ref ? [] : tools.filter((t) => t.tool.trigger)}
                onPick={(t) => prefill(`>${t.tool.trigger} `)}
              />
            </div>
          )}

          {view === 'search' && submitted && !toolRun && !advanced && (
            <div className="results-wrap">
              <h1 className="sr-only">Results for “{submitted}”</h1>
              <nav className="scopes" aria-label="Scopes">
                {SCOPES.map((s) => (
                  <button
                    key={s.id}
                    type="button"
                    aria-pressed={scope === s.id}
                    className={`scope ${scope === s.id ? 'active' : ''}`}
                    onClick={() => switchScope(s.id)}
                    title={s.hint}
                  >
                    {s.label}
                  </button>
                ))}
              </nav>
              <p className="scope-hint">{SCOPES.find((s) => s.id === scope)?.hint}</p>
              {resultsBody}
            </div>
          )}

          {view === 'search' && submitted && !toolRun && advanced && (
            <div className="adv">
              <AdvancedRail
                scope={scope}
                onScope={switchScope}
                sources={isReleaseScope ? [] : allSourceCounts}
                total={unfilteredCount}
                sourceFilter={sourceFilter}
                onSourceFilter={(src) => {
                  setSourceFilter(src);
                  setActive(0);
                }}
                prefs={prefs}
                onPrefs={applyPrefs}
                researchAuto={researchAuto}
                onResearchAuto={setResearchAuto}
                researchDepth={researchDepth}
                onResearchDepth={setResearchDepth}
                aiLabel={aiLabel}
                onSetupAi={setupAi}
                onOpenTools={() => openTools()}
                onSimple={() => switchMode('simple')}
              />
              <div className="adv-main">
                {research ? (
                  <ResearchPanel thread={thread} current={research} aiReady={aiReady} onFollowUp={followUp} onRetry={retryResearch} onSetupAi={setupAi} />
                ) : (
                  data &&
                  !loading &&
                  !isReleaseScope && (
                    <button type="button" className="research-start" onClick={() => void startResearch(submitted, data, thread)}>
                      <Sparkles size={14} /> Research “{submitted}”
                    </button>
                  )
                )}
                {resultsBody}
              </div>
            </div>
          )}

          {view === 'tools' && (
            <ToolsView
              plugins={plugins?.plugins ?? null}
              userDir={plugins?.userDir ?? ''}
              target={toolsTarget}
              onReload={reloadPlugins}
              onChanged={() => {
                void loadPluginList();
                refreshDownloadBadge();
              }}
              onToast={toast}
              handlers={toolHandlers}
              onOpenSettings={() => openSettings()}
            />
          )}
          {view === 'downloads' && <DownloadsView onToast={toast} onOpenSettings={() => openSettings()} />}
          {view === 'atlas' && <AtlasView onRead={setReaderUrl} uncensored={uncensored} onToast={toast} />}
          {view === 'services' && <ServicesView onToast={toast} />}
          {view === 'settings' && (
            <SettingsView
              prefs={prefs}
              setPrefs={setPrefs}
              domains={domains}
              setDomains={setDomains}
              phrases={phrases}
              setPhrases={setPhrases}
              customBangs={customBangs}
              setCustomBangs={setCustomBangs}
              theme={themePref}
              setTheme={setThemePref}
              historyCount={history.length}
              clearHistory={() => setHistory([])}
              adultMode={uncensored}
              setAdultMode={setAdultMode}
              focus={settingsFocus}
              onToast={toast}
              onShowShortcuts={() => setShortcutsOpen(true)}
            />
          )}
        </main>

        <StatusBar
          data={view === 'search' && submitted && !toolRun ? data : null}
          loading={view === 'search' && (loading || refining)}
          busyLabel={toolRun?.loading ? `Running ${toolRun.ref?.tool.name ?? 'tool'}…` : undefined}
          research={view === 'search' ? research : null}
          mode={mode}
          toolCount={tools.length}
          onToggleMode={() => switchMode(mode === 'advanced' ? 'simple' : 'advanced')}
          onOpenPalette={() => setPaletteOpen(true)}
        />

        {shortcutsOpen && <Shortcuts onClose={() => setShortcutsOpen(false)} />}

        {signInNeeded && <SignIn onDone={() => window.location.reload()} />}

        {readerUrl && (
          <ReaderSheet
            url={readerUrl}
            onClose={() => setReaderUrl(null)}
            onNavigate={setReaderUrl}
            onSend={(url, title, target) => void send(url, title, target)}
            onStep={view === 'search' && navList.length > 1 ? stepReader : undefined}
          />
        )}

        {paletteOpen && (
          <CommandPalette
            commands={commands}
            customBangs={customBangs}
            onSearch={(q) => void runSearch(q)}
            onClose={() => setPaletteOpen(false)}
          />
        )}

        <div className="toasts" aria-live="polite">
          {toasts.map((t) => (
            <div key={t.id} className={`toast ${t.tone || ''}`}>
              {t.text}
            </div>
          ))}
        </div>
      </div>
    </SiteIconsContext.Provider>
    </DownloadTargetsContext.Provider>
  );
}

function ResultsSkeleton() {
  return (
    <div aria-busy="true" aria-label="Loading results" style={{ paddingTop: 16 }}>
      {[0, 1, 2, 3, 4].map((i) => (
        <div key={i} className="skeleton-result" style={{ opacity: 1 - i * 0.16 }}>
          <div className="skeleton w-40" />
          <div className="skeleton h-14 w-70" />
          <div className="skeleton w-95" />
          <div className="skeleton w-80" />
        </div>
      ))}
    </div>
  );
}

/**
 * A section in the left nav: icon and label, so nothing has to be guessed from a glyph.
 * A real link, so ⌘/Ctrl-click and middle-click open the section in a new tab.
 */
function NavButton({
  label,
  aria,
  href,
  icon,
  active,
  onClick,
  badge = 0,
}: {
  label: string;
  /** Accessible name when it should say more than the label. */
  aria?: string;
  href: string;
  icon: React.ReactNode;
  active: boolean;
  onClick: () => void;
  badge?: number;
}) {
  return (
    <a
      href={href}
      className={`appnav-btn ${active ? 'active' : ''}`}
      onClick={(e) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
        e.preventDefault();
        onClick();
      }}
      aria-label={aria ?? label}
      aria-current={active ? 'page' : undefined}
      title={label}
    >
      {icon}
      <span className="appnav-label">{label}</span>
      {badge > 0 && <span className="badge">{badge}</span>}
    </a>
  );
}
