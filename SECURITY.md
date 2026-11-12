# Security policy

## Reporting a vulnerability

Please report security problems **privately**:

- [Open a private security advisory](https://github.com/WCKDai/glogg/security/advisories/new) (preferred), or
- email **boy@wckd.cc** with "glogg security" in the subject.

Include what's affected, how to reproduce it, and what an attacker gains. You'll get an answer within 7 days. Fixes are released as soon as they're ready, and you're credited in the changelog unless you'd rather not be.

Please don't open public issues for vulnerabilities, and don't test against glogg instances you don't own.

## Supported versions

glogg is pre-1.0 and released from `main`. Security fixes go into the latest release only; update with `git pull` and a rebuild ([docs/install.md](./docs/install.md#update)).

## What's in scope

glogg holds API keys (debrid, cloud storage, AI) and runs tools on your server, so these matter most:

- reading or changing keys and settings without being signed in, or from another website;
- getting glogg to fetch private or local addresses (SSRF) when `GLOGG_ALLOW_PRIVATE_FETCH` is off;
- script or markup from search results, pages, feeds or tool output running in glogg's page (XSS);
- writing files outside the downloads folder, or overwriting files;
- bypassing the password, the sign-in rate limit, or the `Host` check;
- command injection through the container manager or plugins' inputs.

Out of scope: problems that need an attacker to already control your glogg server, its data folder or a plugin you installed; denial of service by sending a lot of traffic; and missing hardening headers without a demonstrated impact.

## How glogg protects you

The full list is in [Security in the README](./README.md#security). In short:

- **Local by default.** glogg listens on `127.0.0.1`, and Docker Compose publishes it there only. On a network, set `GLOGG_PASSWORD`.
- **Keys stay on the server.** They're stored in glogg's data folder with mode 600 and masked in every API response.
- **No telemetry.** The page loads nothing from third parties; site icons are proxied through glogg, and no page sends a `Referer`.
- **Untrusted content stays untrusted.** Pages are cleaned on the server, rendered as text, and the app runs under a strict Content Security Policy. Research tells models to ignore instructions found in pages.
- **Public fetches only.** The reader, Research and the deep index refuse private addresses at every redirect.
- **Containers without a shell.** The container manager calls `docker`/`podman` with `execFile` and an allowlist of services, never a shell string. glogg's own container runs read-only, as an unprivileged user, with every capability dropped.
- **CI.** Tests can't reach the network; dependencies are audited (`npm audit`) and updated by Dependabot.
