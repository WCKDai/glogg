/**
 * Deep index — what is never stored, in any mode: sources whose names
 * advertise sexual material involving minors, and posts using the trading
 * jargon for it. 18+ mode unlocks adult content, never this.
 *
 * Whole-word matches only, so ordinary text isn't caught ("Lolita" the novel,
 * "cp" in a shell command, "Shota" the given name). Source names get the broad
 * list; posts only the narrow one, so news and discussion about abuse stay searchable.
 */

const SOURCE_TERMS =
  /\b(?:lolis?|lolicon|shotacon|toddlercon|jail ?bait|pedos?|pedophiles?|pedophilia|paedos?|paedophiles?|paedophilia|pthc|ptsc|hussyfan|r@ygold|preteens?|underage|child ?porn|kiddie ?porn|kiddy ?porn|cub ?porn|cub ?yiff|cp ?(?:links|pics|vids|videos|trade|trading))\b/i;

const POST_TERMS = /\b(?:pthc|ptsc|hussyfan|r@ygold|toddlercon|jail ?bait|child ?porn|kiddie ?porn|kiddy ?porn|cp ?(?:links|pics|vids|videos|trade|trading))\b/i;

/** True when a source's address or name is on the blocklist. */
export function isBlockedSource(s: { url: string; site?: string; title?: string | null }): boolean {
  // Separators in addresses count as spaces, so "lemmy.example/c/jail_bait" is caught too.
  const text = `${s.url} ${s.site ?? ''} ${s.title ?? ''}`.replace(/[._/\-+%]+/g, ' ');
  return SOURCE_TERMS.test(text);
}

/** True when a post's text uses the jargon for trading abuse material. */
export function isBlockedPost(p: { title: string; summary: string; url?: string }): boolean {
  return POST_TERMS.test(`${p.title} ${p.summary}`);
}
