import { describe, expect, it } from 'vitest';
import {
  analyzeQueryIntent,
  assessP2PHealth,
  buildMagnetUri,
  cleanAndAutopsyHtml,
  compileSearchQuery,
  computeQueryRelevance,
  diversifyAndRankResults,
  evaluateInstantComputation,
  exportUBlacklistRuleset,
  formatBytes,
  isValidInfoHash,
  parseRulesetDomains,
  RawSearchResult,
  scoreSearchResult,
} from '../src/core/index.js';

describe('glogg anti-slop & meta-indexer core engine', () => {
  it('penalizes SEO listicles, AI clichés, and sponsored affiliate links while stripping tracking params', () => {
    const slopItem: RawSearchResult = {
      title: '15 Best Linux Distros in 2026: The Ultimate Guide (2026 Updated)',
      url: 'https://www.forbes.com/sites/seo-mill/2026/01/15-best-linux-distros-ultimate-guide-review?utm_source=google&gclid=12345&tag=aff-20',
      snippet:
        "In today's fast-paced digital world, whether you're a seasoned pro or a beginner, we may earn a commission when you delve into this rich tapestry of operating systems.",
      source: 'web',
      publishedAt: '2026-01-10',
    };

    const scored = scoreSearchResult(slopItem);
    expect(scored.slopScore).toBeGreaterThanOrEqual(75);
    expect(scored.isSponsored).toBe(true);
    expect(scored.url).not.toContain('utm_source');
    expect(scored.url).not.toContain('gclid');
    expect(['sponsored-ad', 'slop-farm']).toContain(scored.verdict);
  });

  it('boosts primary sources and indie web blogs with pre-LLM timestamps and extracts TLDs', () => {
    const primaryPaper: RawSearchResult = {
      title: 'Attention Is All You Need — arXiv:1706.03762',
      url: 'https://arxiv.org/abs/1706.03762',
      snippet: 'Primary transformer architecture specification and benchmark evaluation.',
      source: 'arxiv',
      publishedAt: '2017-06-12',
    };

    const indiePost: RawSearchResult = {
      title: 'Filesystems and fsync latency postmortem',
      url: 'https://danluu.com/fsync-latency/',
      snippet: 'Empirical syscall benchmark disassembling kernel page cache behavior.',
      source: 'indie-index',
      publishedAt: '2019-03-14',
    };

    const scoredPaper = scoreSearchResult(primaryPaper);
    const scoredIndie = scoreSearchResult(indiePost);

    expect(scoredPaper.isPrimarySource).toBe(true);
    expect(scoredPaper.tld).toBe('.org');
    expect(scoredPaper.verdict).toBe('primary-source');
    expect(scoredPaper.authenticityScore).toBeGreaterThanOrEqual(75);
    expect(scoredPaper.slopScore).toBeLessThan(20);

    expect(scoredIndie.isIndieWeb).toBe(true);
    expect(scoredIndie.isPreLlm).toBe(true);
    expect(scoredIndie.authenticityScore).toBeGreaterThanOrEqual(80);
  });

  it('builds verified BitTorrent magnet URIs and flags fake/malware P2P spam', () => {
    const validSha1 = '2C6B6858D61DA9543D4231A71DB4B1C9264B0685';
    expect(isValidInfoHash(validSha1)).toBe(true);
    expect(isValidInfoHash('invalid-hash')).toBe(false);

    const magnet = buildMagnetUri(validSha1, 'Ubuntu 22.04 LTS');
    expect(magnet).toContain('magnet:?xt=urn:btih:2c6b6858d61da9543d4231a71db4b1c9264b0685');
    expect(magnet).toContain('dn=Ubuntu%2022.04%20LTS');
    expect(magnet).toContain('tr=');

    expect(formatBytes(3654957056)).toBe('3.40 GB');

    // Malware .exe / fake tiny 1080p video stub detection
    expect(
      assessP2PHealth({
        title: 'Linux.Kernel.Guide.pdf.exe',
        sizeBytes: 1024 * 500,
        seeders: 500,
        protocol: 'bittorrent-dht',
      })
    ).toBe('suspect-spam');

    expect(
      assessP2PHealth({
        title: 'Ubuntu-24.04-Desktop-amd64.iso',
        sizeBytes: 4.8 * 1024 * 1024 * 1024,
        seeders: 85,
        protocol: 'bittorrent-dht',
      })
    ).toBe('verified-swarm');
  });

  it('enforces strict domain diversity cap, separates P2P results, and computes TLD/Source distributions', () => {
    const rawList: RawSearchResult[] = [
      {
        title: 'Dan Luu — Terminal Latency',
        url: 'https://danluu.com/term-latency/',
        snippet: 'Measuring terminal emulator input latency.',
        source: 'web',
        publishedAt: '2017-08-01',
      },
      {
        title: 'Dan Luu — Keyboard Latency',
        url: 'https://danluu.com/keyboard-latency/',
        snippet: 'Empirical USB polling rate latency measurements.',
        source: 'web',
        publishedAt: '2017-09-01',
      },
      {
        title: 'Sponsored Post: Best Gaming Keyboards 2026',
        url: 'https://www.techradar.com/best/gaming-keyboards?tag=affiliate-20',
        snippet: 'Sponsored content: we may earn a commission on our top picks.',
        source: 'web',
        publishedAt: '2026-02-01',
      },
      {
        title: 'RFC 9000: QUIC Transport Protocol',
        url: 'https://datatracker.ietf.org/doc/html/rfc9000',
        snippet: 'IETF standard specification for UDP-based multiplexed transport.',
        source: 'web',
        publishedAt: '2021-05-01',
      },
      {
        title: 'Ubuntu 22.04 LTS Swarm',
        url: 'magnet:?xt=urn:btih:2c6b6858d61da9543d4231a71db4b1c9264b0685',
        snippet: 'BitTorrent DHT Swarm',
        source: 'bitmagnet-dht',
        p2p: {
          protocol: 'bittorrent-dht',
          infoHash: '2c6b6858d61da9543d4231a71db4b1c9264b0685',
          magnetUri: 'magnet:?xt=urn:btih:2c6b6858d61da9543d4231a71db4b1c9264b0685',
          sizeBytes: 3654957056,
          sizeFormatted: '3.40 GB',
          seeders: 42,
          leechers: 5,
          indexerName: 'Bitmagnet DHT',
          healthVerdict: 'verified-swarm',
        },
      },
    ];

    const ranked = diversifyAndRankResults(rawList, {
      lens: 'all',
      maxPerDomain: 1,
      stripSponsored: true,
      slopThreshold: 50,
    });

    expect(ranked.surfaced.length).toBe(3);
    expect(ranked.p2pResults.length).toBe(1);
    expect(ranked.demotedDuplicateDomainsCount).toBe(1);
    expect(ranked.sponsoredRemovedCount).toBe(1);
    expect(ranked.tldDistribution['.org']).toBe(1);
    expect(ranked.tldDistribution['.com']).toBe(1);
  });

  it('compiles anti-slop search queries with P2P, Usenet, and Small-Web escape hatches', () => {
    const compiled = compileSearchQuery('b-tree implementation', {
      lens: 'primary',
      preLlmOnly: true,
      blockedDomains: ['example-slop.com'],
    });

    expect(compiled.synthesizedQuery).toContain('before:2022-11-30');
    expect(compiled.synthesizedQuery).toContain('-site:example-slop.com');
    expect(compiled.escapeUrls.some((u) => u.id === 'marginalia')).toBe(true);
    expect(compiled.escapeUrls.some((u) => u.id === 'btdigg-dht')).toBe(true);
    expect(compiled.escapeUrls.some((u) => u.id === 'nzbindex')).toBe(true);
  });

  it('strips trackers, collapses SEO preamble fluff, and extracts cited Primary Sources from HTML', () => {
    const sampleHtml = `
      <!doctype html>
      <html>
        <head>
          <title>10 Best Database Engines in 2026: Ultimate Guide (2026)</title>
          <script src="https://www.googletagmanager.com/gtm.js"></script>
          <script src="https://cdn.taboola.com/libtrc/loader.js"></script>
        </head>
        <body>
          <div class="cookie-banner">Accept cookies</div>
          <div class="sponsored-banner">Sponsored by CloudDB</div>
          <article>
            <h1>10 Best Database Engines in 2026</h1>
            <p>In today's fast-paced digital world, whether you're a seasoned pro or a beginner, databases are a rich tapestry of storage. Without further ado, let's dive right in!</p>
            <p>Specifically, write-ahead logging reduces random disk seeks by sequentializing page flushes at 1.2 ms p99 latency.</p>
            <p>Read the primary specification at <a href="https://arxiv.org/abs/2201.09999">arXiv Storage Paper</a> and inspect the code at <a href="https://github.com/sqlite/sqlite">SQLite Source Repository</a> or buy via <a href="https://amzn.to/3abc?tag=aff-20">Amazon Affiliate</a>.</p>
          </article>
        </body>
      </html>
    `;

    const report = cleanAndAutopsyHtml(sampleHtml, 'https://example-blog.com/db-guide');

    expect(report.stats.totalScriptsRemoved).toBe(2);
    expect(report.stats.trackersBlocked.length).toBeGreaterThanOrEqual(2);
    expect(report.stats.sponsoredBlocksRemoved).toBeGreaterThanOrEqual(1);
    expect(report.stats.affiliateLinksDisarmed).toBe(1);
    expect(report.stats.fluffPreambleParagraphs).toBeGreaterThanOrEqual(1);
    expect(report.primarySources.length).toBe(2);
    expect(report.primarySources.map((p) => p.sourceTypeLabel)).toEqual(
      expect.arrayContaining(['arXiv Preprint', 'Source Repository'])
    );
  });

  it('round-trips uBlacklist rulesets accurately', () => {
    const exported = exportUBlacklistRuleset(['Pinterest.com', 'www.Forbes.com']);
    expect(exported).toContain('*://*.pinterest.com/*');
    expect(exported).toContain('*://*.forbes.com/*');

    const parsed = parseRulesetDomains(exported);
    expect(parsed).toEqual(['pinterest.com', 'forbes.com']);
  });

  it('scores Fediverse protocols (ATProtocol, ActivityPub, Matrix, Stoat) and gates 18+ Uncensored content properly', () => {
    const bskyPost: RawSearchResult = {
      title: '[ATProto · @alice.bsky.social] Decentralized indexing architecture',
      url: 'https://bsky.app/profile/alice.bsky.social/post/3kxyz',
      snippet: 'Building an open ATProtocol firehose relay with zero algorithmic ads.',
      source: 'atproto',
      fediverse: {
        protocol: 'atproto',
        instanceDomain: 'bsky.app',
        handleOrRoom: '@alice.bsky.social',
        uri: 'at://did:plc:alice/app.bsky.feed.post/3kxyz',
        membersOrInteractions: 116,
      },
    };

    const matrixRoom: RawSearchResult = {
      title: '[Matrix Room] Self-Hosted & Privacy Systems (#selfhosted:matrix.org)',
      url: 'https://matrix.to/#/#selfhosted:matrix.org',
      snippet: 'Decentralized E2EE Matrix room for self-hosting Bitmagnet, IPFS, and SearXNG.',
      source: 'matrix',
      fediverse: {
        protocol: 'matrix',
        instanceDomain: 'matrix.org',
        handleOrRoom: '#selfhosted:matrix.org',
        uri: 'https://matrix.to/#/#selfhosted:matrix.org',
        membersOrInteractions: 4120,
      },
    };

    const nsfwSwarm: RawSearchResult = {
      title: 'Adult 18+ Uncensored Archive Collection XXX 1080p',
      url: 'magnet:?xt=urn:btih:3c6b6858d61da9543d4231a71db4b1c9264b0685',
      snippet: 'Adult 18+ DHT Swarm',
      source: 'bitmagnet-dht',
      isNsfw: true,
      p2p: {
        protocol: 'bittorrent-dht',
        infoHash: '3c6b6858d61da9543d4231a71db4b1c9264b0685',
        magnetUri: 'magnet:?xt=urn:btih:3c6b6858d61da9543d4231a71db4b1c9264b0685',
        sizeBytes: 2147483648,
        sizeFormatted: '2.00 GB',
        seeders: 50,
        leechers: 8,
        indexerName: 'DHT Swarm (18+ Uncensored)',
        healthVerdict: 'verified-swarm',
      },
    };

    const scoredBsky = scoreSearchResult(bskyPost);
    expect(scoredBsky.verdict).toBe('fediverse-node');
    expect(scoredBsky.authenticityScore).toBeGreaterThanOrEqual(70);

    // With uncensoredMode: false (default), NSFW item is held back in filteredSlop
    const safeRanked = diversifyAndRankResults([bskyPost, matrixRoom, nsfwSwarm], {
      lens: 'all',
      uncensoredMode: false,
    });
    expect(safeRanked.fediverseCount).toBe(2);
    expect(safeRanked.surfaced.some((r) => r.isNsfw)).toBe(false);
    expect(safeRanked.filteredSlop.some((r) => r.isNsfw)).toBe(true);

    // With uncensoredMode: true, NSFW item is surfaced in both surfaced and p2pResults
    const uncensoredRanked = diversifyAndRankResults([bskyPost, matrixRoom, nsfwSwarm], {
      lens: 'all',
      uncensoredMode: true,
    });
    expect(uncensoredRanked.surfaced.some((r) => r.isNsfw)).toBe(true);
    expect(uncensoredRanked.p2pResults.some((r) => r.isNsfw)).toBe(true);
  });

  it('distills conversational questions, evaluates instant math/unit queries, and filters off-topic stopword noise', () => {
    const q1 = analyzeQueryIntent('what is the capital of kazakhstan');
    expect(q1.coreKeywords).toEqual(['capital', 'kazakhstan']);
    expect(q1.questionAttribute).toBe('capital');
    expect(q1.entitySubject).toBe('kazakhstan');
    expect(q1.anchorTokens[0]).toBe('kazakhstan');

    const mathAns = evaluateInstantComputation('256 * 1024');
    expect(mathAns?.kind).toBe('computation');
    expect(mathAns?.title).toBe('262,144');

    const unitAns = evaluateInstantComputation('4096 mb in gb');
    expect(unitAns?.kind).toBe('computation');
    expect(unitAns?.title).toBe('4 GB');

    const directHit = computeQueryRelevance(
      'what is the capital of kazakhstan',
      'Astana — Wikipedia Reference',
      'Astana is the capital city of Kazakhstan.',
      'https://en.wikipedia.org/wiki/Astana'
    );
    const stopwordNoise = computeQueryRelevance(
      'what is the capital of kazakhstan',
      'Low-Tech Magazine — Solar Website',
      'What is the future of the web and how does it work?',
      'https://solar.lowtechmagazine.com/'
    );

    expect(directHit.relevanceScore).toBeGreaterThanOrEqual(80);
    expect(directHit.isDirectAnswerCandidate).toBe(true);
    expect(stopwordNoise.relevanceScore).toBe(0);
  });
});

