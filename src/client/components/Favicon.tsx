import React, { useContext, useState } from 'react';
import { faviconUrl, SiteIconsContext } from '../lib.js';

/**
 * A site's icon over a lettered tile, so a slow or missing icon never leaves
 * a blank square. The tile's tint is derived from the domain, so the same
 * site always gets the same colour.
 */
export function Favicon({ domain, size = 16 }: { domain: string; size?: number }) {
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  const icons = useContext(SiteIconsContext);
  const name = domain.replace(/^www\./, '');
  let hue = 0;
  for (const ch of name) hue = (hue * 31 + ch.charCodeAt(0)) % 360;
  return (
    <span className="favicon" style={{ width: size, height: size, fontSize: Math.round(size * 0.62), '--fav-hue': hue } as React.CSSProperties} aria-hidden>
      <span className="favicon-letter">{name.charAt(0).toUpperCase()}</span>
      {icons && !failed && (
        <img
          src={faviconUrl(name)}
          alt=""
          width={size}
          height={size}
          loading="lazy"
          className={loaded ? 'loaded' : ''}
          onLoad={() => setLoaded(true)}
          onError={() => setFailed(true)}
        />
      )}
    </span>
  );
}
