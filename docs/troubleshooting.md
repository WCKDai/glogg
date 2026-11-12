# Troubleshooting

Start with the health check and the logs:

```bash
curl -s http://localhost:4173/api/health      # {"status":"ok",...}
docker compose logs -f glogg                   # Docker
# from source, glogg logs to the terminal it runs in
```

## Installing and starting

**`glogg needs Node.js 22.13 or newer`**
The deep index uses `node:sqlite`. Install a current Node (`fnm install 22`, `brew install node`, or nodejs.org) and run `npm install` again.

**`Port 4173 on 127.0.0.1 is already in use`**
Another glogg (or something else) has the port. Find it with `lsof -i :4173` (macOS/Linux) and stop it, or start glogg on another port: `PORT=4180 npm start`, or `GLOGG_PORT=4180` in `.env` for Docker.

**`WebSocket server error: Port 24678 is already in use` (dev only)**
Two `npm run dev` servers are running; the second one's hot reload is off. Stop the other one. Production (`npm start`) doesn't use that port.

**`docker: 'compose' is not a docker command`**
The Compose plugin is missing or Docker can't find it. On macOS with Homebrew: `brew install docker-compose`, then add `"cliPluginsExtraDirs": ["/opt/homebrew/lib/docker/cli-plugins"]` to `~/.docker/config.json`. On Linux, install `docker-compose-plugin` from Docker's repository.

**`Cannot connect to the Docker daemon`**
Docker isn't running. Start Docker Desktop / OrbStack, or `colima start`, or `sudo systemctl start docker`.

**The container restarts or shows `unhealthy`**
`docker compose logs glogg` says why. A password file that can't be read (`GLOGG_PASSWORD_FILE`) stops glogg on purpose rather than running it open.

**`npm install` warns about install scripts (esbuild)**
Newer npm versions ask before running packages' install scripts. glogg works without them; if a build complains that esbuild is missing, run `npm install-scripts approve esbuild` and `npm rebuild esbuild`.

## Searching

**Few results, or the status bar says sources were "turned away"**
Click the status bar: each source says what happened. Common reasons:

- **DuckDuckGo "Asked for a bot check" / Brave "Asked for a captcha".** These engines block servers. Run your own SearXNG (`docker compose --profile searxng up -d`), or add a Brave Search API key in Settings → Keys and services.
- **Marginalia: the shared key is over its limit.** Get a free personal key from marginalia.nu and add it in Settings → Keys and services.
- **Stack Exchange is out of the day's requests.** Register an app key at stackapps.com (10,000 requests a day instead of 300).
- **SearXNG "not set up".** Nothing answers at its address. Start it, or set its URL in Settings → Keys and services.
- **SearXNG returns nothing.** Its JSON output must be on: `search: formats: [html, json]` in its `settings.yml` (the bundled one already has it).

**Searches are slow on my network**
glogg connects over IPv4 first, because many networks advertise IPv6 they can't route. If yours is IPv6-only, set `GLOGG_HAPPY_EYEBALLS=1`. To trade completeness for speed, lower `GLOGG_HARD_DEADLINE_MS` (default 7000).

**Torrent or Usenet scopes are empty**
Public DHT and Internet Archive results need no setup, but most come from indexers you add: Torznab (Prowlarr/Jackett), Newznab (NZBHydra2), NZB.life, or Bitmagnet. See [usage.md](./usage.md#torrents-and-usenet-search).

## Reader, Research and tools

**"… is a private or local address, and glogg only fetches public pages"**
The reader, Research and the deep index refuse private and local addresses, so a link can't make glogg read your router or cloud metadata. To read pages on your own network, set `GLOGG_ALLOW_PRIVATE_FETCH=1`.

**Research writes no answer, only quotes**
No model is set, or it failed. Check Tools → AI → settings, then try `>ai hello` in the search box: the error says what the provider answered (a wrong key, an unknown model, Ollama not running).

**A tool times out**
Tools get 45 s (`GLOGG_TOOL_TIMEOUT_MS`). Slow third-party services (PageSpeed, WHOIS) sometimes need a retry.

## Downloads

**Send does nothing useful / goes to the wrong place**
Send uses the first destination that's set up: Offcloud, aria2, Nextcloud, then this machine. Pick a specific one from the Send menu, or remove the keys of ones you don't want.

**Nextcloud refuses the upload**
Use an **app password** (Nextcloud → Settings → Security → Devices & sessions), not your login password, and check the folder exists or can be created.

## Behind a proxy or on a public address

**`Host "…" isn't allowed`**
glogg answers only to `localhost`, IP addresses and names you list. Add yours: `GLOGG_ALLOWED_HOSTS=glogg.example.com`.

**"Too many wrong passwords" for everyone at once**
glogg can't see real client addresses, so everyone looks like the proxy. Set `GLOGG_TRUST_PROXY` to match your proxy (`loopback` for one on the same machine, `uniquelocal` for one in Docker, or its subnet).

**Signed out after changing the password**
Expected: sessions are tied to the password.

## Still stuck?

[Open an issue](https://github.com/WCKDai/glogg/issues/new/choose) with your install method, OS, `node -v` or `docker version`, and the log lines around the problem. Remove keys and passwords first.
