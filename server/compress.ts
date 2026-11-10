/**
 * Smaller answers over the wire. Big JSON responses are compressed for
 * browsers that accept it (a search answer shrinks about 6×), and the built
 * app's hashed files are compressed once, kept in memory and cached by the
 * browser for good. On localhost this changes little; over a network it
 * saves most of the transfer.
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import type { NextFunction, Request, Response } from 'express';

const MIN_BYTES = 2048;

function encodingFor(req: Request): 'br' | 'gzip' | null {
  const accept = String(req.headers['accept-encoding'] || '');
  if (/\bbr\b/.test(accept)) return 'br';
  if (/\bgzip\b/.test(accept)) return 'gzip';
  return null;
}

function addVary(res: Response): void {
  const vary = String(res.getHeader('Vary') || '');
  if (!/accept-encoding/i.test(vary)) res.setHeader('Vary', vary ? `${vary}, Accept-Encoding` : 'Accept-Encoding');
}

/** res.json, compressed when the client accepts it and the body is worth it. */
export function compressJson(req: Request, res: Response, next: NextFunction): void {
  const json = res.json.bind(res);
  res.json = (body: unknown) => {
    const encoding = encodingFor(req);
    const text = JSON.stringify(body);
    if (!encoding || text === undefined || Buffer.byteLength(text) < MIN_BYTES || res.headersSent) return json(body);
    const packed =
      encoding === 'br'
        ? zlib.brotliCompressSync(text, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 4 } })
        : zlib.gzipSync(text, { level: 6 });
    res.setHeader('Content-Encoding', encoding);
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    addVary(res);
    return res.send(packed);
  };
  next();
}

/** Serves dist/assets: content-hashed names, so they're cached for a year, and sent compressed. */
export function hashedAssets(dir: string) {
  const packed = new Map<string, Buffer>();
  const TYPES: Record<string, string> = { '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.map': 'application/json' };
  return (req: Request, res: Response, next: NextFunction): void => {
    const file = path.join(dir, path.normalize(req.path).replace(/^(\.\.[/\\])+/, ''));
    const type = TYPES[path.extname(file)];
    if (!type || !file.startsWith(dir + path.sep) || (req.method !== 'GET' && req.method !== 'HEAD')) return next();
    const encoding = encodingFor(req);
    let body: Buffer;
    try {
      const key = `${encoding}:${file}`;
      body = packed.get(key) ?? fs.readFileSync(file);
      if (!packed.has(key)) {
        if (encoding === 'br') body = zlib.brotliCompressSync(body, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 9 } });
        else if (encoding === 'gzip') body = zlib.gzipSync(body, { level: 9 });
        packed.set(key, body);
      }
    } catch {
      return next();
    }
    res.setHeader('Content-Type', type);
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    if (encoding) res.setHeader('Content-Encoding', encoding);
    addVary(res);
    res.end(req.method === 'HEAD' ? undefined : body);
  };
}
