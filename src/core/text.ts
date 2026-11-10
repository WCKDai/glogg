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
