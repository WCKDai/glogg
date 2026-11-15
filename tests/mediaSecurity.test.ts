import { describe, expect, it, vi } from 'vitest';
import { commonsAssetUrl, mediaImageUrl } from '../src/core/media.js';
import { contentSecurityPolicy } from '../server/security.js';
import { publicServiceGuard } from '../server/serviceMode.js';

const image = 'https://thumb.wikimedia.org/wikipedia/commons/thumb/a/ab/Photo.jpg/480px-Photo.jpg';

describe('media URL boundary', () => {
  it('normalizes only known asset URLs, removing tracking and fragments', () => {
    expect(commonsAssetUrl(`${image}?utm_source=commons#one`, 'image')).toBe(image);
    expect(mediaImageUrl(image)).toBe(`/api/media/image?url=${encodeURIComponent(image)}`);
    expect(commonsAssetUrl('https://upload.wikimedia.org/wikipedia/commons/a/ab/Clip.webm', 'video')).toContain('Clip.webm');
  });
  it.each([
    'https://evil.example/a.jpg', 'http://upload.wikimedia.org/wikipedia/commons/a/ab/a.jpg',
    'https://upload.wikimedia.org.evil.example/wikipedia/commons/a/ab/a.jpg',
    'https://user:password@upload.wikimedia.org/wikipedia/commons/a/ab/a.jpg',
    'https://upload.wikimedia.org:444/wikipedia/commons/a/ab/a.jpg',
    'https://upload.wikimedia.org:443/wikipedia/commons/a/ab/a.jpg',
    'https://upload.wikimedia.org/wikipedia/commons/a/ab/a.svg',
    'https://upload.wikimedia.org/w/api.php/a.jpg',
    'https://upload.wikimedia.org/wikipedia/commons/a/ab/%2f..%2fsecret.jpg',
    'javascript:alert(1)', '//upload.wikimedia.org/wikipedia/commons/a/ab/a.jpg',
  ])('refuses an unsafe asset: %s', (url) => expect(mediaImageUrl(url)).toBeNull());
  it('adds only the explicit video host to CSP, retaining ordinary-page restrictions', () => {
    const csp = contentSecurityPolicy('<script>window.theme=1</script>');
    expect(csp).toContain("media-src 'self' https://upload.wikimedia.org");
    expect(csp).toContain("img-src 'self' data:");
    expect(csp).toContain("connect-src 'self'");
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).not.toContain('https:;');
  });
  it('permits only reading the public image endpoint', () => {
    const next = vi.fn(); const res = { status: vi.fn().mockReturnThis(), json: vi.fn() };
    publicServiceGuard({ path: '/api/media/image', method: 'GET', headers: {} } as never, res as never, next);
    expect(next).toHaveBeenCalledOnce();
    for (const [method, path] of [['POST', '/api/media/image'], ['GET', '/api/media/video'], ['GET', '/api/media/image/other']]) {
      next.mockClear();
      publicServiceGuard({ path, method, headers: {} } as never, res as never, next);
      expect(next).not.toHaveBeenCalled(); expect(res.status).toHaveBeenLastCalledWith(403);
    }
  });
});
