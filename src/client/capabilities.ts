import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { api } from './lib.js';

export interface Capabilities {
  mode: 'private' | 'public';
  features: { tools: boolean; research: boolean; downloads: boolean; administration: boolean; savedProfiles: boolean };
}
export const PRIVATE_FEATURES: Capabilities['features'] = { tools: true, research: true, downloads: true, administration: true, savedProfiles: true };
export const SAFE_FEATURES: Capabilities['features'] = { tools: false, research: false, downloads: false, administration: false, savedProfiles: false };
// Standalone components keep their existing private-instance contract. App always provides resolved capabilities.
export const FeaturesContext = createContext(PRIVATE_FEATURES);
export const useFeatures = () => useContext(FeaturesContext);

export function useCapabilities() {
  const [capabilities, setCapabilities] = useState<Capabilities | null>(null);
  const [failed, setFailed] = useState(false);
  const abort = useRef<AbortController | null>(null);
  const ready = useRef<Promise<Capabilities | null>>(Promise.resolve(null));
  const retry = useCallback(() => {
    setFailed(false);
    abort.current?.abort();
    const ctrl = new AbortController();
    abort.current = ctrl;
    const timeout = setTimeout(() => ctrl.abort(), 8000);
    const request = api<Capabilities>('/api/capabilities', { signal: ctrl.signal }).then((value) => {
      if (!value || !['private', 'public'].includes(value.mode) || !value.features || Object.keys(SAFE_FEATURES).some((key) => typeof value.features[key as keyof typeof SAFE_FEATURES] !== 'boolean')) throw new Error('Invalid capabilities');
      return { ...value, features: value.mode === 'public' ? SAFE_FEATURES : value.features };
    }).catch(() => null).finally(() => clearTimeout(timeout));
    ready.current = request;
    void request.then((value) => {
      if (ready.current !== request) return;
      setCapabilities(value);
      setFailed(!value);
    });
    return request;
  }, []);
  useEffect(() => {
    void retry();
    return () => { abort.current?.abort(); ready.current = Promise.resolve(null); };
  }, [retry]);
  return { capabilities, failed, retry, ready };
}
