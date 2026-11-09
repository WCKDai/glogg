/**
 * Typographic quotes (’ “ ”) → ASCII, for pattern matching only. Published pages
 * mostly use curly apostrophes, and phrase patterns like /in today's/ are written
 * with straight ones.
 */
export function normalizeQuotes(text: string): string {
  return text.replace(/[‘’‚‛′]/g, "'").replace(/[“”„‟″]/g, '"');
}
