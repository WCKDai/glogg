# glogg HTTP API

Everything the web app does goes through this API, so scripts can do it too. Request and response bodies are JSON unless noted.

On an open glogg (no password), `/api/health`, `/api/search`, `/api/opensearch/suggest`, `/api/directory`, `/api/ipfs/:cid` and `/opensearch.xml` are public. Every other route answers only glogg itself, browser extensions, local tools without an `Origin` header (curl, the CLI) and origins in `GLOGG_ALLOWED_ORIGINS`.

With `GLOGG_PASSWORD` set, every route except `/api/health` and the three `/api/auth` routes needs the session cookie from `POST /api/auth/login`, including the routes that are otherwise public. See [Security](../README.md#security).

| Endpoint | Method | Description |
| :--- | :--- | :--- |
| `/api/health` | `GET` | Liveness: `{status: "ok", …}` |
| `/api/auth` | `GET` | `{required, authenticated}`: whether this glogg has a password, and whether this request has a session |
| `/api/auth/login` | `POST` | `{password}` → `204` and the session cookie, `401` for a wrong password, `429` (with `Retry-After`) after ten wrong ones from one address |
| `/api/auth/logout` | `POST` | Clears the session cookie |
| `/api/search` | `POST` / `GET` | Federated search: `{query, lens?, uncensoredMode?, …}` or `?q=…&lens=…&uncensored=true` |
| `/api/opensearch/suggest` | `GET` | Search suggestions for browsers (`?q=`) |
| `/api/research` | `POST` | Research a query. Streams newline-delimited JSON events: `status`, `sources`, `delta`, `notice`, `done`, `error`. Body: `{query, candidates?, instantAnswer?, depth?, history?}` |
| `/api/inspect` | `POST` | Clean a URL or raw HTML for reading and pull out the primary sources it cites |
| `/api/directory` | `GET` | The hand-picked Atlas (`?category=…&shuffle=true`) |
| `/api/ipfs/:cid` | `GET` | Resolve an IPFS CID through the local Kubo gateway, with a public fallback |
| `/api/deep` | `GET` | Deep index status: posts, sources visited per kind, crawl state, size |
| `/api/deep/crawl` | `POST` | `{action: "start" \| "pause" \| "reseed"}` |
| `/api/deep/sites` | `GET` | The directory: `?kind=blog\|site\|board\|forum&origin=&q=&order=posts\|random\|name&offset=&limit=&nsfw=`. Returns `{total, items, counts, origins, errors, loading}`; the first call loads the open directories (it never crawls) |
| `/api/deep/sources` | `POST` | Add `{url, nsfw?}`; the kind (feed, Discourse forum, board catalog, page with a feed) is detected |
| `/api/deep/random` | `GET` | A random indexed post (`?kind=&nsfw=`) |
| `/api/downloads` | `GET` / `POST` | List jobs (with live aria2/Offcloud progress), or queue `{url, title?, target?}` |
| `/api/downloads/:id` | `DELETE` | Remove a job (`finished` clears all finished jobs) |
| `/api/integrations` | `GET` / `PUT` | Read the masked integration settings, or save `{config}` |
| `/api/plugins` | `GET` | Plugins with their tools and masked settings |
| `/api/plugins/reload` | `POST` | Re-scan the built-in and user plugin folders |
| `/api/plugins/:id/settings` | `PUT` | Save `{values}`; masked values are kept, empty values clear |
| `/api/plugins/:id/tools/:tool` | `POST` | Run a tool with `{input}`; returns `{blocks, summary?}` |
| `/api/plugins/:id/container` | `GET` / `POST` | A plugin's container status, or `{action: "up" \| "down" \| "remove"}` |
| `/api/containers` | `GET` | The optional services stack: Docker/Podman/Colima status and the 7 managed services |
| `/api/containers/action` | `POST` | `up`, `stop`, `restart`, `logs`, `stack-up`, `stack-down` or `start-daemon` (refused with `GLOGG_CONTAINER_RUNTIME=none`) |
| `/api/nodes` | `GET` | Reachability of the self-hosted services and upstream connectors |
| `/opensearch.xml` | `GET` | OpenSearch 1.1 descriptor, so a browser can use glogg as its search engine |
