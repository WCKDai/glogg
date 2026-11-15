// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ScoredSearchResult } from '../src/core/types.js';
import { MediaResults, MediaViewer } from '../src/client/components/Media.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const original = 'https://upload.wikimedia.org/wikipedia/commons/a/ab/Ocean.jpg';
const preview = 'https://thumb.wikimedia.org/wikipedia/commons/thumb/a/ab/Ocean.jpg/480px-Ocean.jpg';
const video = 'https://upload.wikimedia.org/wikipedia/commons/transcoded/a/ab/Ocean.webm/Ocean.webm.480p.webm';
const item = (kind: 'image' | 'video' = 'image', id = 'one') => ({
  id, title: `Ocean ${id}`, url: `https://commons.wikimedia.org/wiki/File:Ocean_${id}`, source: 'wikimedia',
  media: { kind, url: kind === 'image' ? original : video, previewUrl: preview, mimeType: kind === 'image' ? 'image/jpeg' : 'video/webm', attribution: 'Example photographer', license: 'CC BY 4.0', licenseUrl: 'https://creativecommons.org/licenses/by/4.0/' },
}) as ScoredSearchResult;
let root: Root;
let box: HTMLDivElement;
beforeEach(() => { box = document.createElement('div'); document.body.append(box); root = createRoot(box); });
afterEach(async () => { await act(async () => root.unmount()); box.remove(); });
const render = async (element: React.ReactNode) => act(async () => root.render(element));
const click = async (selector: string) => act(async () => box.querySelector<HTMLButtonElement>(selector)!.click());

describe('media viewers', () => {
  it('uses same-origin thumbnails and retains source credits and save actions', async () => {
    const open = vi.fn(), save = vi.fn();
    await render(<MediaResults items={[item()]} active={0} onHover={() => {}} onOpen={open} onSave={save} savedUrls={[]} />);
    expect(box.querySelector('img')?.getAttribute('src')).toMatch(/^\/api\/media\/image\?url=/);
    expect(box.textContent).toContain('Example photographer · CC BY 4.0');
    expect(box.querySelector('a')?.href).toBe(item().url);
    await click('.media-preview'); expect(open).toHaveBeenCalledWith(item());
    await click('.media-links button'); expect(save).toHaveBeenCalledWith(item());
  });

  it('opens images through the proxy, zooms and keeps a bounded preview when the original fails', async () => {
    const close = vi.fn();
    await render(<MediaViewer item={item()} onClose={close} />);
    expect(box.querySelector('[role=dialog]')?.getAttribute('aria-label')).toBe('Image viewer');
    const img = box.querySelector('img')!;
    expect(img.getAttribute('src')).toContain(encodeURIComponent(original));
    await click('[aria-pressed]'); expect(box.querySelector('.media-stage.zoomed')).toBeTruthy();
    await act(async () => img.dispatchEvent(new Event('error')));
    expect(box.querySelector('img')?.getAttribute('src')).toContain(encodeURIComponent(preview));
    expect(box.textContent).toContain('Preview size');
    await act(async () => box.querySelector('img')!.dispatchEvent(new Event('error')));
    expect(box.querySelector('[role=status]')?.textContent).toContain('could not be loaded');
    expect(box.querySelector('a')?.href).toBe(item().url);
    await act(async () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })));
    expect(close).toHaveBeenCalledOnce();
  });

  it('does not create a video request until Play, and never auto-loads the next video', async () => {
    const first = item('video');
    await render(<MediaViewer item={first} onClose={() => {}} />);
    expect(box.querySelector('video')).toBeNull();
    expect(box.textContent).toContain('Plays from Wikimedia Commons');
    await click('.media-start');
    const player = box.querySelector('video')!;
    expect(player.getAttribute('src')).toBe(video);
    expect(player.controls).toBe(true);
    expect(player.playsInline).toBe(true);
    expect(player.preload).toBe('none');
    expect(player.crossOrigin).toBe('anonymous');
    const next = item('video', 'two'); next.media!.url = video.replaceAll('Ocean', 'Waves');
    await render(<MediaViewer item={next} onClose={() => {}} />);
    expect(box.querySelector('video')).toBeNull();
    expect(box.querySelector('.media-start')).toBeTruthy();
  });

  it('refuses arbitrary video hosts and keeps keyboard navigation and focus restoration', async () => {
    const unsafe = item('video'); unsafe.media!.url = 'https://tracker.example/video.webm';
    const opener = document.createElement('button'); document.body.prepend(opener); opener.focus();
    const next = vi.fn();
    await render(<MediaViewer item={unsafe} onClose={() => {}} onNext={next} />);
    expect(box.querySelector<HTMLButtonElement>('.media-start')?.disabled).toBe(true);
    expect(box.querySelector('video')).toBeNull();
    await act(async () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight' })));
    expect(next).toHaveBeenCalledOnce();
    await render(null);
    expect(document.activeElement).toBe(opener);
    expect(document.body.style.overflow).toBe('');
    opener.remove();
  });
});
