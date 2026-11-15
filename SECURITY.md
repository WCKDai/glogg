# Security policy

## Reporting a vulnerability

Please report security vulnerabilities **privately**:

- [Open a private GitHub Security Advisory](https://github.com/WCKDai/glogg/security/advisories/new) (preferred), or
- email **boy@wckd.cc** with `"glogg security"` in the subject line.

Include the affected component or mode (`private` vs `public`), reproduction steps, and the concrete impact. You will receive an initial response within 7 days. Fixes ship on `main` as soon as they are verified, with credit in [`CHANGELOG.md`](./CHANGELOG.md) unless you prefer to remain anonymous.

Please do not open public issues for undisclosed vulnerabilities, and never test exploits against public glogg instances you do not operate.

## Supported versions

glogg is pre-1.0 and maintained on `main` (latest release `0.5.x`). Security fixes land in the latest release; upgrade with `git pull` and rebuild ([`docs/install.md`](./docs/install.md#update)).

## Scope

glogg runs in two modes — `GLOGG_MODE=private` (personal workbench holding API keys and tools) and `GLOGG_MODE=public` (multi-user public search service). High-priority issues include:

- Reading or modifying stored keys, profiles, or plugin settings without authentication or cross-origin;
- Reaching administrative, plugin, download, crawl, or private-key surfaces when `GLOGG_MODE=public`;
- Server-Side Request Forgery (SSRF) or DNS-rebinding bypasses in the reader, Research, media proxy, or Deep Index when `GLOGG_ALLOW_PRIVATE_FETCH` is unset;
- Cross-Site Scripting (XSS) or Content Security Policy bypasses from upstream search snippets, cleaned pages, feeds, or tool outputs;
- Path traversal or arbitrary file overwrite in the download manager;
- Bypassing `GLOGG_PASSWORD`, session revocation, sign-in rate limiting, `GLOGG_TELEMETRY_TOKEN`, or the `Host` allowlist;
- Command injection in container orchestration or plugin inputs.

**Out of scope:** attacks requiring prior root/shell access to the host or writable `$GLOGG_HOME`, volumetric network DoS, and theoretical header scanners without a demonstrable exploit path.

## Built-in defenses

See [Security in `README.md`](./README.md#security) and [`docs/public-service.md`](./docs/public-service.md) for full details:

- **Loopback by default:** binds to `127.0.0.1` unless explicitly configured otherwise.
- **Hardened `public` mode:** disables plugins, downloads, private indexers, crawl administration, and caller-supplied backend URLs at process startup.
- **DNS-pinned public fetches:** resolves each redirect hop once, blocks loopback/private/link-local/metadata addresses (and mixed DNS sets), and pins socket connections to the validated IP while preserving TLS SNI.
- **Strict CSP & zero third-party leaks:** hash-locked CSP (`frame-ancestors 'none'`), `Referrer-Policy: no-referrer`, and same-origin proxying for favicons and Commons thumbnails.
- **Shell-free container execution:** invokes `docker`/`podman` via `execFile` with strict service allowlists; production containers run unprivileged with `read_only: true`, `cap_drop: [ALL]`, and `no-new-privileges:true`.
