# Installing glogg

glogg is one Node.js server that serves the web app, the API and the deep index. You can run it three ways:

| Way | Best for | You need |
| :--- | :--- | :--- |
| [Docker Compose](#1-docker-compose) | Running it on your own machine or a home server | Docker with the Compose plugin (or Podman) |
| [From source](#2-from-source) | Development, or a machine without Docker | Node.js **22.13 or newer**, npm, git |
| [Coolify](#3-coolify) | A public address with HTTPS and a password | A Coolify server |

Once it runs, open <http://localhost:4173> and see the [usage guide](./usage.md). If something goes wrong, see [troubleshooting](./troubleshooting.md).

---

## 1. Docker Compose

```bash
git clone https://github.com/WCKDai/glogg.git
cd glogg
cp .env.example .env          # optional: every setting in it is commented out
docker compose up -d
```

Open <http://localhost:4173>. The first build takes a minute or two; later starts take seconds.

Add a private [SearXNG](https://docs.searxng.org) for better general web results. glogg is already pointed at it:

```bash
docker compose --profile searxng up -d
```

### Getting Docker

| System | Recommended | Notes |
| :--- | :--- | :--- |
| macOS | [Docker Desktop](https://www.docker.com/products/docker-desktop/), [OrbStack](https://orbstack.dev) or [Colima](https://github.com/abiosoft/colima) | With Colima or Homebrew's `docker`, also install the Compose plugin (below) |
| Linux | Docker Engine from [docs.docker.com/engine/install](https://docs.docker.com/engine/install/) | Includes `docker compose`. Add yourself to the `docker` group, or use `sudo` |
| Windows | Docker Desktop with the WSL 2 backend | Clone and run inside your WSL distribution for speed |
| Any | [Podman](https://podman.io) 4+ | Use `podman compose up -d` (needs `podman-compose` or the Docker Compose binary) |

#### macOS with Homebrew and Colima

```bash
brew install colima docker docker-compose
colima start --cpu 4 --memory 4
```

Homebrew installs Compose as a Docker CLI plugin in a folder Docker doesn't search. Tell Docker where it is by adding this to `~/.docker/config.json` (create the file if it's missing; keep any keys already in it):

```json
{
  "cliPluginsExtraDirs": ["/opt/homebrew/lib/docker/cli-plugins"]
}
```

On Intel Macs the folder is `/usr/local/lib/docker/cli-plugins`. Check with `docker compose version`.

### Day to day

| Task | Command |
| :--- | :--- |
| Logs | `docker compose logs -f glogg` |
| Stop | `docker compose down` (your data stays in the `glogg-data` volume) |
| Update | `git pull && docker compose up -d --build` |
| Status | `docker compose ps` (the container reports `healthy` once `/api/health` answers) |
| Shell | `docker compose exec glogg sh` |

### Your data

Settings, keys, plugins and the deep index live in the `glogg-data` volume (`/data` in the container). Stop glogg while you back up or restore, so the deep index's SQLite database isn't copied mid-write. Run these from the glogg folder; the first line finds the volume's real name, even under another Compose project name (`-p` or `COMPOSE_PROJECT_NAME`).

```bash
VOL=$(docker compose config | awk '/^volumes:/ { v = 1 } v && $1 == "name:" { print $2; exit }')
echo "$VOL"                  # e.g. glogg_glogg-data

# Back up
docker compose stop glogg
# The archive holds your keys, so your shell writes it, readable by you only (0600), to a
# temporary file of its own; the previous backup is replaced only once the new one is complete.
tmp=$(mktemp glogg-data.tgz.XXXXXX) \
  && { docker run --rm -v "$VOL":/data:ro alpine tar czf - -C /data . > "$tmp" && mv "$tmp" glogg-data.tgz || { rm -f "$tmp"; false; }; }
docker compose start glogg

# Restore
docker compose stop glogg
# Reads the whole archive first: if it's missing or corrupt, nothing in the volume is touched.
docker run --rm -v "$VOL":/data -v "$PWD":/backup:ro alpine \
  sh -c 'tar tzf /backup/glogg-data.tgz >/dev/null && find /data -mindepth 1 -delete && tar xzf /backup/glogg-data.tgz -C /data'
docker compose start glogg
```

### Reaching it from other devices

Compose publishes glogg on `127.0.0.1` only. To open it to your network:

1. Set a password in `.env`: `GLOGG_PASSWORD=<a long passphrase>`.
2. In `docker-compose.yml`, change `"127.0.0.1:${GLOGG_PORT:-4173}:4173"` to `"${GLOGG_PORT:-4173}:4173"`.
3. If you use a host name rather than an IP, add `GLOGG_ALLOWED_HOSTS=glogg.home.example` to `.env`.
4. Since the port is now reachable directly, set `GLOGG_TRUST_PROXY=loopback` in `.env`.
5. `docker compose up -d`.

### The optional services stack

[`infra/docker-compose.services.yml`](../infra/docker-compose.services.yml) runs backends glogg can use: SearXNG, Bitmagnet (DHT torrent index), Kubo (IPFS), aria2 (downloads), Prowlarr, NZBHydra2 and Nextcloud. Their admin ports listen on `127.0.0.1` only.

```bash
npm run services:up      # or: docker compose -f infra/docker-compose.services.yml up -d
npm run services:down
```

When glogg runs from source, its **Services** page can start and stop these for you. Inside glogg's own container that page is off (`GLOGG_CONTAINER_RUNTIME=none`), because a container shouldn't drive the Docker daemon.

---

## 2. From source

### Prerequisites

- **Node.js 22.13 or newer.** The deep index uses `node:sqlite`, which older versions lack; glogg says so and exits if Node is too old. Check with `node -v`.
  - macOS: `brew install node` or [fnm](https://github.com/Schniz/fnm) / [nvm](https://github.com/nvm-sh/nvm): `fnm install 22 && fnm use 22`.
  - Linux: [NodeSource](https://github.com/nodesource/distributions), fnm or nvm. Distribution packages are often too old.
  - Windows: the installer from [nodejs.org](https://nodejs.org), or fnm.
- git.
- Optional: Docker or Podman for the services stack, and Chrome or Chromium for the browser tests.

### Run it

```bash
git clone https://github.com/WCKDai/glogg.git
cd glogg
npm install
npm run dev               # http://localhost:4173, reloads as you edit
```

For everyday use, run the production build. It's faster and serves compressed, cached assets:

```bash
npm run build
npm start                 # http://localhost:4173
```

Settings go in environment variables; see [Configuration](../README.md#configuration). For example:

```bash
PORT=8088 GLOGG_HOME=~/glogg-data npm start
```

glogg listens on `127.0.0.1` unless you set `HOST`. To use it from your phone or another computer, set both `HOST=0.0.0.0` and `GLOGG_PASSWORD`.

### Keep it running

#### Linux (systemd)

`/etc/systemd/system/glogg.service`:

```ini
[Unit]
Description=glogg
After=network-online.target
Wants=network-online.target

[Service]
User=glogg
WorkingDirectory=/opt/glogg
Environment=NODE_ENV=production
Environment=GLOGG_HOME=/var/lib/glogg
# Environment=HOST=0.0.0.0
# EnvironmentFile=/etc/glogg.env   # GLOGG_PASSWORD=... and any keys
ExecStart=/usr/bin/npm start
Restart=on-failure
NoNewPrivileges=true
ProtectSystem=strict
PrivateTmp=true
ReadWritePaths=/var/lib/glogg

[Install]
WantedBy=multi-user.target
```

```bash
sudo useradd --system --home /var/lib/glogg --create-home glogg
sudo git clone https://github.com/WCKDai/glogg.git /opt/glogg && cd /opt/glogg
sudo npm ci && sudo npm run build
sudo systemctl daemon-reload && sudo systemctl enable --now glogg
journalctl -u glogg -f
```

glogg stops cleanly on `SIGTERM`: it finishes open requests (up to 5 s) and closes the deep index database.

#### macOS (launchd)

`~/Library/LaunchAgents/app.glogg.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>app.glogg</string>
  <key>WorkingDirectory</key><string>/Users/YOU/glogg</string>
  <key>ProgramArguments</key>
  <array><string>/opt/homebrew/bin/npm</string><string>start</string></array>
  <key>EnvironmentVariables</key>
  <dict><key>PATH</key><string>/opt/homebrew/bin:/usr/bin:/bin</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/tmp/glogg.log</string>
  <key>StandardErrorPath</key><string>/tmp/glogg.log</string>
</dict>
</plist>
```

```bash
launchctl load ~/Library/LaunchAgents/app.glogg.plist
```

### Update

```bash
git pull
npm ci
npm run build
# then restart: systemctl restart glogg / launchctl kickstart -k gui/$UID/app.glogg / Ctrl-C and npm start
```

### Uninstall

Delete the clone, and glogg's data folder (`~/.glogg` unless you set `GLOGG_HOME`). Files Send saved locally are in `~/Downloads/glogg`.

---

## 3. Coolify

See [Coolify in the README](../README.md#coolify): point Coolify at this repository with **Docker Compose** and `/docker-compose.coolify.yml`. You get HTTPS, a generated password and a private SearXNG.

---

## Behind your own reverse proxy

Any proxy works. Set a password, tell glogg its host name, and trust the proxy's forwarded address.

**Caddy** (HTTPS automatically):

```caddyfile
glogg.example.com {
  reverse_proxy 127.0.0.1:4173
}
```

**nginx** (certificates from [Certbot](https://certbot.eff.org), for example; never serve the sign-in page over plain HTTP):

```nginx
server {
  listen 80;
  server_name glogg.example.com;
  return 301 https://$host$request_uri;
}

server {
  listen 443 ssl;
  server_name glogg.example.com;
  ssl_certificate     /etc/letsencrypt/live/glogg.example.com/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/glogg.example.com/privkey.pem;
  location / {
    proxy_pass http://127.0.0.1:4173;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_buffering off;   # search results stream in
  }
}
```

and in glogg's environment:

```bash
GLOGG_PASSWORD=<long passphrase>
GLOGG_ALLOWED_HOSTS=glogg.example.com
GLOGG_TRUST_PROXY=loopback        # the proxy runs on the same machine
```

## Browser extension

```bash
npm run build:extension
```

Then load `dist-extension/` as an unpacked extension: `chrome://extensions` → **Developer mode** → **Load unpacked** (Chrome, Edge, Brave, Vivaldi). It works without glogg running: it strips sponsored results and SEO farms from Google, DuckDuckGo, Brave Search and Bing, and marks primary and independent sources.

## Verify an install

```bash
curl -s http://localhost:4173/api/health
# {"status":"ok","service":"glogg-engine","version":"0.4.0","connectors":20}
npm run cli -- search "sqlite wal mode"
```
