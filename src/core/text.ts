/**
 * Typographic quotes (’ “ ”) → ASCII, for pattern matching only. Published pages
 * mostly use curly apostrophes, and phrase patterns like /in today's/ are written
 * with straight ones.
 */
export function normalizeQuotes(text: string): string {
  return text.replace(/[‘’‚‛′]/g, "'").replace(/[“”„‟″]/g, '"');
}

/**
 * Lone UTF-16 surrogates (half an emoji from a broken paste, or a crafted
 * request) become U+FFFD, so encodeURIComponent can't throw on the text.
 */
export function wellFormed(text: string): string {
  return text.replace(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g, '\ufffd');
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', hellip: '…', mdash: '—', ndash: '–',
  lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', laquo: '«', raquo: '»', middot: '·', bull: '•',
  copy: '©', reg: '®', trade: '™', deg: '°', times: '×',
};

/**
 * Text out of an upstream's HTML fragment (Hacker News, Wikipedia, Stack
 * Exchange titles, Mastodon posts): block tags become spaces, inline ones
 * vanish (`<span>Rust</span>'s` stays one word), and every entity is decoded,
 * `&#x2F;` and `&#39;` included. Entities are decoded after the tags are gone,
 * so an escaped `&lt;b&gt;` comes out as the text "<b>".
 */
export function htmlToText(html: string): string {
  return html
    .replace(/<\/?(?:p|br|div|li|ul|ol|h[1-6]|tr|td|th|blockquote|pre|hr)\b[^>]*>/gi, ' ')
    .replace(/<[^>]*>/g, '')
    .replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]{2,8});/gi, (entity, name: string) => {
      if (name[0] !== '#') return NAMED_ENTITIES[name.toLowerCase()] ?? entity;
      const code = name[1] === 'x' || name[1] === 'X' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
      return code > 0 && code <= 0x10ffff && (code < 0xd800 || code > 0xdfff) ? String.fromCodePoint(code) : '�';
    })
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * At most `max` characters, cut where a reader would: after the last sentence
 * that ends past the halfway mark, otherwise at a word, marked with "…".
 * Never half a word ("passwo") or half an emoji.
 */
export function clip(text: string, max: number): string {
  const t = text.trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max).replace(/[\ud800-\udbff]$/, '');
  const sentenceEnd = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '), cut.lastIndexOf('\n'));
  if (sentenceEnd >= max * 0.5) return cut.slice(0, sentenceEnd + 1).trim();
  const wordEnd = cut.lastIndexOf(' ');
  return `${(wordEnd >= max * 0.5 ? cut.slice(0, wordEnd) : cut).replace(/[\s,;:(–—-]+$/, '')}…`;
}
