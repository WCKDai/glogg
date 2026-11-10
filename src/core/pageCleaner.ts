import * as cheerio from 'cheerio';
import { normalizeQuotes } from './text.js';
import {
  AFFILIATE_MARKERS,
  AI_SLOP_PHRASES,
  INDIE_HOST_PATTERNS,
  PRIMARY_SOURCE_DOMAINS,
  SEO_LISTICLE_PATTERNS,
  TRACKER_SCRIPT_PATTERNS,
} from './curatedLists.js';
import {
  extractDomainInfo,
  scoreSearchResult,
  stripTrackingFromUrl,
} from './slopScorer.js';
import {
  CleanedContentSection,
  ExtractedPageLink,
  PageAutopsyReport,
  SignalHit,
} from './types.js';

const INDIE_GENERATORS = [
  'hugo',
  'jekyll',
  'zola',
  'eleventy',
  '11ty',
  'astro',
  'hexo',
  'pelican',
  'nikola',
  'org-mode',
  'pandoc',
  'mdbook',
  'sphinx',
  'quarto',
  'bear',
];

const SPONSORED_DOM_SELECTORS = [
  '[class*="sponsored"]',
  '[id*="sponsored"]',
  '[class*="ad-container"]',
  '[class*="ad-slot"]',
  '[class*="ad-wrapper"]',
  '[class*="affiliate"]',
  '[data-ad]',
  '[data-testid*="sponsored"]',
  'aside[class*="promo"]',
  '.partner-content',
  '.paid-post',
];

const CLUTTER_SELECTORS = [
  'script',
  'style',
  'noscript',
  'iframe',
  'canvas',
  'svg',
  'nav',
  'footer',
  'aside',
  'header nav',
  '[role="navigation"]',
  '[role="complementary"]',
  '[role="banner"]',
  '[aria-modal="true"]',
  '.cookie-banner',
  '.cookie-consent',
  '#cookie-notice',
  '[class*="cookie"]',
  '[id*="cookie"]',
  '[class*="newsletter"]',
  '[id*="newsletter"]',
  '[class*="subscribe"]',
  '[class*="popup"]',
  '[class*="modal"]',
  ...SPONSORED_DOM_SELECTORS,
  '[class*="social-share"]',
  '[class*="share-buttons"]',
  '[class*="related-posts"]',
  '[class*="recommended"]',
  '[class*="sidebar"]',
  '#sidebar',
  '.comments-area',
  '#comments',
];

const FLUFF_PREAMBLE_PATTERNS: RegExp[] = [
  /\b(?:in today's|in this article,?\s+we will|before we (?:dive|jump|get) into|have you ever wondered|whether you're a beginner|let's start by understanding what)\b/i,
  /\b(?:without further ado|scroll down to see|in this comprehensive guide|everything you need to know about)\b/i,
  /\b(?:we may earn a commission|affiliate links below|as an amazon associate)\b/i,
];

function classifyPrimarySourceLink(url: string, domain: string): string | undefined {
  const lowerUrl = url.toLowerCase();
  if (domain.includes('arxiv.org')) return 'arXiv Preprint';
  if (domain.includes('doi.org') || /10\.\d{4,9}\/[-._;()/:a-z0-9]+/i.test(url)) return 'DOI Citation';
  if (domain.includes('rfc-editor.org') || domain.includes('ietf.org') || /\/rfc\d+/i.test(lowerUrl)) return 'IETF RFC Spec';
  if (domain.includes('github.com') || domain.includes('gitlab.com') || domain.includes('codeberg.org') || domain.includes('sr.ht')) {
    return 'Source Repository';
  }
  if (domain.endsWith('.edu') || domain.endsWith('.ac.uk')) return 'Academic (.edu)';
  if (domain.endsWith('.gov') || domain.endsWith('.mil')) return 'Public Dataset (.gov)';
  if (lowerUrl.endsWith('.pdf')) return 'Primary PDF Document';
  if (PRIMARY_SOURCE_DOMAINS.some((d) => domain === d || domain.endsWith(`.${d}`))) {
    return 'Primary Reference';
  }
  return undefined;
}

/** Only links a reader can follow safely: no javascript:, data: or app-launching schemes. */
const FOLLOWABLE = new Set(['http:', 'https:', 'magnet:']);

export function cleanAndAutopsyHtml(rawHtml: string, pageUrl: string): PageAutopsyReport {
  try {
    return autopsy(rawHtml, pageUrl);
  } catch (e) {
    // The HTML parser walks the page recursively, so a few thousand nested elements overflow the stack.
    if (e instanceof RangeError) throw new Error('This page is nested too deeply to clean. Open the original instead.');
    throw e;
  }
}

function autopsy(rawHtml: string, pageUrl: string): PageAutopsyReport {
  const rawHtmlBytes = Buffer.byteLength(rawHtml, 'utf8');
  const $ = cheerio.load(rawHtml);
  const { domain, rootDomain } = extractDomainInfo(pageUrl);

  const title =
    $('meta[property="og:title"]').attr('content')?.trim() ||
    $('title').first().text().trim() ||
    $('h1').first().text().trim() ||
    domain;

  const byline =
    $('meta[name="author"]').attr('content')?.trim() ||
    $('[rel="author"]').first().text().trim() ||
    $('[class*="author-name"], [class*="byline"]').first().text().trim() ||
    undefined;

  const publishedDate =
    $('meta[property="article:published_time"]').attr('content')?.trim() ||
    $('meta[name="date"]').attr('content')?.trim() ||
    $('time[datetime]').first().attr('datetime')?.trim() ||
    undefined;

  const generator = $('meta[name="generator"]').attr('content')?.trim() || undefined;

  const rssEl = $(
    'link[type="application/rss+xml"], link[type="application/atom+xml"], link[type="application/feed+json"]'
  ).first();
  const hasRssFeed = rssEl.length > 0;
  let rssFeedUrl = rssEl.attr('href');
  if (rssFeedUrl) {
    try {
      const feed = new URL(rssFeedUrl, pageUrl);
      rssFeedUrl = feed.protocol === 'http:' || feed.protocol === 'https:' ? feed.toString() : undefined;
    } catch {
      rssFeedUrl = undefined;
    }
  }

  const hasRelMe = $('a[rel~="me"], link[rel~="me"], link[rel~="webmention"]').length > 0;
  const isStaticGenerator = Boolean(
    generator && INDIE_GENERATORS.some((g) => generator.toLowerCase().includes(g.trim()))
  );
  const hasIndieWebMarkers =
    hasRelMe || isStaticGenerator || hasRssFeed || INDIE_HOST_PATTERNS.some((rx) => rx.test(domain));

  // Count sponsored DOM containers before removal
  const sponsoredBlocksRemoved = $(SPONSORED_DOM_SELECTORS.join(', ')).length;

  // Audit scripts & trackers
  const scriptElements = $('script');
  const totalScriptsRemoved = scriptElements.length;
  const trackersFound = new Set<string>();

  scriptElements.each((_, el) => {
    const src = ($(el).attr('src') || '').toLowerCase();
    const inlineCode = $(el).html()?.slice(0, 600).toLowerCase() || '';
    for (const tracker of TRACKER_SCRIPT_PATTERNS) {
      const needle = tracker.toLowerCase();
      if (src.includes(needle) || inlineCode.includes(needle)) {
        trackersFound.add(tracker);
      }
    }
  });

  // Extract & classify outbound links (including Primary Sources cited inside the article!)
  const extractedLinks: ExtractedPageLink[] = [];
  const primarySources: ExtractedPageLink[] = [];
  const seenLinkUrls = new Set<string>();
  let affiliateLinksDisarmed = 0;
  let trackingParamsStripped = 0;

  $('a[href]').each((_, el) => {
    const rawHref = ($(el).attr('href') || '').trim();
    const linkText = $(el).text().replace(/\s+/g, ' ').trim();
    if (!rawHref || rawHref.startsWith('#') || linkText.length < 2) {
      return;
    }

    let resolvedUrl: string;
    try {
      const resolved = new URL(rawHref, pageUrl);
      if (!FOLLOWABLE.has(resolved.protocol)) return;
      resolvedUrl = resolved.toString();
    } catch {
      return;
    }

    const isAffiliate = AFFILIATE_MARKERS.some((rx) => rx.test(resolvedUrl));
    if (isAffiliate) {
      affiliateLinksDisarmed += 1;
    }

    const { cleanUrl, strippedParams } = stripTrackingFromUrl(resolvedUrl);
    trackingParamsStripped += strippedParams.length;

    if (seenLinkUrls.has(cleanUrl)) return;
    seenLinkUrls.add(cleanUrl);

    const linkDomainInfo = extractDomainInfo(cleanUrl);
    const primaryLabel = classifyPrimarySourceLink(cleanUrl, linkDomainInfo.domain);

    let kind: ExtractedPageLink['kind'] = 'external';
    if (isAffiliate) {
      kind = 'affiliate-or-tracker';
    } else if (primaryLabel && linkDomainInfo.rootDomain !== rootDomain) {
      kind = 'primary-source';
    } else if (
      INDIE_HOST_PATTERNS.some((rx) => rx.test(linkDomainInfo.domain)) ||
      linkDomainInfo.domain.endsWith('.org')
    ) {
      kind = 'reference';
    } else if (linkDomainInfo.rootDomain !== rootDomain) {
      kind = 'indie';
    }

    const linkObj: ExtractedPageLink = {
      text: linkText.slice(0, 110),
      url: cleanUrl,
      domain: linkDomainInfo.domain,
      kind,
      sourceTypeLabel: primaryLabel,
      strippedParams,
    };

    if (kind === 'primary-source' && primarySources.length < 16) {
      primarySources.push(linkObj);
    }

    if (extractedLinks.length < 45) {
      extractedLinks.push(linkObj);
    }
  });

  // Strip clutter from DOM
  $(CLUTTER_SELECTORS.join(', ')).remove();

  let contentRoot = $(
    'main, article, [role="main"], .post-content, .article-content, .entry-content, #content'
  ).first();
  if (contentRoot.length === 0 || contentRoot.text().trim().length < 180) {
    contentRoot = $('body').first();
  }

  const sections: CleanedContentSection[] = [];
  const allAiPhrases = new Set<string>();
  const allSeoPatterns = new Set<string>();

  for (const rule of SEO_LISTICLE_PATTERNS) {
    if (rule.pattern.test(normalizeQuotes(title))) {
      allSeoPatterns.add(rule.label);
    }
  }

  let currentHeading: string | undefined;
  let seenSubstantiveSection = false;
  let sectionIndex = 0;

  const blockNodes = contentRoot.find('h1, h2, h3, p, pre, blockquote, ul, ol, table');
  blockNodes.each((_, el) => {
    const tagName = (el.tagName || 'p').toLowerCase();
    if (tagName === 'p' && $(el).parents('blockquote, li, td, th').length > 0) {
      return;
    }

    const rawText = $(el).text().replace(/\s+/g, ' ').trim();
    if (!rawText || rawText.length < 15) {
      return;
    }

    if (tagName === 'h1' || tagName === 'h2' || tagName === 'h3') {
      currentHeading = rawText;
      sections.push({
        id: `sec-${sectionIndex++}`,
        heading: rawText,
        tag: tagName as 'h1' | 'h2' | 'h3',
        text: rawText,
        isFluffPreamble: false,
        isCoreAnswer: false,
        wordCount: rawText.split(/\s+/).length,
        fluffTriggers: [],
      });
      return;
    }

    const wordCount = rawText.split(/\s+/).length;
    const fluffTriggers: string[] = [];
    const matchText = normalizeQuotes(rawText);

    for (const aiRule of AI_SLOP_PHRASES) {
      if (aiRule.pattern.test(matchText)) {
        fluffTriggers.push(aiRule.label);
        allAiPhrases.add(aiRule.label);
      }
    }

    for (const seoRule of SEO_LISTICLE_PATTERNS) {
      if (seoRule.pattern.test(matchText)) {
        fluffTriggers.push(seoRule.label);
        allSeoPatterns.add(seoRule.label);
      }
    }

    const matchesPreambleFluff = FLUFF_PREAMBLE_PATTERNS.some((rx) => rx.test(matchText));
    const isSponsoredCallout =
      /\b(?:we may earn a commission|sponsored by|partner offer|affiliate link|check price on amazon)\b/i.test(
        rawText
      );
    const isEarlySection = sectionIndex <= 5 && !seenSubstantiveSection;
    const isFluffPreamble =
      tagName === 'p' &&
      ((isEarlySection && matchesPreambleFluff) || isSponsoredCallout || fluffTriggers.length >= 2);

    const hasConcreteSignal =
      tagName === 'pre' ||
      tagName === 'table' ||
      /\b(\d+%|\d+\s*(?:ms|kb|mb|gb|hz|sec|min|grams|tbsp|tsp)|`[^`]+`|https?:\/\/|step\s+\d+|therefore|specifically)\b/i.test(
        rawText
      );

    if (hasConcreteSignal && !isFluffPreamble && wordCount >= 12) {
      seenSubstantiveSection = true;
    }

    const normalizedTag: CleanedContentSection['tag'] =
      tagName === 'ol'
        ? 'ul'
        : ['p', 'pre', 'blockquote', 'ul', 'table'].includes(tagName)
        ? (tagName as CleanedContentSection['tag'])
        : 'p';

    sections.push({
      id: `sec-${sectionIndex++}`,
      heading: currentHeading,
      tag: normalizedTag,
      text: tagName === 'pre' ? $(el).text().trim() : rawText,
      isFluffPreamble,
      isSponsoredCallout,
      isCoreAnswer: Boolean(hasConcreteSignal && !isFluffPreamble && wordCount >= 18),
      wordCount,
      fluffTriggers,
    });
  });

  if (sections.length === 0) {
    const fallbackText = contentRoot.text().replace(/\s+/g, ' ').trim();
    if (fallbackText) {
      sections.push({
        id: 'sec-0',
        tag: 'p',
        text: fallbackText,
        isFluffPreamble: false,
        isCoreAnswer: true,
        wordCount: fallbackText.split(/\s+/).length,
        fluffTriggers: [],
      });
    }
  }

  if (!sections.some((s) => s.isCoreAnswer)) {
    const candidate = sections.find(
      (s) => !s.isFluffPreamble && s.tag !== 'h1' && s.tag !== 'h2' && s.wordCount >= 15
    );
    if (candidate) {
      candidate.isCoreAnswer = true;
    }
  }

  const coreSections = sections.filter((s) => s.isCoreAnswer && !s.isFluffPreamble);
  const coreTakeaway =
    coreSections
      .slice(0, 2)
      .map((s) => s.text)
      .join(' ')
      .slice(0, 480) ||
    sections
      .filter((s) => !s.isFluffPreamble && s.tag === 'p')
      .slice(0, 2)
      .map((s) => s.text)
      .join(' ')
      .slice(0, 480) ||
    title;

  const cleanTextCombined = sections.map((s) => s.text).join('\n\n');
  const cleanTextBytes = Buffer.byteLength(cleanTextCombined, 'utf8');
  const bloatReductionPercent =
    rawHtmlBytes > 0
      ? Math.max(0, Math.min(99, Math.round(((rawHtmlBytes - cleanTextBytes) / rawHtmlBytes) * 100)))
      : 0;

  const totalWords = sections.reduce((acc, s) => acc + s.wordCount, 0);
  const fluffWords = sections
    .filter((s) => s.isFluffPreamble)
    .reduce((acc, s) => acc + s.wordCount, 0);

  const estimatedRawReadMinutes = Math.max(1, Math.ceil((totalWords + totalScriptsRemoved * 15) / 220));
  const estimatedCleanReadMinutes = Math.max(1, Math.ceil(Math.max(1, totalWords - fluffWords) / 220));
  const fluffPreambleParagraphs = sections.filter((s) => s.isFluffPreamble).length;

  const baseScored = scoreSearchResult({
    title,
    url: pageUrl,
    snippet: cleanTextCombined.slice(0, 800),
    source: 'web',
    publishedAt: publishedDate,
  });

  const extraSignals: SignalHit[] = [...baseScored.signals];
  let adjustedSlop = baseScored.slopScore;
  let adjustedAuth = baseScored.authenticityScore;

  if (primarySources.length > 0) {
    const boost = Math.min(24, primarySources.length * 6);
    adjustedAuth += boost;
    extraSignals.push({
      id: 'cites-primary-sources',
      label: `Cites ${primarySources.length} Primary Source${primarySources.length > 1 ? 's' : ''}`,
      delta: boost,
      category: 'primary',
    });
  }

  if (trackersFound.size === 0 && totalScriptsRemoved <= 2) {
    adjustedAuth += 22;
    adjustedSlop = Math.max(0, adjustedSlop - 12);
    extraSignals.push({
      id: 'zero-trackers-minimal-js',
      label: `Zero Ad-Trackers (${totalScriptsRemoved} scripts)`,
      delta: 22,
      category: 'indie',
    });
  } else if (trackersFound.size >= 3) {
    const penalty = Math.min(35, trackersFound.size * 7);
    adjustedSlop += penalty;
    adjustedAuth -= 12;
    extraSignals.push({
      id: 'heavy-surveillance-trackers',
      label: `${trackersFound.size} Surveillance Trackers Stripped`,
      delta: -penalty,
      category: 'seo-slop',
      detail: Array.from(trackersFound).slice(0, 5).join(', '),
    });
  }

  if (affiliateLinksDisarmed > 0 || sponsoredBlocksRemoved > 0) {
    const penalty = Math.min(40, affiliateLinksDisarmed * 8 + sponsoredBlocksRemoved * 6);
    adjustedSlop += penalty;
    extraSignals.push({
      id: 'affiliate-links-disarmed',
      label: `${affiliateLinksDisarmed} Affiliate Links & ${sponsoredBlocksRemoved} Ad Blocks Disarmed`,
      delta: -penalty,
      category: 'sponsored',
    });
  }

  if (hasRssFeed) {
    adjustedAuth += 12;
    extraSignals.push({
      id: 'has-rss-feed',
      label: 'Open RSS/Atom Feed',
      delta: 12,
      category: 'indie',
    });
  }

  if (isStaticGenerator && generator) {
    adjustedAuth += 14;
    extraSignals.push({
      id: 'indie-static-generator',
      label: `Static Indie Generator (${generator})`,
      delta: 14,
      category: 'indie',
    });
  }

  if (fluffPreambleParagraphs >= 2) {
    adjustedSlop += 18;
    extraSignals.push({
      id: 'fluff-preamble-detected',
      label: `${fluffPreambleParagraphs} SEO Preamble Fluff Blocks Collapsed`,
      delta: -18,
      category: 'ai-fluff',
    });
  }

  const finalSlopScore = Math.max(0, Math.min(100, Math.round(adjustedSlop)));
  const finalAuthScore = Math.max(0, Math.min(100, Math.round(adjustedAuth)));

  let verdict = baseScored.verdict;
  if (finalSlopScore >= 60) verdict = 'slop-farm';
  else if (finalSlopScore >= 40 && finalAuthScore < 55) verdict = 'seo-suspect';
  else if (hasIndieWebMarkers && finalAuthScore >= 65 && finalSlopScore < 35) verdict = 'indie-gem';
  else if (finalAuthScore >= 60 && finalSlopScore < 35) verdict = 'human-signal';

  return {
    url: pageUrl,
    title,
    domain,
    byline,
    publishedDate,
    generator,
    hasRssFeed,
    rssFeedUrl,
    hasIndieWebMarkers,
    verdict,
    slopScore: finalSlopScore,
    authenticityScore: finalAuthScore,
    signals: extraSignals,
    stats: {
      rawHtmlBytes,
      cleanTextBytes,
      bloatReductionPercent,
      totalScriptsRemoved,
      trackersBlocked: Array.from(trackersFound),
      sponsoredBlocksRemoved,
      affiliateLinksDisarmed,
      trackingParamsStripped,
      primarySourcesFound: primarySources.length,
      aiPhrasesDetected: Array.from(allAiPhrases),
      seoPatternsDetected: Array.from(allSeoPatterns),
      estimatedRawReadMinutes,
      estimatedCleanReadMinutes,
      fluffPreambleParagraphs,
    },
    coreTakeaway,
    primarySources,
    sections,
    links: extractedLinks,
  };
}
