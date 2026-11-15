export type MediaKind = 'image' | 'video';

/** URLs are validated Commons assets; the result URL remains the source/credit page. */
export interface SearchMedia {
  kind: MediaKind;
  previewUrl: string;
  url: string;
  mimeType: string;
  width?: number;
  height?: number;
  durationSeconds?: number;
  attribution?: string;
  license?: string;
  licenseUrl?: string;
}

/** Only fixed Wikimedia asset hosts and file paths, never an arbitrary proxy target. */
export function commonsAssetUrl(value: unknown, kind: MediaKind): string | null {
  if (typeof value !== 'string' || value.length > 2048 || /[\u0000-\u0020\\]/.test(value)) return null;
  if (!/^https:\/\/(?:upload|thumb)\.wikimedia\.org\//i.test(value)) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.port) return null;
    if (url.hostname !== 'upload.wikimedia.org' && (kind !== 'image' || url.hostname !== 'thumb.wikimedia.org')) return null;
    if (!/^\/wikipedia\/commons\/(?:thumb\/|transcoded\/)?[a-f0-9]\/[a-f0-9]{2}\//i.test(url.pathname)) return null;
    if (/%(?:2f|5c|00)/i.test(url.pathname)) return null;
    if (!(kind === 'image' ? /\.(?:jpe?g|png|gif|webp|avif)$/i : /\.(?:webm|mp4|ogv)$/i).test(url.pathname)) return null;
    url.search = ''; url.hash = '';
    return url.href;
  } catch { return null; }
}

/** Images stay same-origin. Video URLs are used directly only after the user presses Play. */
export function mediaImageUrl(value: unknown): string | null {
  const url = commonsAssetUrl(value, 'image');
  return url ? `/api/media/image?url=${encodeURIComponent(url)}` : null;
}
