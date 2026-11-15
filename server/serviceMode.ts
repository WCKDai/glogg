import type { RequestHandler } from 'express';
import type { SearchFilterConfig } from '../src/core/types.js';

export function serviceMode(env = process.env): 'private' | 'public' {
  const mode = env.GLOGG_MODE?.trim() || 'private';
  if (mode !== 'private' && mode !== 'public') throw new Error('GLOGG_MODE must be private or public');
  if (mode === 'public' && env.GLOGG_ALLOW_PRIVATE_FETCH === '1') {
    throw new Error('Public mode cannot use GLOGG_ALLOW_PRIVATE_FETCH=1');
  }
  return mode;
}

export function capabilities(mode: 'private' | 'public') {
  const enabled = mode === 'private';
  return { mode, features: { tools: enabled, research: enabled, downloads: enabled, administration: enabled, savedProfiles: enabled } };
}

const READ_PATHS = /^\/api\/(?:health|capabilities|sources|auth|search|opensearch\/suggest|directory|deep(?:\/sites|\/random)?|favicon\/[^/]+|media\/image)\/?$/;
const WRITE_PATHS = /^\/api\/(?:search|inspect|auth\/login|auth\/logout)\/?$/;

/** Opt-in public service: a narrow allowlist, independent of Origin and shared-password auth. */
export const publicServiceGuard: RequestHandler = (req, res, next) => {
  if (!req.path.toLowerCase().startsWith('/api')) return next();
  const method = req.method === 'OPTIONS' ? String(req.headers['access-control-request-method'] || 'GET') : req.method;
  const allowed = (['GET', 'HEAD'].includes(method) && READ_PATHS.test(req.path)) || (method === 'POST' && WRITE_PATHS.test(req.path));
  if (allowed) return next();
  res.status(403).json({ error: 'This operation is unavailable on a public glogg. Use a private instance to manage services and data.' });
};

/** Public requests cannot select endpoints, inherit private keys, or enable private indexers. */
export function serviceSearchConfig(config: Partial<SearchFilterConfig>, env = process.env): Partial<SearchFilterConfig> {
  const safe: Partial<SearchFilterConfig> = {};
  const fields = ['lens', 'blockedDomains', 'boostedDomains', 'loweredDomains', 'pinnedDomains', 'blockedPhrases', 'maxPerDomain', 'slopThreshold', 'preLlmOnly', 'obscureWebOnly', 'stripSponsored', 'uncensoredMode'] as const;
  for (const key of fields) if (config[key] !== undefined) Object.assign(safe, { [key]: config[key] });
  safe.disabledSources = [...new Set([...(config.disabledSources ?? []), 'p2p', ...(env.GLOGG_PUBLIC_OPENLIBRARY === '1' ? [] : ['openlibrary'])])];
  safe.endpoints = { ...(env.SEARXNG_URL ? { searxngUrl: env.SEARXNG_URL } : {}) };
  return safe;
}
