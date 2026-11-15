/// <reference types="vite/client" />
import React, { useEffect, useRef, useState } from 'react';

export function PwaStatus() {
  const [offline, setOffline] = useState(!navigator.onLine);
  const [waiting, setWaiting] = useState<ServiceWorker | null>(null);
  const [failed, setFailed] = useState(false);
  const updating = useRef(false);
  useEffect(() => {
    let disposed = false;
    let registration: ServiceWorkerRegistration | undefined;
    let installing: ServiceWorker | null = null;
    const connection = () => setOffline(!navigator.onLine);
    const installed = () => {
      if (!disposed) setWaiting(navigator.serviceWorker.controller ? registration?.waiting ?? null : null);
    };
    const found = () => {
      installing?.removeEventListener('statechange', installed);
      installing = registration?.installing ?? null;
      installing?.addEventListener('statechange', installed);
    };
    const controlled = () => { if (updating.current) window.location.reload(); };
    window.addEventListener('online', connection);
    window.addEventListener('offline', connection);
    if (import.meta.env.PROD && window.isSecureContext && 'serviceWorker' in navigator) {
      navigator.serviceWorker.addEventListener('controllerchange', controlled);
      void navigator.serviceWorker.register('/sw.js', { updateViaCache: 'none' }).then((reg) => {
        if (disposed) return;
        registration = reg;
        installed();
        found();
        reg.addEventListener('updatefound', found);
      }).catch(() => { if (!disposed) setFailed(true); });
    }
    return () => {
      disposed = true;
      window.removeEventListener('online', connection);
      window.removeEventListener('offline', connection);
      navigator.serviceWorker?.removeEventListener('controllerchange', controlled);
      registration?.removeEventListener('updatefound', found);
      installing?.removeEventListener('statechange', installed);
    };
  }, []);
  if (!offline && !waiting && !failed) return null;
  return <div className="pwa-status" role="status">
    {offline ? 'Offline. Saved links are available; search and reading need a connection.' : waiting ? <>
      Update ready. <button className="link-btn" onClick={() => { updating.current = true; waiting.postMessage({ type: 'SKIP_WAITING' }); }}>Reload</button>
    </> : 'Offline access could not be prepared. Reload to try again.'}
  </div>;
}
