import type { SearchFreshnessIntent, SearchLensId } from './types.js';

/** Conservative query hints, not a claim that a provider has real-time coverage. */
export function inferFreshness(query: string, lens: SearchLensId = 'all', now = Date.now()): SearchFreshnessIntent | undefined {
  if (lens === 'pre-llm' || lens === 'deep-archives' || lens === 'images' || lens === 'videos') return undefined;
  const q = query.toLowerCase();
  const year = new Date(now).getUTCFullYear();
  const explicitlyCurrent = /\b(?:latest|newest|recent|currently|current|up[ -]to[ -]date|today|tonight|right now|live updates?|breaking news)\b/.test(q);
  const pastYear = [...q.matchAll(/\b(19\d{2}|20\d{2})\b/g)].some((m) => Number(m[1]) < year);
  const historicalDate = [...q.matchAll(/\b(?:in|during|from)\s+(19\d{2}|20\d{2})\b/g)].some((m) => Number(m[1]) < year);
  // A model/version year is not a request for old information when "latest" is explicit.
  if (/\bbefore:|\b(?:history of|historical|in the past|used to|was the|were the)\b/.test(q) || historicalDate || (!explicitlyCurrent && pastYear)) return undefined;
  if (lens === 'raw-news' || /\bbreaking (?!bad\b|changes?\b)/.test(q) || /\b(?:headlines?|today|tonight|right now|live updates?)\b/.test(q)) return 'news';
  if (/\b(?:latest|newest|recent|currently|up[ -]to[ -]date)\b/.test(q) ||
      /\bcurrent\s+(?!flow|density|electricity|account\b)/.test(q)) return /\bnews\b/.test(q) ? 'news' : 'current';
  const explanation = /\b(?:how (?:does|do|to)|what (?:is|are)|definition|define|meaning|algorithm|api|model design)\b/.test(q);
  if (!explanation && /\bnews\b/.test(q.replace(/hacker news|news\.ycombinator\.com/g, ''))) return 'news';
  if ((!explanation && /\b(?:weather|forecast|stock price|exchange rate|election results|live score)\b/.test(q)) ||
      /\bwhat (?:is|are)\b.*\b(?:weather|forecast) (?:in|for|at) \S/.test(q) ||
      /\bwho (?:is|are) (?:the )?(?:[\p{L}\p{N}.'’ -]{1,60} )?(?:president|prime minister|ceo|governor|mayor)\b/u.test(q)) return 'current';
  return undefined;
}

/** News indexes often AND every word: "latest" and "today" are intent, not required headline text. */
export function freshnessQuery(query: string, intent: SearchFreshnessIntent = 'news'): string {
  const words = intent === 'news' ? query.replace(/\bbreaking\b(?! bad\b| changes?\b)/gi, ' ') : query;
  return words.replace(/\b(?:up[ -]to[ -]date|right now|live updates?|headlines?|latest|newest|recent|currently|today|tonight)\b|(?<!hacker )\bnews\b(?! corp)/gi, ' ').replace(/\s+/g, ' ').trim() || query;
}
