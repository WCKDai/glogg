import { compileSearchQuery } from '../src/core/queryCompiler.js';
import { scoreSearchResult } from '../src/core/slopScorer.js';

const SPONSORED_SERP_SELECTORS = [
  '#tads',
  '#bottomads',
  '[data-text-ad]',
  '[aria-label="Ads"]',
  '.commercial-unit-desktop-top',
  '.b_ad',
  '.result--ad',
  '.badge--ad',
  '[data-testid="sponsored-result"]',
];

function injectGloggStyles() {
  if (document.getElementById('glogg-ext-styles')) return;
  const style = document.createElement('style');
  style.id = 'glogg-ext-styles';
  style.textContent = `
    .glogg-hud {
      font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
      background: #0e1015;
      color: #f3f4f6;
      border: 1px solid rgba(59, 130, 246, 0.38);
      border-radius: 8px;
      padding: 8px 14px;
      margin: 10px auto;
      max-width: 960px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      font-size: 12.5px;
      box-shadow: 0 8px 24px rgba(0, 0, 0, 0.35);
      z-index: 99999;
    }
    .glogg-hud-brand {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      font-weight: 600;
    }
    .glogg-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: #3b82f6;
      box-shadow: 0 0 8px #3b82f6;
    }
    .glogg-hud-stats {
      font-family: 'JetBrains Mono', ui-monospace, monospace;
      font-size: 11.5px;
      color: #9ca3af;
      display: flex;
      gap: 10px;
    }
    .glogg-hud-btn {
      background: rgba(59, 130, 246, 0.14);
      color: #60a5fa;
      border: 1px solid rgba(59, 130, 246, 0.36);
      border-radius: 5px;
      padding: 3px 9px;
      font-size: 11.5px;
      cursor: pointer;
      text-decoration: none;
    }
    .glogg-hud-btn:hover {
      background: #2563eb;
      color: #ffffff;
    }
    .glogg-badge {
      display: inline-flex;
      align-items: center;
      font-family: 'JetBrains Mono', ui-monospace, monospace;
      font-size: 10px;
      font-weight: 600;
      padding: 1px 6px;
      border-radius: 4px;
      margin-right: 6px;
      vertical-align: middle;
    }
    .glogg-badge-primary {
      background: rgba(59, 130, 246, 0.15);
      color: #60a5fa;
      border: 1px solid rgba(59, 130, 246, 0.4);
    }
    .glogg-badge-indie {
      background: rgba(16, 185, 129, 0.15);
      color: #10b981;
      border: 1px solid rgba(16, 185, 129, 0.4);
    }
    .glogg-demoted {
      opacity: 0.25 !important;
      filter: grayscale(1);
      transition: opacity 0.15s ease;
    }
    .glogg-demoted:hover {
      opacity: 0.85 !important;
    }
  `;
  document.head.appendChild(style);
}

function runSerpUnslopper() {
  injectGloggStyles();

  // 1. Strip Sponsored Ad Containers
  let sponsoredKilled = 0;
  for (const sel of SPONSORED_SERP_SELECTORS) {
    document.querySelectorAll(sel).forEach((el) => {
      const htmlEl = el as HTMLElement;
      if (htmlEl.style.display !== 'none') {
        htmlEl.style.display = 'none';
        sponsoredKilled += 1;
      }
    });
  }

  // 2. Locate organic search results across Google, DDG, Brave, Bing
  const candidateContainers = document.querySelectorAll(
    'div.g, article[data-testid="result"], div.snippet, li.b_algo'
  );

  const seenRootDomains = new Map<string, number>();
  let slopDemoted = 0;
  let primaryFound = 0;

  candidateContainers.forEach((container) => {
    const el = container as HTMLElement;
    if (el.dataset.gloggProcessed === '1') return;

    const anchor = el.querySelector('a[href^="http"]') as HTMLAnchorElement | null;
    const heading = el.querySelector('h3, h2') as HTMLElement | null;
    if (!anchor || !heading) return;

    el.dataset.gloggProcessed = '1';
    const url = anchor.href;
    const title = heading.textContent || '';
    const snippet = el.textContent?.slice(0, 350) || '';

    const scored = scoreSearchResult({
      title,
      url,
      snippet,
      source: 'web',
    });

    const domainCount = seenRootDomains.get(scored.rootDomain) ?? 0;
    seenRootDomains.set(scored.rootDomain, domainCount + 1);

    if (scored.isSponsored || scored.slopScore >= 50 || domainCount >= 1) {
      el.classList.add('glogg-demoted');
      slopDemoted += 1;
      return;
    }

    if (scored.isPrimarySource || scored.verdict === 'primary-source') {
      primaryFound += 1;
      const badge = document.createElement('span');
      badge.className = 'glogg-badge glogg-badge-primary';
      badge.textContent = `PRIMARY · ${scored.authenticityScore}%`;
      heading.prepend(badge);
    } else if (scored.isIndieWeb || scored.verdict === 'indie-gem') {
      const badge = document.createElement('span');
      badge.className = 'glogg-badge glogg-badge-indie';
      badge.textContent = `INDIE · ${scored.authenticityScore}%`;
      heading.prepend(badge);
    }
  });

  // 3. Render Glogg HUD at top of SERP
  const urlParams = new URLSearchParams(window.location.search);
  const currentQuery = urlParams.get('q') || urlParams.get('query') || '';
  if (currentQuery && !document.getElementById('glogg-serp-hud')) {
    const compiled = compileSearchQuery(currentQuery, { lens: 'all' });
    const hud = document.createElement('div');
    hud.id = 'glogg-serp-hud';
    hud.className = 'glogg-hud';

    const brand = document.createElement('div');
    brand.className = 'glogg-hud-brand';
    const dot = document.createElement('span');
    dot.className = 'glogg-dot';
    const titleSpan = document.createElement('span');
    titleSpan.textContent = 'glogg SERP Shield';
    brand.append(dot, titleSpan);

    const stats = document.createElement('div');
    stats.className = 'glogg-hud-stats';
    stats.textContent = `${sponsoredKilled} Ads Killed · ${slopDemoted} Slop/Dupes Demoted · ${primaryFound} Primary Sources`;

    const actions = document.createElement('div');
    actions.style.display = 'flex';
    actions.style.gap = '6px';

    const marginaliaLink = document.createElement('a');
    marginaliaLink.className = 'glogg-hud-btn';
    marginaliaLink.href = compiled.escapeUrls[0].url;
    marginaliaLink.target = '_blank';
    marginaliaLink.rel = 'noreferrer';
    marginaliaLink.textContent = 'Marginalia Small-Web ↗';

    const udmLink = document.createElement('a');
    udmLink.className = 'glogg-hud-btn';
    udmLink.href = compiled.escapeUrls[1].url;
    udmLink.textContent = 'Apply -site: Slop Filter';

    actions.append(marginaliaLink, udmLink);
    hud.append(brand, stats, actions);
    document.body.prepend(hud);
  }
}

runSerpUnslopper();
