# Security & Privacy Policy

## Privacy by Design

`glogg` is built to counter surveillance capitalism, SEO spam, and algorithmic manipulation:
- **Zero Telemetry**: `glogg` contains no analytics scripts, telemetry beacons, or third-party tracking pixels.
- **URL Hygiene**: Every result URL and inspected page link is automatically scrubbed of tracking parameters (`utm_*`, `gclid`, `fbclid`, `msclkid`, `mc_eid`, `igshid`, affiliate tags) via `stripTrackingFromUrl`.
- **HTML Sanitization**: The Deshittified Reader (`cleanAndAutopsyHtml` in `src/core/pageCleaner.ts`) strips `<script>`, `<iframe>`, `<object>`, `<embed>`, inline event handlers, ad-network scripts, and affiliate redirect funnels before rendering extracted content.
- **P2P Swarm Hygiene**: `assessP2PHealth` in `src/core/p2pUtils.ts` flags suspicious `.exe` / `.scr` / `.bat` archive stubs and fake low-byte video placeholders as `suspect-spam` (`+75` slop penalty) so they are automatically filtered out.

## Container Orchestrator Security

The local container orchestrator (`server/containerManager.ts`) uses `node:child_process.execFile` (never shell string interpolation) and strictly validates `serviceId` against an allowlist (`bitmagnet`, `ipfs-kubo`, `searxng`, `prowlarr`, `nzbhydra2`, `tor-proxy`) before invoking `docker` or `podman`.

## Reporting a Vulnerability

If you discover a security vulnerability in `glogg`, please open a security advisory on GitHub at `https://github.com/WCKDai/glogg/security/advisories` or contact `boy@wckd.cc`.
