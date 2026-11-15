import React, { useEffect, useState } from 'react';
import type { ScoredSearchResult } from '../../core/browser.js';
import { commonsAssetUrl, mediaImageUrl } from '../../core/media.js';
import { useFocusTrap } from '../lib.js';

export function MediaResults({ items, active, onHover, onOpen, onSave, savedUrls }: {
  items: ScoredSearchResult[]; active: number; onHover: (index: number) => void;
  onOpen: (item: ScoredSearchResult) => void; onSave: (item: ScoredSearchResult) => void; savedUrls: string[];
}) {
  return <div className="media-grid" role="list" aria-label="Media results">
    {items.filter(item => item.media).map((item, index) => {
      const media = item.media!;
      const preview = mediaImageUrl(media.previewUrl);
      const saved = savedUrls.includes(item.url);
      return <article key={item.id} role="listitem" data-result-id={item.id} className={`media-card${active === index ? ' active' : ''}`} onMouseEnter={() => onHover(index)}>
        <button className="media-preview" aria-label={`${media.kind === 'video' ? 'Watch' : 'View'} ${item.title}`} onClick={() => onOpen(item)}>
          {preview && <img src={preview} alt="" loading="lazy" decoding="async" />}
          {media.kind === 'video' && <span className="media-play" aria-hidden>▶ {media.durationSeconds ? `${Math.floor(media.durationSeconds / 60)}:${String(Math.floor(media.durationSeconds % 60)).padStart(2, '0')}` : 'Video'}</span>}
        </button>
        <h2><button onClick={() => onOpen(item)}>{item.title}</button></h2>
        <div className="media-credit">{media.attribution || 'Wikimedia Commons'}{media.license && ` · ${media.license}`}</div>
        <div className="media-links"><a href={item.url} target="_blank" rel="noreferrer">Source</a><button aria-pressed={saved} onClick={() => onSave(item)}>{saved ? 'Saved' : 'Save'}</button></div>
      </article>;
    })}
  </div>;
}

export function MediaViewer({ item, onClose, onPrevious, onNext }: {
  item: ScoredSearchResult; onClose: () => void; onPrevious?: () => void; onNext?: () => void;
}) {
  const box = useFocusTrap<HTMLElement>();
  const [playing, setPlaying] = useState<string | null>(null);
  const [zoomed, setZoomed] = useState(false);
  const [failed, setFailed] = useState(false);
  const [previewOnly, setPreviewOnly] = useState(false);
  const media = item.media!;
  const imageUrl = mediaImageUrl(media.url);
  const preview = mediaImageUrl(media.previewUrl);
  const videoUrl = commonsAssetUrl(media.url, 'video');
  useEffect(() => { setPlaying(null); setZoomed(false); setFailed(false); setPreviewOnly(false); }, [item.id]);
  useEffect(() => {
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = previous; };
  }, []);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); onClose(); }
      else if (!(event.target instanceof HTMLVideoElement)) {
        if (event.key === 'ArrowLeft' && onPrevious) { event.preventDefault(); onPrevious(); }
        if (event.key === 'ArrowRight' && onNext) { event.preventDefault(); onNext(); }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, onPrevious, onNext]);
  return <>
    <div className="scrim" onClick={onClose} />
    <section className="media-viewer" role="dialog" aria-modal="true" aria-label={media.kind === 'video' ? 'Video viewer' : 'Image viewer'} tabIndex={-1} ref={box}>
      <header className="media-viewer-bar">
        <span>{media.kind === 'video' ? 'Video' : 'Image'}</span>
        <button className="btn btn-sm" disabled={!onPrevious} onClick={onPrevious} aria-label="Previous media">←</button>
        <button className="btn btn-sm" disabled={!onNext} onClick={onNext} aria-label="Next media">→</button>
        {media.kind === 'image' && <button className="btn btn-sm" aria-pressed={zoomed} onClick={() => setZoomed(!zoomed)}>{zoomed ? 'Fit' : 'Zoom'}</button>}
        <button className="btn btn-sm" onClick={onClose}>Close</button>
      </header>
      <div className={`media-stage${zoomed ? ' zoomed' : ''}`}>
        {failed ? <p role="status">This media could not be loaded. Open the source below.</p> : media.kind === 'image' ? (
          imageUrl ? <img key={previewOnly ? preview : imageUrl} src={previewOnly && preview ? preview : imageUrl} alt={item.title} onError={() => {
            if (!previewOnly && preview && preview !== imageUrl) setPreviewOnly(true);
            else setFailed(true);
          }} /> : <p>Image unavailable. Open the source below.</p>
        ) : playing === videoUrl && videoUrl ? (
          <video key={videoUrl} src={videoUrl} controls playsInline autoPlay preload="none" crossOrigin="anonymous" tabIndex={0} aria-label={item.title} onError={() => setFailed(true)} />
        ) : <button className="media-start" onClick={() => setPlaying(videoUrl)} disabled={!videoUrl}>
          {preview && <img src={preview} alt="" />}
          <span>▶ Play video</span><small>Plays from Wikimedia Commons</small>
        </button>}
      </div>
      <footer className="media-viewer-info">
        <h2>{item.title}</h2>
        {previewOnly && !failed && <p>Preview size · full image available at the source</p>}
        <p>{media.attribution}{media.width && media.height ? ` · ${media.width} × ${media.height}` : ''}</p>
        <div className="media-links"><a href={item.url} target="_blank" rel="noreferrer">Open source</a>
          {media.licenseUrl?.startsWith('https://') ? <a href={media.licenseUrl} target="_blank" rel="noreferrer">{media.license || 'License'}</a> : media.license && <span>{media.license}</span>}
        </div>
      </footer>
    </section>
  </>;
}
