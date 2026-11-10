import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  isSearchLens,
  cleanAndAutopsyHtml,
  CURATED_INDIE_INDEX,
  CustomEndpointsConfig,
  DownloadTargetId,
  ResearchRequest,
  SearchFilterConfig,
} from '../src/core/index.js';
import { resolveAiConfig } from './ai.js';
import { configuredPassword, createAuth, sessionSecret, trustProxySetting } from './auth.js';
import {
  getContainerStackStatus,
  runContainerOrchestrationAction,
} from './containerManager.js';
import {
  clearFinishedDownloads,
  enqueueDownload,
  getDownloadManagerReport,
  loadIntegrationConfig,
  maskConfig,
  removeDownload,
  saveIntegrationConfig,
} from './downloadManager.js';
import { executeFederatedSearch } from './federatedSearch.js';
import {
  addUserSource,
  deepStatus,
  ensureSeeded,
  getDeepStore,
  pauseCrawl,
  randomDeep,
  resumeDeepCrawl,
  startCrawl,
} from './deep/index.js';
import type { DeepKind } from './deep/parse.js';
import {
  getPluginSettings,
  listPlugins,
  loadPlugins,
  maskPluginSettings,
  pluginContainerAction,
  pluginContainerStatus,
  runPluginTool,
  savePluginSettings,
  USER_PLUGIN_DIR,
} from './plugins/runtime.js';
import { configureNetwork } from './net.js';
import { publicFetch, readTextCapped } from './publicFetch.js';
import { runResearch } from './research.js';
import { apiGuard, contentSecurityPolicy, securityHeaders } from './security.js';
import { isIconDomain, siteIcon } from './favicons.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Search config fields that must be lists of strings, numbers or switches when a request sends them. */
const LIST_FIELDS = ['blockedDomains', 'boostedDomains', 'blockedPhrases'] as const;
const NUMBER_FIELDS = ['maxPerDomain', 'slopThreshold'] as const;
const SWITCH_FIELDS = ['preLlmOnly', 'obscureWebOnly', 'stripSponsored', 'uncensoredMode'] as const;

/**
 * A request's search config, checked: a field of the wrong type is an error
 * (it used to surface as a 500), an unknown lens is dropped, and anything
 * else passes through as before.
 */
export function checkSearchConfig(input: unknown): { config: Partial<SearchFilterConfig> } | { error: string } {
  if (input === undefined || input === null) return { config: {} };
  if (typeof input !== 'object' || Array.isArray(input)) return { error: 'config must be an object' };
  const c = { ...(input as Record<string, unknown>) };
  for (const k of LIST_FIELDS) {
    if (c[k] !== undefined && !(Array.isArray(c[k]) && (c[k] as unknown[]).every((x) => typeof x === 'string'))) return { error: `config.${k} must be a list of strings` };
  }
  for (const k of NUMBER_FIELDS) {
    if (c[k] !== undefined && !(typeof c[k] === 'number' && Number.isFinite(c[k]))) return { error: `config.${k} must be a number` };
  }
  for (const k of SWITCH_FIELDS) {
    if (c[k] !== undefined && typeof c[k] !== 'boolean') return { error: `config.${k} must be true or false` };
  }
  if (c.endpoints !== undefined && (typeof c.endpoints !== 'object' || c.endpoints === null || Array.isArray(c.endpoints))) return { error: 'config.endpoints must be an object' };
  if (!isSearchLens(c.lens)) delete c.lens;
  return { config: c as Partial<SearchFilterConfig> };
}

/** Which stored secrets belong to which service address. */
const SECRET_OWNERS: [keyof CustomEndpointsConfig, (keyof CustomEndpointsConfig)[]][] = [
  ['torznabUrl', ['torznabApiKey']],
  ['newznabUrl', ['newznabApiKey']],
  ['nzbLifeUrl', ['nzbLifeApiKey']],
  ['nextcloudUrl', ['nextcloudUser', 'nextcloudAppPassword']],
  ['aria2RpcUrl', ['aria2RpcSecret']],
];
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 GloggReader/0.3';

async function checkNodeReachable(url: string, timeoutMs = 1000): Promise<boolean> {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: c.signal });
    return r.status < 500;
  } catch {
    return false;
  } finally {
    clearTimeout(t);
  }
}

export async function createGloggServer() {
  const app = express();
  // Only the exact lower-case "/api/…" routes exist. Express would otherwise also route "/API/…",
  // which the guard's prefix check never sees.
  app.set('case sensitive routing', true);
  app.set('trust proxy', trustProxySetting(process.env.GLOGG_TRUST_PROXY));
  app.disable('x-powered-by');
  const isProd = process.env.NODE_ENV === 'production';
  const distPath = path.resolve(__dirname, '../dist');
  // The built page gets a policy matching its scripts; Vite's dev server injects its own, so it gets none.
  let csp: string | undefined;
  try {
    if (isProd) csp = contentSecurityPolicy(fs.readFileSync(path.join(distPath, 'index.html'), 'utf8'));
  } catch {
    csp = contentSecurityPolicy('');
  }
  app.use(securityHeaders(csp));
  app.use(express.json({ limit: '5mb' }));
  // A password, when set, comes first: without a session nothing else answers, not even the public routes.
  const password = configuredPassword();
  const home = process.env.GLOGG_HOME || path.join(os.homedir(), '.glogg');
  const auth = createAuth({
    password,
    secret: password ? sessionSecret(home) : Buffer.alloc(32),
    revokedFile: password ? path.join(home, 'revoked-sessions.json') : undefined,
  });
  app.use(auth.middleware);
  app.use(apiGuard);
  auth.routes(app);
  await loadPlugins();

  app.get('/api/health', (_req, res) => {
    res.json({ status: 'ok', service: 'glogg-engine', version: '0.3.0', connectors: 20 });
  });

  app.get('/api/containers', async (_req, res) => {
    try {
      const report = await getContainerStackStatus();
      res.json(report);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to inspect container stack';
      res.status(500).json({ error: message });
    }
  });

  app.post('/api/containers/action', async (req, res) => {
    try {
      const { action, serviceId } = (req.body ?? {}) as {
        action?: 'up' | 'stop' | 'restart' | 'logs' | 'stack-up' | 'stack-down' | 'start-daemon';
        serviceId?: string;
      };
      if (!action) {
        res.status(400).json({ error: 'Action is required' });
        return;
      }
      const result = await runContainerOrchestrationAction({ action, serviceId });
      const stack = await getContainerStackStatus();
      res.json({ ...result, stack });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Container action failed';
      res.status(500).json({ ok: false, output: message, error: message });
    }
  });

  app.get('/api/nodes', async (_req, res) => {
    // Report the addresses actually probed: Docker Compose points SEARXNG_URL at http://searxng:8080.
    const nodes = {
      searxng: process.env.SEARXNG_URL || 'http://localhost:8080',
      bitmagnet: process.env.BITMAGNET_URL || 'http://localhost:3333',
      ipfs: process.env.IPFS_GATEWAY_URL || 'http://localhost:8081',
      nzbhydra2: process.env.NEWZNAB_URL || 'http://localhost:5076',
      prowlarr: process.env.TORZNAB_URL || 'http://localhost:9696',
      torProxy: 'http://localhost:8118',
    };
    const online = await Promise.all(Object.values(nodes).map((url) => checkNodeReachable(url)));
    res.json({
      localDockerStack: Object.fromEntries(Object.entries(nodes).map(([id, url], i) => [id, { url, online: online[i] }])),
      activeUpstreamConnectors: [
        { id: 'marginalia', name: 'Marginalia Small-Web API', protocol: 'REST JSON', status: 'active' },
        { id: 'wiby', name: 'Wiby Classic Handmade Web', protocol: 'REST JSON', status: 'active' },
        { id: 'atproto', name: 'ATProtocol / Bluesky Firehose', protocol: 'XRPC / DID', status: 'active' },
        { id: 'activitypub', name: 'ActivityPub / Mastodon Federation', protocol: 'ActivityPub v2', status: 'active' },
        { id: 'matrix', name: 'Matrix Public Room Directory', protocol: 'Matrix CS v3', status: 'active' },
        { id: 'stoat', name: 'Stoat / Revolt Federated Chat', protocol: 'Stoat Discovery', status: 'active' },
        { id: 'lemmy', name: 'Lemmy Fediverse Index', protocol: 'ActivityPub / JSON', status: 'active' },
        { id: 'bitmagnet-dht', name: 'Bitmagnet / Public DHT Swarm Index', protocol: 'GraphQL / BT-DHT', status: 'active' },
        { id: 'archive-bt', name: 'Internet Archive BitTorrent Seedbox', protocol: 'BT / Metadata API', status: 'active' },
        { id: 'usenet-nzb', name: 'NZBIndex / Newznab Usenet Binary Index', protocol: 'NZB / Newznab', status: 'active' },
        { id: 'gdelt-news', name: 'GDELT Global Unfiltered News Wire', protocol: 'DOC v2 JSON', status: 'active' },
        { id: 'archive-deep', name: 'Internet Archive Deep Texts & FOIA', protocol: 'AdvancedSearch API', status: 'active' },
        { id: 'openalex', name: 'OpenAlex 250M+ Scholarly Works', protocol: 'REST JSON', status: 'active' },
        { id: 'hn', name: 'Hacker News Algolia Index', protocol: 'REST JSON', status: 'active' },
        { id: 'arxiv', name: 'arXiv Preprint Server', protocol: 'Atom XML', status: 'active' },
        { id: 'github', name: 'GitHub Open-Source Index', protocol: 'REST v3', status: 'active' },
        { id: 'stackexchange', name: 'StackExchange Network', protocol: 'REST v2.3', status: 'active' },
        { id: 'wikipedia', name: 'MediaWiki Reference Index', protocol: 'OpenSearch JSON', status: 'active' },
      ],
    });
  });

  app.get('/api/directory', (req, res) => {
    const category = typeof req.query.category === 'string' ? req.query.category : undefined;
    const shuffle = req.query.shuffle === 'true';
    let items = [...CURATED_INDIE_INDEX];
    if (category && category !== 'all') {
      items = items.filter((i) => i.category === category);
    }
    if (shuffle) {
      items.sort(() => Math.random() - 0.5);
    }
    res.json({ items });
  });

  app.get('/api/downloads', async (_req, res) => {
    try {
      res.json(await getDownloadManagerReport());
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Download manager error' });
    }
  });

  app.post('/api/downloads', async (req, res) => {
    try {
      const { url, title, target, sizeFormatted } = (req.body ?? {}) as {
        url?: string;
        title?: string;
        target?: DownloadTargetId;
        sizeFormatted?: string;
      };
      if (!url || typeof url !== 'string') {
        res.status(400).json({ error: 'url is required' });
        return;
      }
      const job = await enqueueDownload({ url, title, target, sizeFormatted });
      res.json({ job });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Failed to enqueue' });
    }
  });

  app.delete('/api/downloads/:id', (req, res) => {
    res.json({ jobs: req.params.id === 'finished' ? clearFinishedDownloads() : removeDownload(req.params.id) });
  });

  app.get('/api/integrations', (_req, res) => {
    res.json({ config: maskConfig(loadIntegrationConfig()) });
  });

  app.put('/api/integrations', (req, res) => {
    // No config is nothing to change; a config that isn't an object of settings is a mistake.
    const patch: unknown = req.body?.config ?? {};
    if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) {
      res.status(400).json({ error: 'config must be an object of settings' });
      return;
    }
    res.json({ config: maskConfig(saveIntegrationConfig(patch as CustomEndpointsConfig)) });
  });

  /**
   * Client endpoints win, but secrets saved server-side fill in the gaps. A
   * stored key only goes with the address it was saved for: a request naming
   * another indexer gets no key, so it can't collect yours.
   */
  const mergeEndpoints = (config?: Partial<SearchFilterConfig>): Partial<SearchFilterConfig> => {
    const stored = loadIntegrationConfig();
    const clientEndpoints: CustomEndpointsConfig = Object.fromEntries(
      Object.entries(config?.endpoints || {}).filter(
        ([, v]) => typeof v === 'string' && v.trim() !== '' && !v.startsWith('••••')
      )
    );
    const merged: CustomEndpointsConfig = { ...stored, ...clientEndpoints };
    for (const [urlKey, secretKeys] of SECRET_OWNERS) {
      const asked = clientEndpoints[urlKey]?.trim().replace(/\/+$/, '');
      if (!asked || asked === stored[urlKey]?.trim().replace(/\/+$/, '')) continue;
      for (const k of secretKeys) if (!clientEndpoints[k]) delete merged[k];
    }
    return { ...config, endpoints: merged };
  };

  app.post('/api/search', async (req, res) => {
    try {
      // No JSON body (a form post, say) is a bad request, not a crash.
      const { query, config: rawConfig } = (req.body ?? {}) as {
        query?: string;
        config?: unknown;
      };
      if (!query || typeof query !== 'string' || !query.trim()) {
        res.status(400).json({ error: 'Query string is required' });
        return;
      }
      const checked = checkSearchConfig(rawConfig);
      if ('error' in checked) {
        res.status(400).json({ error: checked.error });
        return;
      }
      const response = await executeFederatedSearch(query, mergeEndpoints(checked.config));
      res.json(response);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Search failed';
      res.status(500).json({ error: message });
    }
  });

  app.get('/api/search', async (req, res) => {
    try {
      const q = typeof req.query.q === 'string' ? req.query.q : '';
      const uncensored = req.query.uncensored === 'true';
      const lens = isSearchLens(req.query.lens) ? req.query.lens : 'all';
      if (!q.trim()) {
        res.status(400).json({ error: 'Query parameter q is required' });
        return;
      }
      const response = await executeFederatedSearch(q, mergeEndpoints({ uncensoredMode: uncensored, lens }));
      res.json(response);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Search failed';
      res.status(500).json({ error: message });
    }
  });

  // ── Research (Advanced view): newline-delimited JSON events ────────────
  app.post('/api/research', async (req, res) => {
    const body = (req.body || {}) as ResearchRequest;
    if (!body.query || typeof body.query !== 'string' || !body.query.trim()) {
      res.status(400).json({ error: 'query is required' });
      return;
    }
    const ctrl = new AbortController();
    res.on('close', () => {
      if (!res.writableEnded) ctrl.abort();
    });
    res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();
    const ai = resolveAiConfig(getPluginSettings('ai'));
    const events = runResearch(
      {
        query: body.query.trim(),
        candidates: Array.isArray(body.candidates) ? body.candidates.slice(0, 30) : undefined,
        instantAnswer: body.instantAnswer,
        depth: body.depth,
        history: Array.isArray(body.history) ? body.history.slice(-3) : [],
        config: mergeEndpoints(body.config),
      },
      { ai, signal: ctrl.signal }
    );
    for await (const event of events) {
      if (ctrl.signal.aborted) break;
      res.write(`${JSON.stringify(event)}\n`);
    }
    res.end();
  });

  // ── Deep index (Atlas) ────────────────────────────────────────────────
  const deepKind = (v: unknown): DeepKind | 'all' =>
    v === 'blog' || v === 'board' || v === 'forum' || v === 'site' ? v : 'all';

  app.get('/api/deep', async (_req, res) => {
    res.json(await deepStatus());
  });

  app.post('/api/deep/crawl', async (req, res) => {
    const action = req.body?.action;
    try {
      if (action === 'start') await startCrawl();
      else if (action === 'pause') await pauseCrawl();
      else if (action === 'reseed') await ensureSeeded({ force: true });
      else {
        res.status(400).json({ error: 'action must be start, pause or reseed' });
        return;
      }
      res.json(await deepStatus());
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Deep index error' });
    }
  });

  /** The Atlas directory. The first call loads the open directories (no crawling). */
  app.get('/api/deep/sites', async (req, res) => {
    const store = await getDeepStore();
    if (!store) {
      res.json({ available: false, total: 0, items: [], counts: {}, errors: [(await deepStatus()).reason] });
      return;
    }
    const { errors, loading } = await ensureSeeded();
    const q = (k: string) => (typeof req.query[k] === 'string' ? (req.query[k] as string) : undefined);
    const order = q('order');
    const kind = deepKind(q('kind'));
    const nsfw = q('nsfw') === 'true';
    const page = store.listSources({
      kind,
      origin: q('origin') || undefined,
      q: q('q'),
      // Whole numbers in range: SQLite refuses 1.5 or 1e400 as a LIMIT.
      offset: Math.min(1_000_000, Math.max(0, Math.floor(Number(q('offset'))) || 0)),
      limit: Math.min(200, Math.max(1, Math.floor(Number(q('limit'))) || 60)),
      order: order === 'random' || order === 'name' ? order : 'posts',
      nsfw,
    });
    const counts = Object.fromEntries(store.stats().byKind.map((k) => [k.kind, k.sources]));
    const origins = kind === 'all' ? [] : store.originCounts(kind, nsfw);
    res.json({ available: true, ...page, counts, origins, errors, loading });
  });

  app.post('/api/deep/sources', async (req, res) => {
    const url = typeof req.body?.url === 'string' ? req.body.url : '';
    if (!url.trim()) {
      res.status(400).json({ error: 'url is required' });
      return;
    }
    try {
      res.json({ source: await addUserSource(url, undefined, { nsfw: req.body?.nsfw === true }) });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Could not add that source' });
    }
  });

  app.get('/api/deep/random', async (req, res) => {
    const kind = deepKind(req.query.kind);
    const pick = await randomDeep({ nsfw: req.query.nsfw === 'true', kinds: kind === 'all' ? undefined : [kind] });
    if (!pick) {
      res.status(404).json({ error: 'Nothing indexed yet' });
      return;
    }
    res.json(pick);
  });

  // ── Plugins ────────────────────────────────────────────────────────────
  const pluginsPayload = () => ({
    plugins: listPlugins().map((p) => (p.error ? p : { ...p, values: maskPluginSettings(p.id) })),
    userDir: USER_PLUGIN_DIR(),
  });

  app.get('/api/plugins', (_req, res) => {
    res.json(pluginsPayload());
  });

  app.post('/api/plugins/reload', async (_req, res) => {
    await loadPlugins({ force: true });
    res.json(pluginsPayload());
  });

  app.put('/api/plugins/:id/settings', (req, res) => {
    try {
      const values = savePluginSettings(req.params.id, (req.body?.values || {}) as Record<string, unknown>);
      const info = listPlugins().find((p) => p.id === req.params.id);
      res.json({ values: maskPluginSettings(req.params.id, values), configured: Boolean(info?.configured) });
    } catch (err) {
      res.status(404).json({ error: err instanceof Error ? err.message : 'Unknown plugin' });
    }
  });

  app.post('/api/plugins/:id/tools/:tool', async (req, res) => {
    const ctrl = new AbortController();
    res.on('close', () => {
      if (!res.writableEnded) ctrl.abort();
    });
    const input = (req.body?.input || {}) as Record<string, unknown>;
    res.json(await runPluginTool(req.params.id, req.params.tool, input, { signal: ctrl.signal }));
  });

  app.get('/api/plugins/:id/container', async (req, res) => {
    res.json(await pluginContainerStatus(req.params.id));
  });

  app.post('/api/plugins/:id/container', async (req, res) => {
    const action = req.body?.action as 'up' | 'down' | 'remove' | undefined;
    if (action !== 'up' && action !== 'down' && action !== 'remove') {
      res.status(400).json({ error: 'action must be up, down or remove' });
      return;
    }
    try {
      res.json(await pluginContainerAction(req.params.id, action));
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Container action failed' });
    }
  });

  // Result icons come through glogg, so the browser never tells a third party which sites you're looking at.
  app.get('/api/favicon/:domain', async (req, res) => {
    const domain = req.params.domain;
    if (!isIconDomain(domain)) {
      res.status(400).end();
      return;
    }
    const icon = await siteIcon(domain);
    res.setHeader('Cache-Control', 'private, max-age=604800');
    if (!icon.body) {
      res.status(404).end();
      return;
    }
    res.type(icon.type).send(icon.body);
  });

  app.get('/opensearch.xml', (req, res) => {
    // req.protocol believes X-Forwarded-Proto only from a trusted proxy; a Host that isn't a plain name:port isn't echoed.
    const host = /^(?:[a-z0-9.-]+|\[[0-9a-f:.]+\])(?::\d{1,5})?$/i.test(req.headers.host || '') ? req.headers.host! : 'localhost:4173';
    const baseUrl = `${req.protocol === 'https' ? 'https' : 'http'}://${host}`;
    res.setHeader('Content-Type', 'application/opensearchdescription+xml; charset=utf-8');
    res.send(`<?xml version="1.0" encoding="UTF-8"?>
<OpenSearchDescription xmlns="http://a9.com/-/spec/opensearch/1.1/">
  <ShortName>glogg.app</ShortName>
  <Description>glogg — Anti-Slop Real-Web, Fediverse, P2P DHT &amp; Usenet Meta-Indexer</Description>
  <InputEncoding>UTF-8</InputEncoding>
  <Url type="text/html" method="get" template="${baseUrl}/?q={searchTerms}"/>
  <Url type="application/json" rel="results" template="${baseUrl}/api/search?q={searchTerms}"/>
  <Url type="application/x-suggestions+json" rel="suggestions" template="${baseUrl}/api/opensearch/suggest?q={searchTerms}"/>
</OpenSearchDescription>`);
  });

  app.get('/api/opensearch/suggest', (req, res) => {
    const q = typeof req.query.q === 'string' ? req.query.q.trim().toLowerCase() : '';
    if (!q) {
      res.json([q, [], [], []]);
      return;
    }
    const matches = CURATED_INDIE_INDEX.filter(
      (item) =>
        item.title.toLowerCase().includes(q) ||
        item.domain.toLowerCase().includes(q) ||
        item.tags.some((t) => t.toLowerCase().includes(q))
    ).slice(0, 8);

    res.json([
      q,
      matches.map((m) => m.title),
      matches.map((m) => m.description),
      matches.map((m) => m.url),
    ]);
  });

  app.get('/api/ipfs/:cid', async (req, res) => {
    const cid = (req.params.cid || '').trim();
    if (!cid || !/^[a-zA-Z0-9]+$/.test(cid)) {
      res.status(400).json({ error: 'Valid IPFS CID is required' });
      return;
    }
    const localGateway = process.env.IPFS_GATEWAY_URL || 'http://localhost:8081';
    const localReachable = await checkNodeReachable(`${localGateway}/ipfs/${cid}`, 900);
    const resolvedGatewayUrl = localReachable
      ? `${localGateway}/ipfs/${cid}`
      : `https://ipfs.io/ipfs/${cid}`;

    res.json({
      cid,
      localNodeActive: localReachable,
      gatewayUrl: resolvedGatewayUrl,
      fallbackGateways: [
        `http://localhost:8081/ipfs/${cid}`,
        `https://ipfs.io/ipfs/${cid}`,
        `https://dweb.link/ipfs/${cid}`,
      ],
    });
  });

  app.post('/api/inspect', async (req, res) => {
    try {
      const { url, rawHtml } = (req.body ?? {}) as { url?: string; rawHtml?: string };
      if (!url || typeof url !== 'string') {
        res.status(400).json({ error: 'Target URL is required' });
        return;
      }

      if (rawHtml && typeof rawHtml === 'string') {
        const report = cleanAndAutopsyHtml(rawHtml, url);
        res.json(report);
        return;
      }

      let parsedUrl: URL;
      try {
        parsedUrl = new URL(url.startsWith('http') ? url : `https://${url}`);
      } catch {
        res.status(400).json({ error: 'Invalid URL format' });
        return;
      }

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 7500);
      try {
        // Public addresses only, and at most 5 MB of the page.
        const upstream = await publicFetch(parsedUrl.toString(), {
          signal: controller.signal,
          headers: {
            'User-Agent': USER_AGENT,
            Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          },
        });
        const html = await readTextCapped(upstream, 5_000_000);
        const report = cleanAndAutopsyHtml(html, parsedUrl.toString());
        res.json(report);
      } finally {
        clearTimeout(timer);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to fetch and clean URL';
      res.status(502).json({ error: message });
    }
  });

  if (!isProd) {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static(distPath));
    app.get('/{*splat}', (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  return app;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  configureNetwork();
  const port = Number(process.env.PORT || 4173);
  createGloggServer()
    .then((app) => {
      // This machine only, unless HOST says otherwise (the Docker image listens on all interfaces).
      const host = process.env.HOST || '127.0.0.1';
      app.listen(port, host, () => {
        console.log(`glogg engine listening on http://localhost:${port}`);
        const password = configuredPassword();
        if (password) {
          console.log('Password protection is on.');
          if (password.length < 12) console.warn('GLOGG_PASSWORD is shorter than 12 characters; use a longer one on a public address.');
        } else if (!process.env.GLOGG_IN_CONTAINER && !['127.0.0.1', 'localhost', '::1'].includes(host)) {
          console.warn(`glogg answers anyone who can reach ${host}:${port}, with no password. Set GLOGG_PASSWORD, or HOST=127.0.0.1 to keep it on this machine.`);
        }
        // Pick up a deep-index crawl you started before the last restart.
        resumeDeepCrawl().catch((e) => console.error('deep index:', e instanceof Error ? e.message : e));
      });
    })
    .catch((e) => {
      console.error(`glogg couldn't start: ${e instanceof Error ? e.message : e}`);
      process.exit(1);
    });
}
