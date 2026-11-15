import { InstantAnswerPayload } from './types.js';

export const SEARCH_STOPWORDS = /* @__PURE__ */ new Set([
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
export const GENERIC_ATTRIBUTE_WORDS = /* @__PURE__ */ new Set([
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

/** The last query analysed: ranking asks once per result, always about the same query. */
let lastAnalysis: { query: string; analysis: QueryAnalysis } | undefined;

export function analyzeQueryIntent(rawQuery: string): QueryAnalysis {
  if (lastAnalysis?.query === rawQuery) return lastAnalysis.analysis;
  const analysis = analyzeQuery(rawQuery);
  lastAnalysis = { query: rawQuery, analysis };
  return analysis;
}

function anchorSpecWeight(token: string): number {
  let w = token.length;
  // Identifiers with digits/hyphens/symbols (HL-L2350DW, C++, ipv6) are ultra-specific anchors; -ing/-ed participles are weaker than nouns.
  if (/[\d+#._-]/.test(token)) w += 4;
  else if (token.length >= 6 && /(?:ing|ed)$/.test(token)) w -= 3;
  return w;
}

function analyzeQuery(rawQuery: string): QueryAnalysis {
  const cleaned = rawQuery
    .trim()
    .replace(/\b(?:lens|site|before|after):[^\s]+/gi, '')
    .replace(/[?!.]+$/g, '')
    .trim();

  const lower = cleaned.toLowerCase().normalize('NFC');

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
    .replace(/[^\p{L}\p{M}\p{N}+#._-]/gu, ' ')
    .split(/\s+/)
    .map((t) => t.replace(/^[._-]+|[._-]+$/g, ''))
    .filter((t) => t.length >= 2 || /[^\x00-\x7f]/.test(t));

  let coreKeywords = rawTokens.filter((t) => !SEARCH_STOPWORDS.has(t));
  if (coreKeywords.length === 0) {
    coreKeywords = rawTokens;
  }

  // Deduplicate while preserving order
  coreKeywords = Array.from(new Set(coreKeywords));

  // Identify anchor tokens: non-generic specific tokens first, sorted by specificity
  const specificTokens = coreKeywords.filter((t) => !GENERIC_ATTRIBUTE_WORDS.has(t));
  const anchorCandidates = specificTokens.length > 0 ? specificTokens : coreKeywords;
  const anchorTokens = [...anchorCandidates].sort((a, b) => anchorSpecWeight(b) - anchorSpecWeight(a));

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

type UnitSpec = [group: string, factor: number, label: string];
const UNIT_TABLE: Record<string, UnitSpec> = {
  b: ['byte', 1, 'B'], byte: ['byte', 1, 'B'], bytes: ['byte', 1, 'B'],
  kb: ['byte', 1024, 'KB'], kib: ['byte', 1024, 'KiB'],
  mb: ['byte', 1024 ** 2, 'MB'], mib: ['byte', 1024 ** 2, 'MiB'],
  gb: ['byte', 1024 ** 3, 'GB'], gib: ['byte', 1024 ** 3, 'GiB'],
  tb: ['byte', 1024 ** 4, 'TB'], tib: ['byte', 1024 ** 4, 'TiB'],
  pb: ['byte', 1024 ** 5, 'PB'], pib: ['byte', 1024 ** 5, 'PiB'],
  mm: ['len', 0.001, 'mm'], millimeter: ['len', 0.001, 'mm'], millimeters: ['len', 0.001, 'mm'], millimetre: ['len', 0.001, 'mm'], millimetres: ['len', 0.001, 'mm'],
  cm: ['len', 0.01, 'cm'], centimeter: ['len', 0.01, 'cm'], centimeters: ['len', 0.01, 'cm'], centimetre: ['len', 0.01, 'cm'], centimetres: ['len', 0.01, 'cm'],
  m: ['len', 1, 'm'], meter: ['len', 1, 'm'], meters: ['len', 1, 'm'], metre: ['len', 1, 'm'], metres: ['len', 1, 'm'],
  km: ['len', 1000, 'km'], kilometer: ['len', 1000, 'km'], kilometers: ['len', 1000, 'km'], kilometre: ['len', 1000, 'km'], kilometres: ['len', 1000, 'km'],
  in: ['len', 0.0254, 'in'], inch: ['len', 0.0254, 'in'], inches: ['len', 0.0254, 'in'],
  ft: ['len', 0.3048, 'ft'], foot: ['len', 0.3048, 'ft'], feet: ['len', 0.3048, 'ft'],
  yd: ['len', 0.9144, 'yd'], yard: ['len', 0.9144, 'yd'], yards: ['len', 0.9144, 'yd'],
  mi: ['len', 1609.344, 'miles'], mile: ['len', 1609.344, 'miles'], miles: ['len', 1609.344, 'miles'],
  nmi: ['len', 1852, 'nmi'],
  mg: ['mass', 0.001, 'mg'], g: ['mass', 1, 'g'], gram: ['mass', 1, 'g'], grams: ['mass', 1, 'g'],
  kg: ['mass', 1000, 'kg'], kilogram: ['mass', 1000, 'kg'], kilograms: ['mass', 1000, 'kg'],
  oz: ['mass', 28.349523125, 'oz'], ounce: ['mass', 28.349523125, 'oz'], ounces: ['mass', 28.349523125, 'oz'],
  lb: ['mass', 453.59237, 'lbs'], lbs: ['mass', 453.59237, 'lbs'], pound: ['mass', 453.59237, 'lbs'], pounds: ['mass', 453.59237, 'lbs'],
  st: ['mass', 6350.29318, 'st'], stone: ['mass', 6350.29318, 'st'],
  ml: ['vol', 1, 'mL'], l: ['vol', 1000, 'L'], liter: ['vol', 1000, 'L'], liters: ['vol', 1000, 'L'], litre: ['vol', 1000, 'L'], litres: ['vol', 1000, 'L'],
  floz: ['vol', 29.57352956, 'fl oz'], cup: ['vol', 236.5882365, 'cups'], cups: ['vol', 236.5882365, 'cups'],
  pt: ['vol', 473.176473, 'pt'], pint: ['vol', 473.176473, 'pt'], pints: ['vol', 473.176473, 'pt'],
  qt: ['vol', 946.352946, 'qt'], quart: ['vol', 946.352946, 'qt'], quarts: ['vol', 946.352946, 'qt'],
  gal: ['vol', 3785.411784, 'gal'], gallon: ['vol', 3785.411784, 'gal'], gallons: ['vol', 3785.411784, 'gal'],
  mps: ['spd', 1, 'm/s'], kmh: ['spd', 1 / 3.6, 'km/h'], kph: ['spd', 1 / 3.6, 'km/h'],
  mph: ['spd', 0.44704, 'mph'], kn: ['spd', 0.514444, 'knots'], knot: ['spd', 0.514444, 'knots'], knots: ['spd', 0.514444, 'knots'],
  ms: ['time', 0.001, 'ms'], s: ['time', 1, 's'], sec: ['time', 1, 's'], secs: ['time', 1, 's'], second: ['time', 1, 's'], seconds: ['time', 1, 's'],
  min: ['time', 60, 'min'], mins: ['time', 60, 'min'], minute: ['time', 60, 'min'], minutes: ['time', 60, 'min'],
  h: ['time', 3600, 'hr'], hr: ['time', 3600, 'hr'], hrs: ['time', 3600, 'hr'], hour: ['time', 3600, 'hr'], hours: ['time', 3600, 'hr'],
  d: ['time', 86400, 'days'], day: ['time', 86400, 'days'], days: ['time', 86400, 'days'],
  wk: ['time', 604800, 'weeks'], week: ['time', 604800, 'weeks'], weeks: ['time', 604800, 'weeks'],
};

const HTTP_STATUS_INFO: Record<number, [string, string]> = {
  100: ['Continue', 'Interim response; client may send the request body.'],
  101: ['Switching Protocols', 'Server is switching protocols as requested (e.g. WebSocket upgrade).'],
  200: ['OK', 'Standard response for a successful HTTP request.'],
  201: ['Created', 'Request succeeded and created a new resource.'],
  202: ['Accepted', 'Request accepted for asynchronous processing.'],
  204: ['No Content', 'Succeeded with an empty response body.'],
  206: ['Partial Content', 'Range request succeeded with partial payload.'],
  301: ['Moved Permanently', 'Resource permanently moved to the Location URI.'],
  302: ['Found', 'Temporary redirect to another URI.'],
  304: ['Not Modified', 'Cached representation is still fresh (ETag / If-Modified-Since).'],
  307: ['Temporary Redirect', 'Temporary redirect preserving HTTP method and body.'],
  308: ['Permanent Redirect', 'Permanent redirect preserving HTTP method and body.'],
  400: ['Bad Request', 'Malformed syntax, invalid parameters, or invalid request framing.'],
  401: ['Unauthorized', 'Valid authentication credentials are required.'],
  403: ['Forbidden', 'Server understood the request but refuses authorization.'],
  404: ['Not Found', 'No resource matches the requested URI.'],
  405: ['Method Not Allowed', 'Target resource does not support this HTTP method.'],
  408: ['Request Timeout', 'Server timed out waiting for the client request.'],
  409: ['Conflict', 'Request conflicts with current state of the target resource.'],
  410: ['Gone', 'Resource is permanently removed with no forwarding address.'],
  413: ['Content Too Large', 'Request payload exceeds the server limit.'],
  415: ['Unsupported Media Type', 'Payload Content-Type or encoding is not supported.'],
  418: ["I'm a teapot", 'RFC 2324 HTCPCP joke status: server refuses to brew coffee in a teapot.'],
  422: ['Unprocessable Content', 'Valid syntax, but semantic validation failed.'],
  429: ['Too Many Requests', 'Rate limit exceeded; check Retry-After before retrying.'],
  451: ['Unavailable For Legal Reasons', 'Access denied due to a legal demand or censorship order.'],
  500: ['Internal Server Error', 'Unhandled server-side failure.'],
  502: ['Bad Gateway', 'Reverse proxy received an invalid upstream response.'],
  503: ['Service Unavailable', 'Server is overloaded or down for maintenance.'],
  504: ['Gateway Timeout', 'Upstream server failed to respond in time.'],
};

const MATH_FUNCS: Record<string, string> = {
  sqrt: 'Math.sqrt', cbrt: 'Math.cbrt', abs: 'Math.abs',
  sin: 'Math.sin', cos: 'Math.cos', tan: 'Math.tan',
  asin: 'Math.asin', acos: 'Math.acos', atan: 'Math.atan',
  log: 'Math.log10', log10: 'Math.log10', ln: 'Math.log', log2: 'Math.log2',
  exp: 'Math.exp', floor: 'Math.floor', ceil: 'Math.ceil', round: 'Math.round',
  pi: 'Math.PI', tau: '(Math.PI*2)', e: 'Math.E',
};

function parseCssColor(q: string): [number, number, number] | null {
  const hex = q.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (hex) {
    const h = hex[1].length === 3 ? hex[1].split('').map((c) => c + c).join('') : hex[1];
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
  }
  const rgb = q.match(/^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})(?:\s*,\s*[\d.]+)?\s*\)$/i);
  if (rgb) {
    const [r, g, b] = [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])];
    return r <= 255 && g <= 255 && b <= 255 ? [r, g, b] : null;
  }
  const hsl = q.match(/^hsla?\(\s*(-?\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)%\s*,\s*(\d+(?:\.\d+)?)%(?:\s*,\s*[\d.]+)?\s*\)$/i);
  if (hsl) {
    const h = ((Number(hsl[1]) % 360) + 360) % 360;
    const s = Math.min(100, Number(hsl[2])) / 100;
    const l = Math.min(100, Number(hsl[3])) / 100;
    const k = (n: number) => (n + h / 30) % 12;
    const a = s * Math.min(l, 1 - l);
    const f = (n: number) => Math.round(255 * (l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)))));
    return [f(0), f(8), f(4)];
  }
  return null;
}

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  const rn = r / 255, gn = g / 255, bn = b / 255;
  const max = Math.max(rn, gn, bn), min = Math.min(rn, gn, bn), d = max - min;
  const l = (max + min) / 2;
  if (d === 0) return [0, 0, Math.round(l * 100)];
  const s = d / (1 - Math.abs(2 * l - 1));
  const h = max === rn ? ((gn - bn) / d + (gn < bn ? 6 : 0)) * 60 : max === gn ? ((bn - rn) / d + 2) * 60 : ((rn - gn) / d + 4) * 60;
  return [Math.round(h) % 360, Math.round(s * 100), Math.round(l * 100)];
}

function intToIp(n: number): string {
  return `${(n >>> 24) & 255}.${(n >>> 16) & 255}.${(n >>> 8) & 255}.${n & 255}`;
}

/**
 * Instant Calculator, Unit Converter, Base/Color/CIDR/Epoch/HTTP/Cron Evaluator
 */
export function evaluateInstantComputation(rawQuery: string): InstantAnswerPayload | null {
  const q = rawQuery.trim();
  const lower = q.toLowerCase();

  // 1. Percentage: "18% of 450" or "45 is what % of 180"
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
  const whatPct = lower.match(/^(\d+(?:\.\d+)?)\s+is\s+what\s+(?:%|percent(?:age)?)\s+of\s+(\d+(?:\.\d+)?)$/i);
  if (whatPct && parseFloat(whatPct[2]) !== 0) {
    const part = parseFloat(whatPct[1]), whole = parseFloat(whatPct[2]);
    const pct = (part / whole) * 100;
    return {
      kind: 'computation',
      title: `${pct.toLocaleString('en-US', { maximumFractionDigits: 4 })}%`,
      subtitle: `Percentage (${part} of ${whole})`,
      directAnswer: `(${part} ÷ ${whole}) × 100 = ${pct.toLocaleString('en-US', { maximumFractionDigits: 4 })}%`,
      confidence: 'verified',
      citations: [],
    };
  }

  // 2. Base conversion: "255 in hex", "0xff in decimal", "42 in binary", "0o755 in binary"
  const baseMatch = lower.match(/^(0x[0-9a-f]+|0b[01]+|0o[0-7]+|\d+)\s+(?:in|to|as)\s+(hex|hexadecimal|bin|binary|dec|decimal|oct|octal)$/i);
  if (baseMatch) {
    const rawNum = baseMatch[1];
    const target = baseMatch[2];
    const parsed = rawNum.startsWith('0x')
      ? parseInt(rawNum.slice(2), 16)
      : rawNum.startsWith('0b')
      ? parseInt(rawNum.slice(2), 2)
      : rawNum.startsWith('0o')
      ? parseInt(rawNum.slice(2), 8)
      : parseInt(rawNum, 10);
    if (!Number.isNaN(parsed) && Number.isSafeInteger(parsed)) {
      const formatted = target.startsWith('hex')
        ? `0x${parsed.toString(16).toUpperCase()}`
        : target.startsWith('bin')
        ? `0b${parsed.toString(2)}`
        : target.startsWith('oct')
        ? `0o${parsed.toString(8)}`
        : parsed.toString(10);
      return {
        kind: 'computation',
        title: formatted,
        subtitle: `Base Conversion (${rawNum} → ${target})`,
        directAnswer: `Decimal: ${parsed.toLocaleString()} · Hex: 0x${parsed.toString(16).toUpperCase()} · Octal: 0o${parsed.toString(8)} · Binary: 0b${parsed.toString(2)}`,
        confidence: 'verified',
        citations: [],
      };
    }
  }

  // 3. Temperature & Physical / Digital Unit conversions
  const unitMatch = lower.match(/^(-?\d+(?:\.\d+)?)\s*([a-z]+)\s+(?:in|to|as)\s+([a-z]+)$/i);
  if (unitMatch) {
    const val = parseFloat(unitMatch[1]);
    const from = unitMatch[2].toLowerCase();
    const to = unitMatch[3].toLowerCase();
    const tempKey = (u: string) => (u === 'c' || u === 'celsius' ? 'C' : u === 'f' || u === 'fahrenheit' ? 'F' : u === 'k' || u === 'kelvin' ? 'K' : null);
    const tf = tempKey(from), tt = tempKey(to);
    if (tf && tt && tf !== tt) {
      const c = tf === 'C' ? val : tf === 'F' ? ((val - 32) * 5) / 9 : val - 273.15;
      const out = tt === 'C' ? c : tt === 'F' ? (c * 9) / 5 + 32 : c + 273.15;
      const sym = tt === 'K' ? 'K' : `°${tt}`;
      const fromSym = tf === 'K' ? 'K' : `°${tf}`;
      return {
        kind: 'computation',
        title: `${out.toFixed(2)} ${sym}`,
        subtitle: `${val} ${fromSym} to ${tt === 'C' ? 'Celsius' : tt === 'F' ? 'Fahrenheit' : 'Kelvin'}`,
        directAnswer: `${val} ${fromSym} = ${out.toFixed(2)} ${sym} (${(c + 273.15).toFixed(2)} K)`,
        confidence: 'verified',
        citations: [],
      };
    }
    const uf = UNIT_TABLE[from], ut = UNIT_TABLE[to];
    if (uf && ut && uf[0] === ut[0]) {
      const base = val * uf[1];
      const resVal = base / ut[1];
      const digits = uf[0] === 'byte' ? 6 : 3;
      const formatted = uf[0] === 'byte'
        ? resVal.toLocaleString('en-US', { maximumFractionDigits: digits })
        : Number.isInteger(resVal)
        ? String(resVal)
        : resVal.toFixed(digits);
      return {
        kind: 'computation',
        title: `${formatted} ${ut[2]}`,
        subtitle: `${val} ${uf[2]} to ${ut[2]}`,
        directAnswer: uf[0] === 'byte'
          ? `${val.toLocaleString()} ${uf[2]} = ${formatted} ${ut[2]} (${Math.round(base).toLocaleString()} bytes)`
          : `${val} ${uf[2]} = ${formatted} ${ut[2]}`,
        confidence: 'verified',
        citations: [],
      };
    }
  }

  // 4. CSS Color Converter (#hex, rgb(), hsl()) + WCAG contrast ratios
  const rgb = parseCssColor(q);
  if (rgb) {
    const [r, g, b] = rgb;
    const hex = `#${[r, g, b].map((x) => x.toString(16).padStart(2, '0')).join('').toUpperCase()}`;
    const [h, s, l] = rgbToHsl(r, g, b);
    const lin = (c: number) => {
      const v = c / 255;
      return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    };
    const lum = 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
    const onWhite = (1.05 / (lum + 0.05)).toFixed(2);
    const onBlack = ((lum + 0.05) / 0.05).toFixed(2);
    return {
      kind: 'computation',
      title: hex,
      subtitle: `Color · rgb(${r}, ${g}, ${b}) · hsl(${h}, ${s}%, ${l}%)`,
      directAnswer: `HEX ${hex} · RGB rgb(${r}, ${g}, ${b}) · HSL hsl(${h}, ${s}%, ${l}%)`,
      swatchColor: hex,
      keyFacts: [
        { label: 'Contrast on white', value: `${onWhite}:1${Number(onWhite) >= 4.5 ? ' (AA)' : ''}` },
        { label: 'Contrast on black', value: `${onBlack}:1${Number(onBlack) >= 4.5 ? ' (AA)' : ''}` },
        { label: 'Relative luminance', value: `${(lum * 100).toFixed(1)}%` },
      ],
      confidence: 'verified',
      citations: [],
    };
  }

  // 5. IPv4 CIDR Subnet Calculator: "10.0.0.0/22" or "cidr 192.168.1.0/24"
  const cidrMatch = lower.match(/^(?:cidr\s+|subnet\s+)?(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/);
  if (cidrMatch) {
    const octs = cidrMatch.slice(1, 5).map(Number);
    const prefix = Number(cidrMatch[5]);
    if (octs.every((o) => o >= 0 && o <= 255) && prefix >= 0 && prefix <= 32) {
      const ip = ((octs[0] << 24) | (octs[1] << 16) | (octs[2] << 8) | octs[3]) >>> 0;
      const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
      const net = (ip & mask) >>> 0;
      const bcast = (net | (~mask >>> 0)) >>> 0;
      const total = 2 ** (32 - prefix);
      const usable = prefix >= 31 ? total : Math.max(0, total - 2);
      const first = prefix >= 31 ? net : (net + 1) >>> 0;
      const last = prefix >= 31 ? bcast : (bcast - 1) >>> 0;
      return {
        kind: 'computation',
        title: `${intToIp(net)}/${prefix}`,
        subtitle: `IPv4 CIDR · ${usable.toLocaleString('en-US')} usable hosts`,
        directAnswer: `Range ${intToIp(first)} – ${intToIp(last)} · Netmask ${intToIp(mask)} · Broadcast ${intToIp(bcast)}`,
        keyFacts: [
          { label: 'Network', value: intToIp(net) },
          { label: 'Netmask', value: intToIp(mask) },
          { label: 'Broadcast', value: intToIp(bcast) },
          { label: 'Total IPs', value: total.toLocaleString('en-US') },
        ],
        confidence: 'verified',
        citations: [],
      };
    }
  }

  // 6. Unix Epoch / ISO Timestamp Converter: "1700000000", "epoch 1700000000", "unix 2026-11-15T12:00:00Z"
  const epochMatch = lower.match(/^(?:(?:unix|epoch|timestamp)\s+)?(1\d{9}|1\d{12})$/);
  if (epochMatch) {
    const raw = Number(epochMatch[1]);
    const ms = epochMatch[1].length === 10 ? raw * 1000 : raw;
    const iso = new Date(ms).toISOString();
    return {
      kind: 'computation',
      title: iso,
      subtitle: `Unix Timestamp (${epochMatch[1].length === 10 ? 'seconds' : 'milliseconds'})`,
      directAnswer: `${iso} · Seconds: ${Math.floor(ms / 1000)} · Milliseconds: ${ms}`,
      confidence: 'verified',
      citations: [],
    };
  }
  const toUnix = q.match(/^(?:unix|epoch|timestamp)\s+(\d{4}-\d{2}-\d{2}(?:[T\s]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?)$/i);
  if (toUnix) {
    const rawDate = toUnix[1].includes('T') || toUnix[1].includes(' ') ? toUnix[1] : `${toUnix[1]}T00:00:00Z`;
    const ms = Date.parse(rawDate);
    if (Number.isFinite(ms)) {
      const secs = Math.floor(ms / 1000);
      return {
        kind: 'computation',
        title: `${secs}`,
        subtitle: `Unix Epoch Seconds (${new Date(ms).toISOString()})`,
        directAnswer: `Seconds: ${secs} · Milliseconds: ${ms} · UTC: ${new Date(ms).toISOString()}`,
        confidence: 'verified',
        citations: [],
      };
    }
  }

  // 7. HTTP Status Code Quick Reference: "http 418", "status 503", "http status 429"
  const httpMatch = lower.match(/^(?:http(?:\s+status)?|status(?:\s+code)?)\s+([1-5]\d{2})$/);
  if (httpMatch) {
    const code = Number(httpMatch[1]);
    const info = HTTP_STATUS_INFO[code];
    if (info) {
      return {
        kind: 'computation',
        title: `${code} ${info[0]}`,
        subtitle: `HTTP ${Math.floor(code / 100)}xx Status Code`,
        directAnswer: info[1],
        confidence: 'verified',
        citations: [],
      };
    }
  }

  // 8. Cron Expression Explainer: "cron */15 9-17 * * 1-5" or bare "*/15 9-17 * * 1-5"
  const cronMatch = q.match(/^(?:(cron)\s+)?([0-9*,/-]+)\s+([0-9*,/-]+)\s+([0-9*,/-]+)\s+([0-9*,/-]+)\s+([0-9*,/-]+)$/i);
  if (cronMatch && (cronMatch[1] || q.includes('*'))) {
    const [, , min, hr, dom, mon, dow] = cronMatch;
    const valid = [min, hr, dom, mon, dow].every((f) => /^(?:\*(?:\/\d+)?|\d+(?:-\d+)?(?:\/\d+)?(?:,\d+(?:-\d+)?)*)$/.test(f));
    if (valid) {
      const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
      const fmtDow = dow.replace(/\b([0-7])\b/g, (d) => DAYS[Number(d)] || d);
      const minDesc = min === '*' ? 'every minute' : min.startsWith('*/') ? `every ${min.slice(2)} minutes` : `at minute ${min}`;
      const hrDesc = hr === '*' ? 'of every hour' : hr.startsWith('*/') ? `every ${hr.slice(2)} hours` : `during hour ${hr}`;
      const dayDesc = dom === '*' && dow === '*' ? 'every day' : dow !== '*' ? `on ${fmtDow}` : `on day ${dom} of month`;
      const monDesc = mon === '*' ? '' : ` in month ${mon}`;
      return {
        kind: 'computation',
        title: `Runs ${minDesc} ${hrDesc}, ${dayDesc}${monDesc}`,
        subtitle: `Cron Schedule (${min} ${hr} ${dom} ${mon} ${dow})`,
        directAnswer: `Minute: ${min} · Hour: ${hr} · Day of month: ${dom} · Month: ${mon} · Day of week: ${fmtDow}`,
        confidence: 'verified',
        citations: [],
      };
    }
  }

  // 9. Unix File Permissions (chmod): "chmod 755", "chmod 0644", "chmod 4755", "chmod rwxr-xr-x"
  const chmodOctal = q.match(/^chmod\s+([0-7])?([0-7]{3})$/i);
  const chmodSym = q.match(/^chmod\s+([r-][w-][x-][r-][w-][x-][r-][w-][x-])$/i);
  if (chmodOctal || chmodSym) {
    const RWX = ['---', '--x', '-w-', '-wx', 'r--', 'r-x', 'rw-', 'rwx'];
    const DESC = ['none', 'execute', 'write', 'write + execute', 'read', 'read + execute', 'read + write', 'read + write + execute'];
    const special = chmodOctal?.[1] ? Number(chmodOctal[1]) : 0;
    const digits = chmodOctal
      ? chmodOctal[2].split('').map(Number)
      : [0, 3, 6].map((i) => {
          const tri = chmodSym![1].slice(i, i + 3).toLowerCase();
          return (tri[0] === 'r' ? 4 : 0) + (tri[1] === 'w' ? 2 : 0) + (tri[2] === 'x' ? 1 : 0);
        });
    const oct = digits.join('');
    const triads = digits.map((d) => RWX[d].split(''));
    if (special & 4) triads[0][2] = triads[0][2] === 'x' ? 's' : 'S';
    if (special & 2) triads[1][2] = triads[1][2] === 'x' ? 's' : 'S';
    if (special & 1) triads[2][2] = triads[2][2] === 'x' ? 't' : 'T';
    const sym = triads.map((t) => t.join('')).join('');
    const specialFlags = [
      special & 4 ? 'setuid (4)' : '',
      special & 2 ? 'setgid (2)' : '',
      special & 1 ? 'sticky (1)' : '',
    ].filter(Boolean);
    return {
      kind: 'computation',
      title: `${special}${oct} · ${sym}`,
      subtitle: 'Unix File Permissions (chmod)',
      directAnswer: `Owner: ${DESC[digits[0]]} (${digits[0]}) · Group: ${DESC[digits[1]]} (${digits[1]}) · Others: ${DESC[digits[2]]} (${digits[2]})`,
      codeBlock: `chmod ${special ? `${special}${oct}` : oct} <path>`,
      ...(specialFlags.length ? { keyFacts: [{ label: 'Special bits', value: specialFlags.join(', ') }] } : {}),
      confidence: 'verified',
      citations: [],
    };
  }

  // 10. Display Resolution & Aspect Ratio: "1920x1080", "3840x2160", "aspect ratio 2560x1600"
  const resMatch = q.match(/^(?:aspect(?:\s+ratio)?\s+|resolution\s+)?(\d{2,5})\s*[x×]\s*(\d{2,5})$/i);
  if (resMatch) {
    const w = Number(resMatch[1]);
    const h = Number(resMatch[2]);
    if (w > 0 && h > 0) {
      const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));
      const g = gcd(w, h);
      const rw = w / g;
      const rh = h / g;
      const pixels = w * h;
      const mp = (pixels / 1_000_000).toFixed(2);
      const STANDARDS: Record<string, string> = {
        '1280x720': '720p HD',
        '1920x1080': '1080p Full HD',
        '1920x1200': 'WUXGA',
        '2560x1440': '1440p QHD',
        '2560x1600': 'WQXGA',
        '3440x1440': 'UWQHD Ultrawide',
        '3840x2160': '4K UHD',
        '5120x2880': '5K UHD+',
        '7680x4320': '8K UHD',
      };
      const std = STANDARDS[`${w}x${h}`];
      return {
        kind: 'computation',
        title: `${rw}:${rh}${std ? ` (${std})` : ''}`,
        subtitle: `Resolution & Aspect Ratio (${w}×${h})`,
        directAnswer: `${w} × ${h} = ${rw}:${rh} aspect ratio (${(w / h).toFixed(3)}:1) · ${mp} MP (${pixels.toLocaleString('en-US')} px)`,
        confidence: 'verified',
        citations: [],
      };
    }
  }

  // 11. Well-Known TCP/UDP Network Ports: "port 5432", "tcp port 443"
  const portMatch = q.match(/^(?:tcp\s+|udp\s+)?port\s+(\d{1,5})$/i);
  if (portMatch) {
    const port = Number(portMatch[1]);
    const PORTS: Record<number, [string, string, string]> = {
      20: ['FTP Data', 'TCP', 'File Transfer Protocol data channel (RFC 959).'],
      21: ['FTP Control', 'TCP', 'File Transfer Protocol command/control channel (RFC 959).'],
      22: ['SSH / SFTP / SCP', 'TCP', 'Secure Shell encrypted remote login and file transfer (RFC 4251).'],
      25: ['SMTP', 'TCP', 'Simple Mail Transfer Protocol relay between mail servers (RFC 5321).'],
      53: ['DNS', 'UDP/TCP', 'Domain Name System queries and zone transfers (RFC 1035).'],
      80: ['HTTP', 'TCP', 'Cleartext Hypertext Transfer Protocol web traffic (RFC 9110).'],
      123: ['NTP', 'UDP', 'Network Time Protocol clock synchronization (RFC 5905).'],
      143: ['IMAP', 'TCP', 'Internet Message Access Protocol mail retrieval (RFC 9051).'],
      443: ['HTTPS', 'TCP/UDP', 'HTTP over TLS 1.2/1.3 and HTTP/3 QUIC encrypted web traffic (RFC 9110 / RFC 9114).'],
      465: ['SMTPS', 'TCP', 'Implicit-TLS mail submission (RFC 8314).'],
      587: ['SMTP Submission', 'TCP', 'Authenticated mail client submission with STARTTLS (RFC 6409).'],
      993: ['IMAPS', 'TCP', 'IMAP over implicit TLS (RFC 8314).'],
      1433: ['Microsoft SQL Server', 'TCP', 'Tabular Data Stream (TDS) database listener.'],
      2375: ['Docker Daemon', 'TCP', 'Unencrypted Docker Engine API socket (use 2376 for TLS).'],
      3000: ['Dev HTTP Server', 'TCP', 'Common local development port (Node.js, Rails, Grafana).'],
      3306: ['MySQL / MariaDB', 'TCP', 'MySQL wire protocol database listener.'],
      4173: ['Vite Preview / glogg', 'TCP', 'Default local HTTP port for Vite preview and glogg.'],
      5173: ['Vite Dev Server', 'TCP', 'Default local development port for Vite.'],
      5432: ['PostgreSQL', 'TCP', 'PostgreSQL frontend/backend wire protocol listener.'],
      5672: ['AMQP (RabbitMQ)', 'TCP', 'Advanced Message Queuing Protocol broker port.'],
      6379: ['Redis / Valkey', 'TCP', 'RESP wire protocol in-memory data store listener.'],
      8080: ['HTTP Alternate', 'TCP', 'Common proxy, app-server, and SearXNG HTTP listener.'],
      8443: ['HTTPS Alternate', 'TCP', 'Alternate TLS-encrypted HTTPS application port.'],
      9000: ['S3 / MinIO / PHP-FPM', 'TCP', 'Common object storage and FastCGI process manager port.'],
      9090: ['Prometheus', 'TCP', 'Prometheus metrics server and web UI.'],
      9200: ['Elasticsearch / OpenSearch', 'TCP', 'REST HTTP search and analytics API port.'],
      27017: ['MongoDB', 'TCP', 'MongoDB wire protocol database listener.'],
      51820: ['WireGuard', 'UDP', 'Default WireGuard encrypted VPN tunnel port.'],
    };
    const info = PORTS[port];
    if (info) {
      return {
        kind: 'computation',
        title: `Port ${port} — ${info[0]} (${info[1]})`,
        subtitle: 'Network Port Reference',
        directAnswer: info[2],
        confidence: 'verified',
        citations: [],
      };
    }
  }

  // 12. Offline Base64 / URL Encode & Decode + Local JWT Header/Payload Inspector (zero network leakage)
  const b64Enc = q.match(/^base64\s+encode\s+([\s\S]+)$/i);
  if (b64Enc) {
    const out = Buffer.from(b64Enc[1], 'utf8').toString('base64');
    return {
      kind: 'computation',
      title: out,
      subtitle: 'Base64 Encode (offline)',
      directAnswer: out,
      confidence: 'verified',
      citations: [],
    };
  }
  const b64Dec = q.match(/^base64\s+decode\s+([A-Za-z0-9+/_=-]+)$/i);
  if (b64Dec) {
    try {
      const normalized = b64Dec[1].replace(/-/g, '+').replace(/_/g, '/');
      const buf = Buffer.from(normalized, 'base64');
      const text = buf.toString('utf8');
      if (buf.length > 0 && !text.includes('\ufffd')) {
        return {
          kind: 'computation',
          title: text,
          subtitle: 'Base64 Decode (offline)',
          directAnswer: text,
          confidence: 'verified',
          citations: [],
        };
      }
    } catch {
      // ignore invalid base64
    }
  }
  const urlEnc = q.match(/^url\s+encode\s+([\s\S]+)$/i);
  if (urlEnc) {
    const out = encodeURIComponent(urlEnc[1]);
    return {
      kind: 'computation',
      title: out,
      subtitle: 'URL Percent-Encode (offline)',
      directAnswer: out,
      confidence: 'verified',
      citations: [],
    };
  }
  const urlDec = q.match(/^url\s+decode\s+([\s\S]+)$/i);
  if (urlDec) {
    try {
      const out = decodeURIComponent(urlDec[1].replace(/\+/g, '%20'));
      return {
        kind: 'computation',
        title: out,
        subtitle: 'URL Percent-Decode (offline)',
        directAnswer: out,
        confidence: 'verified',
        citations: [],
      };
    } catch {
      // ignore malformed URI sequence
    }
  }
  const jwtMatch = q.match(/^(?:jwt\s+)?(eyJ[A-Za-z0-9_-]{4,}\.eyJ[A-Za-z0-9_-]{4,})\.[A-Za-z0-9_-]*$/);
  if (jwtMatch) {
    try {
      const [hRaw, pRaw] = jwtMatch[1].split('.');
      const header = JSON.parse(Buffer.from(hRaw, 'base64url').toString('utf8')) as Record<string, unknown>;
      const payload = JSON.parse(Buffer.from(pRaw, 'base64url').toString('utf8')) as Record<string, unknown>;
      const facts: { label: string; value: string }[] = [];
      if (typeof header.alg === 'string') facts.push({ label: 'Algorithm', value: header.alg });
      if (typeof payload.sub === 'string') facts.push({ label: 'Subject (sub)', value: payload.sub });
      if (typeof payload.iss === 'string') facts.push({ label: 'Issuer (iss)', value: payload.iss });
      if (typeof payload.iat === 'number') facts.push({ label: 'Issued (iat)', value: new Date(payload.iat * 1000).toISOString() });
      if (typeof payload.exp === 'number') facts.push({ label: 'Expires (exp)', value: new Date(payload.exp * 1000).toISOString() });
      return {
        kind: 'computation',
        title: `JWT (${typeof header.alg === 'string' ? header.alg : 'token'})`,
        subtitle: 'Decoded locally — signature not verified, never sent over network',
        directAnswer: JSON.stringify(payload),
        codeBlock: JSON.stringify({ header, payload }, null, 2),
        keyFacts: facts,
        confidence: 'verified',
        citations: [],
      };
    } catch {
      // ignore malformed JWT
    }
  }

  // 13. Scientific & Pure Mathematical Expression: "256 * 1024", "2^32", "sqrt(144) + log2(65536)", "1 << 16"
  if (
    /^[0-9a-zA-Z+\-*/^().%<>&|\s]+$/.test(q) &&
    (/[+\-*/^%<>|&]/.test(q) || /^(?:sqrt|cbrt|abs|sin|cos|tan|asin|acos|atan|log|log10|ln|log2|exp|floor|ceil|round)\s*\(/i.test(q)) &&
    (/\d/.test(q) || /\b(?:pi|tau)\b/i.test(q)) &&
    !/^\d{4}-\d{2}-\d{2}$/.test(q) &&
    !/^[a-zA-Z\s-]+$/.test(q)
  ) {
    const idents = q.match(/[a-zA-Z_]\w*/g) ?? [];
    // Allow scientific functions/constants and hex/binary literals (0xff, 0b1010, 1e6) while rejecting arbitrary identifiers.
    const safeIdents = idents.every((id) => id.toLowerCase() in MATH_FUNCS || /^(?:0x[0-9a-f]+|0b[01]+|e\d+)$/i.test(id));
    if (safeIdents) {
      try {
        const jsExpr = q
          .replace(/\^/g, '**')
          .replace(/\b([a-zA-Z_]\w*)\b/g, (m) => MATH_FUNCS[m.toLowerCase()] ?? m);
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
const MODIFIER_WORDS = /* @__PURE__ */ new Set([
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

const DEVERBAL_AL = /^(?:renew|remov|approv|arriv|surviv|reviv|retriev|propos|dispos|refus|withdraw|dismiss|rehears|rent|referr|deferr)al$/;
const NEGATED_SPAN =
  /\b(?:without|with\s+no|no|lacks?|lacking)\s+(?:(?!\b(?:when|while|if|after|before|by|for|in|on|at|to|from|with|because|which|that|who|where|but|yet|though|although)\b)[\p{L}\p{M}\p{N}'-]+(?:\s+(?:or|and|nor)\s+|\s+|$)){1,5}/gu;

const SPELLING_TWINS = /* @__PURE__ */ (() => {
  const map = new Map<string, string>();
  const link = (a: string, b: string) => { map.set(a, b); map.set(b, a); };
  for (const [uk, us] of 'tyre:tire,tyres:tires,aluminium:aluminum,grey:gray,greyscale:grayscale'.split(',').map((p) => p.split(':'))) link(uk, us);
  for (const [uk, us] of 'colour:color,watercolour:watercolor,behaviour:behavior,armour:armor,flavour:flavor,harbour:harbor,labour:labor,neighbour:neighbor,vapour:vapor,honour:honor,humour:humor,rumour:rumor,catalogue:catalog'.split(',').map((p) => p.split(':'))) {
    link(uk, us); link(`${uk}s`, `${us}s`);
    link(uk.endsWith('e') ? `${uk}d` : `${uk}ed`, `${us}ed`);
    link(uk.endsWith('e') ? `${uk.slice(0, -1)}ing` : `${uk}ing`, `${us}ing`);
  }
  for (const [uk, us] of 'fibre:fiber,centre:center,metre:meter,kilometre:kilometer,centimetre:centimeter,millimetre:millimeter,litre:liter,theatre:theater,defence:defense,offence:offense,licence:license,organisation:organization'.split(',').map((p) => p.split(':'))) {
    link(uk, us); link(`${uk}s`, `${us}s`);
  }
  link('centred', 'centered'); link('licenced', 'licensed');
  for (const stem of 'analys,optimis,organis,anodis,serialis,normalis,customis,authoris,recognis,summaris,prioritis,synchronis,virtualis,containeris,minimis,maximis,utilis,stabilis,initialis'.split(',')) {
    const z = `${stem.slice(0, -1)}z`;
    link(`${stem}e`, `${z}e`); link(`${stem}es`, `${z}es`); link(`${stem}ed`, `${z}ed`); link(`${stem}ing`, `${z}ing`);
  }
  return map;
})();
// Noun-only UK/US homograph twins ("tire" is also an unrelated verb meaning exhausted).
const NO_VERB_TWINS = /* @__PURE__ */ new Set(['tire', 'tires']);

export function spellingTwin(word: string): string | undefined {
  return SPELLING_TWINS.get(word.toLowerCase());
}

/** Whole words for spaced scripts; literal sequences for Japanese/Chinese text without spaces. */
function wordMatcher(text: string): (word: string) => boolean {
  const words = new Set(text.match(/[\p{L}\p{M}\p{N}]+/gu) ?? []);
  const stems = new Set([...words].map(stemToken));
  const matchAlpha = (w: string): boolean => {
    if (words.has(w) || stems.has(stemToken(w))) return true;
    if (!/^[a-z]+$/.test(w)) return false;
    return (
      words.has(`${w}s`) || words.has(`${w}es`) ||
      words.has(`${w}ing`) || words.has(`${w}ed`) ||
      (DEVERBAL_AL.test(`${w}al`) && words.has(`${w}al`)) ||
      (w.endsWith('e') && w.length >= 4 && (
        words.has(`${w}d`) ||
        words.has(`${w.slice(0, -1)}ing`) ||
        (DEVERBAL_AL.test(`${w.slice(0, -1)}al`) && words.has(`${w.slice(0, -1)}al`))
      )) ||
      (w.endsWith('ing') && w.length >= 6 && words.has(`${w.slice(0, -3)}e`)) ||
      (w.endsWith('ed') && w.length >= 5 && (words.has(`${w.slice(0, -2)}e`) || words.has(w.slice(0, -1)))) ||
      (DEVERBAL_AL.test(w) && (words.has(w.slice(0, -2)) || words.has(`${w.slice(0, -2)}e`) || stems.has(wordSlice(w, -2)))) ||
      (/[aeiou][bcdfgklmnprstvwz]$/.test(w) && (words.has(`${w}${w.at(-1)}ing`) || words.has(`${w}${w.at(-1)}ed`))) ||
      (w.length === 4 && w.endsWith('s') && !w.endsWith('ss') && words.has(w.slice(0, -1)))
    );
  };
  return (word) => {
    if (matchAlpha(word)) return true;
    const twin = SPELLING_TWINS.get(word);
    if (twin) {
      if (NO_VERB_TWINS.has(twin)) {
        if (words.has(twin) || words.has(twin.endsWith('s') ? twin.slice(0, -1) : `${twin}s`)) return true;
      } else if (matchAlpha(twin)) {
        return true;
      }
    }
    if (/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(word)) return text.includes(word);
    // Preserve compounds and symbols such as node.js, C++, HL-L2350DW and "roll back".
    if (/[^\p{L}\p{M}\p{N}]/u.test(word)) {
      const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return new RegExp(`(^|[^\\p{L}\\p{M}\\p{N}])${escaped}($|[^\\p{L}\\p{M}\\p{N}])`, 'u').test(text);
    }
    return false;
  };
}

function wordSlice(w: string, end: number): string {
  return w.slice(0, end);
}

function synonymMatch(word: string, matches: (word: string) => boolean): boolean {
  const stem = stemToken(word);
  const group = SYNONYM_GROUPS.find((g) => g.some((m) => m === word || stemToken(m) === stem));
  if (!group) return false;
  return group.some(matches);
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

  const titleLower = title.toLowerCase().normalize('NFC');
  const snippetLower = snippet.toLowerCase().normalize('NFC');
  const stripNegated = !/\b(?:no|without|not|lacks?|lacking)\b/i.test(rawQuery);
  const positiveTitle = stripNegated ? titleLower.replace(NEGATED_SPAN, ' ') : titleLower;
  const positiveSnippet = stripNegated ? snippetLower.replace(NEGATED_SPAN, ' ') : snippetLower;
  // Providers sometimes return a literal percent sign. One URL must not abort the whole ranking.
  let decodedUrl = url;
  try { decodedUrl = decodeURIComponent(url); } catch { /* Match the original text instead. */ }
  const urlLower = decodedUrl.toLowerCase().normalize('NFC');
  const tagsLower = (tags ?? []).join(' ').toLowerCase().normalize('NFC');
  const fullText = `${positiveTitle} ${positiveSnippet} ${urlLower} ${tagsLower}`;

  // Expand well-known technical synonyms so "copy on write" also recognizes "Copy-on-write (COW)"
  const expandedText =
    fullText +
    (fullText.includes('copy-on-write') || fullText.includes('copy on write') ? ' cow copy write' : '') +
    (fullText.includes('kazakhstan') ? ' kazakh astana' : '');
  const titleMatches = wordMatcher(positiveTitle);
  const fullMatches = wordMatcher(expandedText);

  let matchedCoreCount = 0;
  let titleMatchedCount = 0;
  let weightTotal = 0;
  let weightMatched = 0;
  let weightTitle = 0;

  for (const kw of coreKeywords) {
    const weight = MODIFIER_WORDS.has(kw) ? MODIFIER_WEIGHT : 1;
    const inTitle = titleMatches(kw) || synonymMatch(kw, titleMatches);
    const inFull = fullMatches(kw) || synonymMatch(kw, fullMatches);

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
  const anchorHit = (a: string) => fullMatches(a) || synonymMatch(a, fullMatches);
  const anchors = analysis.anchorTokens.filter((a) => !MODIFIER_WORDS.has(a));
  const matchedAnchor =
    anchors.length === 0 ||
    anchorHit(anchors[0]) ||
    (coverageRatio >= 0.5 && anchors.slice(1, 3).some(anchorHit)) ||
    (titleMatchedCount >= 2 && anchors.slice(0, 3).some(anchorHit));

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

  // 2. Title Keyword Coverage & Title Focus Ratio (up to 36 pts)
  score += Math.round(titleCoverageRatio * 22);
  const contentWords = (text: string) =>
    text
      .replace(/[^\p{L}\p{M}\p{N}\s]/gu, ' ')
      .split(/\s+/)
      .filter((w) => (w.length >= 2 || /[^\x00-\x7f]/.test(w)) && !SEARCH_STOPWORDS.has(w));
  const titleWords = contentWords(positiveTitle);
  const titleFocusRatio = titleWords.length > 0 ? titleMatchedCount / titleWords.length : 0;
  if (titleFocusRatio >= 0.45 && titleMatchedCount >= 1) {
    score += 14;
  } else if (titleWords.length >= 12 && titleFocusRatio < 0.2) {
    // Long tangential title where keywords appear incidentally
    score -= 18;
  }

  // 3. Contiguous / Exact Phrase & Primary Heading Match Bonus (up to 26 pts)
  const entityLower = analysis.entitySubject.toLowerCase();
  const attrAndEntityPhrase = analysis.questionAttribute
    ? `${analysis.questionAttribute.toLowerCase()} of ${entityLower}`
    : '';
  const kwPhrase = coreKeywords.join(' ');
  const kwHyphenPhrase = coreKeywords.join('-');
  const leadClause = positiveTitle.split(/[:—–|]/)[0];
  const leadWords = contentWords(leadClause);
  const leadMatches = wordMatcher(leadClause);
  const leadMatchedCount = coreKeywords.filter((kw) => leadMatches(kw) || synonymMatch(kw, leadMatches)).length;
  const titlePhraseIndex = kwPhrase.length >= 5
    ? (positiveTitle.includes(kwPhrase) ? positiveTitle.indexOf(kwPhrase) : positiveTitle.indexOf(kwHyphenPhrase))
    : -1;
  const auxiliaryTitlePhrase =
    titlePhraseIndex > 0 &&
    /\b(?:for|about)\s+(?:(?:a|an|the|your|my|our)\s+)?$/.test(positiveTitle.slice(0, titlePhraseIndex)) &&
    leadMatchedCount < leadWords.length;

  let urlLeaf = '';
  try { urlLeaf = new URL(url).pathname.split('/').filter(Boolean).pop()?.toLowerCase() ?? ''; } catch { /* ignore */ }

  if (attrAndEntityPhrase && positiveTitle.includes(attrAndEntityPhrase)) {
    score += 26;
  } else if (titlePhraseIndex >= 0) {
    score += auxiliaryTitlePhrase ? 14 : 26;
  } else if (totalCoreCount >= 2 && leadWords.length === totalCoreCount && leadMatchedCount === totalCoreCount) {
    score += 20;
  } else if (entityLower.length >= 3 && positiveTitle.includes(entityLower)) {
    score += 16;
  } else if (
    (attrAndEntityPhrase && positiveSnippet.includes(attrAndEntityPhrase)) ||
    (kwPhrase.length >= 5 && (positiveSnippet.includes(kwPhrase) || positiveSnippet.includes(kwHyphenPhrase)))
  ) {
    score += 18;
  } else if (entityLower.length >= 3 && positiveSnippet.includes(entityLower)) {
    score += 10;
  }

  if (kwHyphenPhrase.length >= 5 && urlLeaf === kwHyphenPhrase) {
    score += 6;
  }

  // 4. Question-Attribute Direct Answer Bonus (e.g. "is the capital city of Kazakhstan")
  let isDirectAnswerCandidate = false;
  if (analysis.questionAttribute) {
    const attrLower = analysis.questionAttribute.toLowerCase();
    // Both come from the query: escaped, so they match as text and never run as a pattern.
    const attrRx = attrLower.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const entityRx = entityLower.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const directAttrRx = new RegExp(
      `\\b(?:${attrRx}\\s+(?:city\\s+)?of\\s+${entityRx}|${entityRx}(?:'s)?\\s+${attrRx}|is\\s+the\\s+${attrRx})`,
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
  } else if (totalCoreCount >= 3 && coverageRatio < 0.5 && titleMatchedCount < 2) {
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
