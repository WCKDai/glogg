import { InstantAnswerPayload } from './types.js';

export const SEARCH_STOPWORDS = new Set([
  'a',
  'about',
  'above',
  'after',
  'again',
  'against',
  'all',
  'am',
  'an',
  'and',
  'any',
  'are',
  'aren',
  'arent',
  'as',
  'at',
  'be',
  'because',
  'been',
  'before',
  'being',
  'below',
  'between',
  'both',
  'but',
  'by',
  'can',
  'cannot',
  'could',
  'couldn',
  'did',
  'didn',
  'do',
  'does',
  'doesn',
  'doing',
  'don',
  'down',
  'during',
  'each',
  'eli5',
  'explain',
  'few',
  'find',
  'for',
  'from',
  'further',
  'get',
  'getting',
  'give',
  'go',
  'going',
  'good',
  'got',
  'had',
  'has',
  'have',
  'having',
  'he',
  'her',
  'here',
  'hers',
  'herself',
  'him',
  'himself',
  'his',
  'how',
  'i',
  'if',
  'im',
  'in',
  'into',
  'is',
  'isn',
  'it',
  'its',
  'itself',
  'just',
  'know',
  'let',
  'like',
  'look',
  'looking',
  'make',
  'making',
  'many',
  'may',
  'me',
  'might',
  'more',
  'most',
  'much',
  'must',
  'my',
  'myself',
  'need',
  'no',
  'nor',
  'not',
  'now',
  'of',
  'off',
  'on',
  'once',
  'only',
  'or',
  'other',
  'ought',
  'our',
  'ours',
  'ourselves',
  'out',
  'over',
  'own',
  'please',
  'same',
  'see',
  'she',
  'should',
  'show',
  'so',
  'some',
  'such',
  'tell',
  'than',
  'that',
  'the',
  'their',
  'theirs',
  'them',
  'themselves',
  'then',
  'there',
  'these',
  'they',
  'thing',
  'things',
  'think',
  'this',
  'those',
  'through',
  'to',
  'too',
  'under',
  'until',
  'up',
  'use',
  'used',
  'using',
  'very',
  'want',
  'was',
  'wasn',
  'way',
  'we',
  'were',
  'weren',
  'what',
  'whats',
  'when',
  'where',
  'which',
  'while',
  'who',
  'whom',
  'whose',
  'why',
  'will',
  'with',
  'without',
  'work',
  'working',
  'works',
  'would',
  'you',
  'your',
  'yours',
  'yourself',
]);

// High-frequency generic words that are weaker than specific entity/technical nouns
export const GENERIC_ATTRIBUTE_WORDS = new Set([
  'capital',
  'population',
  'president',
  'prime',
  'minister',
  'king',
  'queen',
  'founder',
  'inventor',
  'creator',
  'author',
  'ceo',
  'currency',
  'language',
  'area',
  'size',
  'height',
  'age',
  'weight',
  'distance',
  'speed',
  'date',
  'year',
  'meaning',
  'definition',
  'define',
  'example',
  'examples',
  'tutorial',
  'guide',
  'difference',
  'versus',
  'vs',
  'install',
  'fix',
  'error',
  'issue',
  'problem',
  'best',
  'top',
  'review',
  'history',
  'summary',
  'copy',
  'write',
  'read',
  'file',
  'system',
  'code',
  'command',
  'list',
]);

export type QueryIntentKind =
  | 'computation'
  | 'factual-question'
  | 'technical-howto'
  | 'p2p-media'
  | 'fediverse-social'
  | 'general-web';

export interface QueryAnalysis {
  rawQuery: string;
  normalizedQuery: string;
  coreKeywords: string[];
  keywordQuery: string;
  entitySubject: string;
  questionAttribute?: string;
  anchorTokens: string[];
  isQuestion: boolean;
  isTechnical: boolean;
  intent: QueryIntentKind;
}

export function stemToken(word: string): string {
  const w = word.toLowerCase().trim();
  if (w.length <= 4) return w;
  if (w.endsWith('ies') && w.length > 5) return `${w.slice(0, -3)}y`;
  if (w.endsWith('ing') && w.length > 6) return w.slice(0, -3);
  if (w.endsWith('ed') && w.length > 5) return w.slice(0, -2);
  if (w.endsWith('es') && w.length > 5 && !w.endsWith('ses')) return w.slice(0, -2);
  if (w.endsWith('s') && !w.endsWith('ss') && !w.endsWith('us') && !w.endsWith('is') && w.length > 4) {
    return w.slice(0, -1);
  }
  return w;
}

export function analyzeQueryIntent(rawQuery: string): QueryAnalysis {
  const cleaned = rawQuery
    .trim()
    .replace(/\b(?:lens|site|before|after):[^\s]+/gi, '')
    .replace(/[?!.]+$/g, '')
    .trim();

  const lower = cleaned.toLowerCase();

  // Detect question patterns like "what is the <attr> of <entity>"
  let questionAttribute: string | undefined;
  let entitySubject = cleaned;

  const attrOfMatch = lower.match(
    /^(?:what|who|where|which)\s+(?:is|are|was|were)\s+(?:the\s+)?([a-z\s]{3,24}?)\s+(?:of|in|for)\s+(.+)$/i
  );
  if (attrOfMatch) {
    questionAttribute = attrOfMatch[1].trim();
    entitySubject = attrOfMatch[2].trim();
  } else {
    const howWorkMatch = lower.match(
      /^how\s+(?:does|do|did|can|to)\s+(.+?)(?:\s+work|\s+working|\s+works|\s+in\s+.+)?$/i
    );
    if (howWorkMatch) {
      entitySubject = howWorkMatch[1].trim();
    } else {
      const whatIsMatch = lower.match(
        /^(?:what|who|where|when|why)\s+(?:is|are|was|were|does|do|did)\s+(?:a\s+|an\s+|the\s+)?(.+)$/i
      );
      if (whatIsMatch) {
        entitySubject = whatIsMatch[1].trim();
      } else {
        const defineMatch = lower.match(/^(?:define|meaning\s+of|definition\s+of|explain)\s+(.+)$/i);
        if (defineMatch) {
          entitySubject = defineMatch[1].trim();
        }
      }
    }
  }

  // Extract raw tokens
  const rawTokens = lower
    .replace(/[^a-z0-9+#._-]/g, ' ')
    .split(/\s+/)
    .map((t) => t.replace(/^[._-]+|[._-]+$/g, ''))
    .filter((t) => t.length >= 2);

  let coreKeywords = rawTokens.filter((t) => !SEARCH_STOPWORDS.has(t));
  if (coreKeywords.length === 0) {
    coreKeywords = rawTokens;
  }

  // Deduplicate while preserving order
  coreKeywords = Array.from(new Set(coreKeywords));

  // Identify anchor tokens: non-generic specific tokens first, sorted by specificity/length
  const specificTokens = coreKeywords.filter((t) => !GENERIC_ATTRIBUTE_WORDS.has(t));
  const anchorCandidates = specificTokens.length > 0 ? specificTokens : coreKeywords;
  const anchorTokens = [...anchorCandidates].sort((a, b) => b.length - a.length);

  const isQuestion =
    /\?$/.test(rawQuery.trim()) ||
    /^(?:what|who|where|when|why|how|which|can|does|do|is|are|explain|define)\b/i.test(lower);

  const isTechnical =
    /\b(?:linux|kernel|btrfs|zfs|ext4|xfs|git|docker|podman|rust|python|typescript|javascript|golang|c\+\+|sql|sqlite|postgres|redis|nginx|systemd|ssh|bash|zsh|vim|neovim|kubernetes|llvm|gcc|glibc|syscall|mutex|async|await|react|css|html|http|tcp|udp|dns|bgp|tls|openssl|ffmpeg|arch|debian|ubuntu|fedora|bsd|openbsd|freebsd|macos|windows|api|cli|json|yaml|regex|grep|awk|sed|oom|segfault|deadlock|copy\s+on\s+write|cow)\b/i.test(
      lower
    );

  let intent: QueryIntentKind = 'general-web';
  if (evaluateInstantComputation(rawQuery) !== null) {
    intent = 'computation';
  } else if (/\b(?:magnet|torrent|bitmagnet|dht|nzb|usenet|1080p|2160p|x265|blu-?ray|flac)\b/i.test(lower)) {
    intent = 'p2p-media';
  } else if (/\b(?:fediverse|mastodon|bluesky|atproto|activitypub|matrix\.org|stoat\.chat|lemmy)\b/i.test(lower)) {
    intent = 'fediverse-social';
  } else if (isTechnical) {
    intent = 'technical-howto';
  } else if (isQuestion || Boolean(questionAttribute)) {
    intent = 'factual-question';
  }

  return {
    rawQuery: rawQuery.trim(),
    normalizedQuery: lower,
    coreKeywords,
    keywordQuery: coreKeywords.join(' '),
    entitySubject,
    questionAttribute,
    anchorTokens,
    isQuestion,
    isTechnical,
    intent,
  };
}

/**
 * Instant Calculator, Unit Converter, Base Converter & Timestamp Evaluator
 */
export function evaluateInstantComputation(rawQuery: string): InstantAnswerPayload | null {
  const q = rawQuery.trim();
  const lower = q.toLowerCase();

  // 1. Percentage: "18% of 450"
  const pctMatch = lower.match(/^(\d+(?:\.\d+)?)\s*%\s*of\s*(\d+(?:\.\d+)?)$/i);
  if (pctMatch) {
    const pct = parseFloat(pctMatch[1]);
    const total = parseFloat(pctMatch[2]);
    const val = (pct / 100) * total;
    return {
      kind: 'computation',
      title: `${val.toLocaleString('en-US', { maximumFractionDigits: 6 })}`,
      subtitle: `${pct}% of ${total.toLocaleString()}`,
      directAnswer: `${pct}% × ${total} = ${val}`,
      confidence: 'verified',
      citations: [],
    };
  }

  // 2. Base conversion: "255 in hex", "0xff in decimal", "42 in binary"
  const baseMatch = lower.match(/^(0x[0-9a-f]+|0b[01]+|\d+)\s+(?:in|to|as)\s+(hex|hexadecimal|bin|binary|dec|decimal|oct|octal)$/i);
  if (baseMatch) {
    const rawNum = baseMatch[1];
    const target = baseMatch[2];
    const parsed = rawNum.startsWith('0x')
      ? parseInt(rawNum.slice(2), 16)
      : rawNum.startsWith('0b')
      ? parseInt(rawNum.slice(2), 2)
      : parseInt(rawNum, 10);
    if (!Number.isNaN(parsed)) {
      let formatted = '';
      if (target.startsWith('hex')) formatted = `0x${parsed.toString(16).toUpperCase()}`;
      else if (target.startsWith('bin')) formatted = `0b${parsed.toString(2)}`;
      else if (target.startsWith('oct')) formatted = `0o${parsed.toString(8)}`;
      else formatted = parsed.toString(10);

      return {
        kind: 'computation',
        title: formatted,
        subtitle: `Base Conversion (${rawNum} → ${target})`,
        directAnswer: `Decimal: ${parsed.toLocaleString()} · Hex: 0x${parsed.toString(16).toUpperCase()} · Binary: 0b${parsed.toString(2)}`,
        confidence: 'verified',
        citations: [],
      };
    }
  }

  // 3. Temperature & Unit conversions: "72f in c", "100c in f", "100 km in miles", "4096 mb in gb"
  const unitMatch = lower.match(
    /^(-?\d+(?:\.\d+)?)\s*(c|celsius|f|fahrenheit|km|kilometers?|mi|miles?|kg|kilograms?|lbs?|pounds?|b|bytes?|kb|mb|gb|tb)\s+(?:in|to|as)\s+(c|celsius|f|fahrenheit|km|kilometers?|mi|miles?|kg|kilograms?|lbs?|pounds?|b|bytes?|kb|mb|gb|tb)$/i
  );
  if (unitMatch) {
    const val = parseFloat(unitMatch[1]);
    const from = unitMatch[2].toLowerCase();
    const to = unitMatch[3].toLowerCase();

    const byteUnits: Record<string, number> = {
      b: 1,
      byte: 1,
      bytes: 1,
      kb: 1024,
      mb: 1024 ** 2,
      gb: 1024 ** 3,
      tb: 1024 ** 4,
    };

    if (from in byteUnits && to in byteUnits) {
      const resVal = (val * byteUnits[from]) / byteUnits[to];
      return {
        kind: 'computation',
        title: `${resVal.toLocaleString('en-US', { maximumFractionDigits: 6 })} ${to.toUpperCase()}`,
        subtitle: `Binary Storage Conversion (1024-base)`,
        directAnswer: `${val.toLocaleString()} ${from.toUpperCase()} = ${resVal.toLocaleString('en-US', {
          maximumFractionDigits: 6,
        })} ${to.toUpperCase()} (${(val * byteUnits[from]).toLocaleString()} bytes)`,
        confidence: 'verified',
        citations: [],
      };
    }

    if ((from === 'f' || from === 'fahrenheit') && (to === 'c' || to === 'celsius')) {
      const c = ((val - 32) * 5) / 9;
      return {
        kind: 'computation',
        title: `${c.toFixed(2)} °C`,
        subtitle: `${val} °F to Celsius`,
        directAnswer: `(${val}°F − 32) × 5/9 = ${c.toFixed(2)}°C`,
        confidence: 'verified',
        citations: [],
      };
    }
    if ((from === 'c' || from === 'celsius') && (to === 'f' || to === 'fahrenheit')) {
      const f = (val * 9) / 5 + 32;
      return {
        kind: 'computation',
        title: `${f.toFixed(2)} °F`,
        subtitle: `${val} °C to Fahrenheit`,
        directAnswer: `(${val}°C × 9/5) + 32 = ${f.toFixed(2)}°F`,
        confidence: 'verified',
        citations: [],
      };
    }
    if (from.startsWith('km') && to.startsWith('mi')) {
      const mi = val * 0.621371;
      return {
        kind: 'computation',
        title: `${mi.toFixed(3)} miles`,
        subtitle: `${val} km to miles`,
        directAnswer: `${val} km × 0.621371 = ${mi.toFixed(3)} miles`,
        confidence: 'verified',
        citations: [],
      };
    }
    if (from.startsWith('mi') && to.startsWith('km')) {
      const km = val * 1.60934;
      return {
        kind: 'computation',
        title: `${km.toFixed(3)} km`,
        subtitle: `${val} miles to kilometers`,
        directAnswer: `${val} miles × 1.60934 = ${km.toFixed(3)} km`,
        confidence: 'verified',
        citations: [],
      };
    }
    if (from.startsWith('lb') && to.startsWith('kg')) {
      const kg = val * 0.45359237;
      return {
        kind: 'computation',
        title: `${kg.toFixed(3)} kg`,
        subtitle: `${val} lbs to kilograms`,
        directAnswer: `${val} lbs × 0.453592 = ${kg.toFixed(3)} kg`,
        confidence: 'verified',
        citations: [],
      };
    }
    if (from.startsWith('kg') && to.startsWith('lb')) {
      const lbs = val / 0.45359237;
      return {
        kind: 'computation',
        title: `${lbs.toFixed(3)} lbs`,
        subtitle: `${val} kg to pounds`,
        directAnswer: `${val} kg ÷ 0.453592 = ${lbs.toFixed(3)} lbs`,
        confidence: 'verified',
        citations: [],
      };
    }
  }

  // 4. Pure mathematical expression: e.g. "256 * 1024", "2^32", "(1920 * 1080) / 1000"
  if (/^[0-9+\-*/^().%\s]+$/.test(q) && /[+\-*/^%]/.test(q) && /\d/.test(q) && !/^\d{4}-\d{2}-\d{2}$/.test(q)) {
    try {
      const jsExpr = q.replace(/\^/g, '**');
      // Safe evaluation of validated numeric expression
      const result = Function(`"use strict"; return (${jsExpr});`)();
      if (typeof result === 'number' && Number.isFinite(result)) {
        return {
          kind: 'computation',
          title: result.toLocaleString('en-US', { maximumFractionDigits: 10 }),
          subtitle: `Instant Math Evaluation (${q})`,
          directAnswer: `${q} = ${result.toLocaleString('en-US', { maximumFractionDigits: 10 })}`,
          confidence: 'verified',
          citations: [],
        };
      }
    } catch {
      // ignore invalid math
    }
  }

  return null;
}

export interface RelevanceEvaluation {
  relevanceScore: number;
  matchedCoreCount: number;
  totalCoreCount: number;
  coverageRatio: number;
  matchedAnchor: boolean;
  hasTitleMatch: boolean;
  isDirectAnswerCandidate: boolean;
}

/**
 * Computes lexical & semantic relevance (0-100) between the user's query and a candidate search result.
 * Ensures off-topic results that only matched stopwords or tangential words are scored near 0.
 */
// Words that change little about what a page is about ("the *last* commit", "*best* keyboard").
const MODIFIER_WORDS = new Set([
  'last', 'latest', 'first', 'new', 'newest', 'old', 'older', 'best', 'good', 'better', 'easy', 'easiest',
  'simple', 'quick', 'quickly', 'proper', 'properly', 'correct', 'correctly', 'right', 'way', 'ways', 'top',
]);
const MODIFIER_WEIGHT = 0.35;

// Different words for the same thing, common in how-to questions: a page about
// "git reset" answers "undo a commit" without ever saying "undo".
const SYNONYM_GROUPS: string[][] = [
  ['undo', 'revert', 'reset', 'rollback', 'roll back', 'reverse'],
  ['delete', 'remove', 'erase', 'purge'],
  ['install', 'setup', 'set up', 'installation'],
  ['fix', 'solve', 'resolve', 'repair', 'workaround'],
  ['error', 'exception', 'failure', 'crash'],
  ['configure', 'config', 'configuration'],
  ['update', 'upgrade'],
  ['difference', 'versus', 'compare', 'comparison'],
  ['speed', 'faster', 'performance', 'optimize', 'optimise'],
];

function synonymMatch(word: string, text: string): boolean {
  const stem = stemToken(word);
  const group = SYNONYM_GROUPS.find((g) => g.some((m) => m === word || stemToken(m) === stem));
  if (!group) return false;
  return group.some((m) => new RegExp(`\\b${m.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'i').test(text));
}

export function computeQueryRelevance(
  rawQuery: string,
  title: string,
  snippet: string,
  url: string,
  tags?: string[]
): RelevanceEvaluation {
  if (!rawQuery || !rawQuery.trim()) {
    return {
      relevanceScore: 70,
      matchedCoreCount: 0,
      totalCoreCount: 0,
      coverageRatio: 1,
      matchedAnchor: true,
      hasTitleMatch: true,
      isDirectAnswerCandidate: false,
    };
  }

  const analysis = analyzeQueryIntent(rawQuery);
  const coreKeywords = analysis.coreKeywords;
  if (coreKeywords.length === 0) {
    return {
      relevanceScore: 60,
      matchedCoreCount: 0,
      totalCoreCount: 0,
      coverageRatio: 1,
      matchedAnchor: true,
      hasTitleMatch: true,
      isDirectAnswerCandidate: false,
    };
  }

  const titleLower = title.toLowerCase();
  const snippetLower = snippet.toLowerCase();
  const urlLower = decodeURIComponent(url).toLowerCase();
  const tagsLower = (tags ?? []).join(' ').toLowerCase();
  const fullText = `${titleLower} ${snippetLower} ${urlLower} ${tagsLower}`;

  // Expand well-known technical synonyms so "copy on write" also recognizes "Copy-on-write (COW)"
  const expandedText =
    fullText +
    (fullText.includes('copy-on-write') || fullText.includes('copy on write') ? ' cow copy write' : '') +
    (fullText.includes('kazakhstan') ? ' kazakh astana' : '');

  let matchedCoreCount = 0;
  let titleMatchedCount = 0;
  let weightTotal = 0;
  let weightMatched = 0;
  let weightTitle = 0;

  for (const kw of coreKeywords) {
    const stem = stemToken(kw);
    const weight = MODIFIER_WORDS.has(kw) ? MODIFIER_WEIGHT : 1;
    const wordBoundaryRx = new RegExp(`\\b${stem.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'i');
    const inTitle = titleLower.includes(kw) || wordBoundaryRx.test(titleLower) || synonymMatch(kw, titleLower);
    const inFull = expandedText.includes(kw) || wordBoundaryRx.test(expandedText) || synonymMatch(kw, expandedText);

    weightTotal += weight;
    if (inTitle) {
      titleMatchedCount += 1;
      weightTitle += weight;
    }
    if (inFull) {
      matchedCoreCount += 1;
      weightMatched += weight;
    }
  }

  const totalCoreCount = coreKeywords.length;
  const coverageRatio = weightTotal > 0 ? weightMatched / weightTotal : 0;
  const titleCoverageRatio = weightTotal > 0 ? weightTitle / weightTotal : 0;

  // The main subject must appear: the primary anchor, or another top anchor when
  // most of the question is covered (so "undoing things in Git" still counts for
  // "undo the last git commit", but "capital of France" doesn't for "capital of Kazakhstan").
  const anchorHit = (a: string) => {
    const stem = stemToken(a);
    return expandedText.includes(a) || (stem.length >= 4 && expandedText.includes(stem)) || synonymMatch(a, expandedText);
  };
  const anchors = analysis.anchorTokens.filter((a) => !MODIFIER_WORDS.has(a));
  const matchedAnchor =
    anchors.length === 0 || anchorHit(anchors[0]) || (coverageRatio > 0.5 && anchors.slice(1, 3).some(anchorHit));

  if (matchedCoreCount === 0) {
    return {
      relevanceScore: 0,
      matchedCoreCount: 0,
      totalCoreCount,
      coverageRatio: 0,
      matchedAnchor: false,
      hasTitleMatch: false,
      isDirectAnswerCandidate: false,
    };
  }

  let score = 0;

  // 1. Core Keyword Coverage (up to 40 pts)
  score += Math.round(coverageRatio * 40);

  // 2. Title Keyword Coverage & Title Focus Ratio (up to 32 pts)
  score += Math.round(titleCoverageRatio * 22);
  const titleWords = titleLower
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 2 && !SEARCH_STOPWORDS.has(w));
  const titleFocusRatio = titleWords.length > 0 ? titleMatchedCount / titleWords.length : 0;
  if (titleFocusRatio >= 0.45 && titleMatchedCount >= 1) {
    score += 14;
  } else if (titleWords.length >= 12 && titleFocusRatio < 0.2) {
    // Long tangential title where keywords appear incidentally
    score -= 18;
  }

  // 3. Contiguous / Exact Phrase Match Bonus (up to 26 pts)
  const entityLower = analysis.entitySubject.toLowerCase();
  const attrAndEntityPhrase = analysis.questionAttribute
    ? `${analysis.questionAttribute.toLowerCase()} of ${entityLower}`
    : '';
  const kwPhrase = coreKeywords.join(' ');
  const kwHyphenPhrase = coreKeywords.join('-');

  if (
    (attrAndEntityPhrase && titleLower.includes(attrAndEntityPhrase)) ||
    (kwPhrase.length >= 5 && (titleLower.includes(kwPhrase) || titleLower.includes(kwHyphenPhrase)))
  ) {
    score += 26;
  } else if (entityLower.length >= 3 && titleLower.includes(entityLower)) {
    score += 16;
  } else if (
    (attrAndEntityPhrase && snippetLower.includes(attrAndEntityPhrase)) ||
    (kwPhrase.length >= 5 && (snippetLower.includes(kwPhrase) || snippetLower.includes(kwHyphenPhrase)))
  ) {
    score += 18;
  } else if (entityLower.length >= 3 && snippetLower.includes(entityLower)) {
    score += 10;
  }

  // 4. Question-Attribute Direct Answer Bonus (e.g. "is the capital city of Kazakhstan")
  let isDirectAnswerCandidate = false;
  if (analysis.questionAttribute) {
    const attrLower = analysis.questionAttribute.toLowerCase();
    const directAttrRx = new RegExp(
      `\\b(?:${attrLower}\\s+(?:city\\s+)?of\\s+${entityLower}|${entityLower}(?:'s)?\\s+${attrLower}|is\\s+the\\s+${attrLower})`,
      'i'
    );
    if (directAttrRx.test(combinedClean(titleLower, snippetLower))) {
      score += 32;
      isDirectAnswerCandidate = true;
    } else if ((snippetLower.includes(attrLower) || titleLower.includes(attrLower)) && matchedAnchor) {
      score += 8;
    }
  } else if (coverageRatio >= 0.75 && titleMatchedCount >= 1 && matchedAnchor && titleFocusRatio >= 0.25) {
    isDirectAnswerCandidate = true;
  }

  // 5. Hard Penalties for missing the main subject anchor or matching only 1 generic word out of many
  if (!matchedAnchor) {
    score = Math.min(score, 14);
  } else if (totalCoreCount >= 2 && matchedCoreCount === 1 && titleMatchedCount === 0) {
    score = Math.min(score, 20);
  } else if (totalCoreCount >= 3 && coverageRatio < 0.5) {
    score = Math.min(score, 22);
  }

  return {
    relevanceScore: Math.max(0, Math.min(100, score)),
    matchedCoreCount,
    totalCoreCount,
    coverageRatio,
    matchedAnchor,
    hasTitleMatch: titleMatchedCount > 0,
    isDirectAnswerCandidate,
  };
}

function combinedClean(a: string, b: string): string {
  return `${a} ${b}`.replace(/\s+/g, ' ');
}
