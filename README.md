# MeatyBeatz — self-hosted YouTube Music with bundled Invidious

A free, browser-based YouTube Music player. One `docker compose up` gives you
the full stack: search, streaming, artist/album pages and your library — with a
bundled [Invidious](https://github.com/iv-org/invidious) instance, so there is
nothing else to set up. Works on Linux, Windows (Docker Desktop or WSL2) and
macOS; can also run as plain Node processes without Docker.

---
<img width="1499" height="1085" alt="Screenshot from 2026-10-24 02-27-21" src="https://github.com/user-attachments/assets/68c5efe5-a7bb-4ff1-af69-9ce503d6bb2c" />
<img width="1500" height="1078" alt="Screenshot from 2026-10-24 02-27-37" src="https://github.com/user-attachments/assets/9e37dec3-82d0-4562-995b-c992a8b6e23f" />
<img width="1495" height="1081" alt="Screenshot from 2026-10-24 02-42-39" src="https://github.com/user-attachments/assets/4f7e2bda-55e2-402e-8185-07668e03b017" />


---
## What's running (one compose file, four services)

| Service | Image | Host port | Purpose |
|---|---|---|---|
| `meatybeatz` | built from this folder (`node:24-alpine`) | **8097** | The MeatyBeatz web app + its SQLite disk DB (8198) + local proxy (8199) in one container |
| `invidious` | `quay.io/invidious/invidious:latest` (Invidious v2, Crystal) | **3010** | Search results + stream URLs for the player. The app finds it automatically at `<this-host>:3010`. |
| `invidious-companion` | `quay.io/invidious/invidious-companion:latest` | — (internal) | Helper service Invidious uses behind the scenes. No public ports. |
| `invidious-db` | `postgres:14` | — (internal) | Database for Invidious. No public ports. |

Where the data lives:

- **Your library** (`meatybeatz-data/`) — a bind-mounted folder next to the
  compose file. Owned by the uid the container runs as (default `1000`), never
  root at runtime.
- **Invidious + Postgres + companion data** — Docker **named volumes**
  (`postgresdata`, `companioncache`). Docker manages their ownership.

Resource note: the full stack idles around **400–600 MB of RAM**. Invidious v2
is a single static binary (much lighter than the old Scala version) and needs
no Redis.

If Invidious is ever slow or down, the app falls back to its built-in YouTube
route automatically — nothing breaks, you just lose the faster search/stream
path until it's back.

---
Notes: Before you get started review this for docker compose etc.

- Your library is created in `./meatybeatz-data/` next to the compose file,
  owned by uid `1000` (your normal user on most Linux distros). If your data
  folder should be owned by a different uid, set `MEATYBEATZ_UID` /
  `MEATYBEATZ_GID` in `docker-compose.yml` to match.
- **Required — your own secret keys for the bundled Invidious.** The compose
  file ships with no private keys, so generation is required. To generate two 16-character keys use 
  (`pwgen`, install via your distro's
  package manager if missing) and paste them into `docker-compose.yml` **before
  the first start**:
  ```bash
  pwgen 16 1   # → invidious service: 1st step for Invidious hmac_key (signed URLs)
  pwgen 16 1   # → invidious service: 2nd step for Invidious_companion_key — and the same value into invidious-companion: SERVER_SECRET_KEY (both must match)
  ```
  Both keys must be exactly 16 characters; if a generated key contains `"` or
  `\`, rerun pwgen. If you change them after first start, recreate with
  `docker compose up -d --force-recreate invidious invidious-companion`.
- **First start takes a little longer than usual:** Postgres initializes its
  schema and Invidious warms up (~30 s). If the first search comes back via the
  built-in route, wait a minute and try again — or check `docker compose ps`
  until `invidious` shows *healthy*.
- **Remote access works out of the box:** the web app figures out where the
  database, proxy and Invidious instance live from the address you typed in
  the browser. If you open example -- `http://192.168.1.50:8097`, it talks to
  `http://192.168.1.50:8198` (disk database), `http://192.168.1.50:8199`
  (local proxy) and `http://192.168.1.50:3010` (bundled Invidious). Just make
  sure those ports are published in `docker-compose.yml` and reachable from
  your computer — no extra configuration needed.
- Stop everything with `docker compose down`. Add `-v` to **also delete the
  Invidious/Postgres/companion named volumes** (search cache, sessions) — your
  music library in `./meatybeatz-data` is a bind mount and is NOT affected by
  `-v`.
---
## Quick start with Docker (Linux / Windows / macOS)

Requirements: Docker Engine with the Compose plugin (or Docker Desktop). On
Windows use Docker Desktop (WSL2 backend) or Docker inside WSL2.

1. Clone this project (`MeatyBeatz/`) to your machine, e.g.
   `~/music/MeatyBeatz` on Linux or `C:\Users\you\MeatyBeatz` on Windows
   ```bash
   git clone https://github.com/ensur3d/MeatyBeatz.git
   ```
2. Build and start:
   ```bash
   cd MeatyBeatz
   docker compose up -d --build
   ```
3. **Open http://127.0.0.1:8097** — done.

---

## Running without Docker (plain Node)

The same app with no containers: three small zero-dependency Node scripts serve
the web UI and its sidecars. Works on Linux and Windows (PowerShell or cmd).

Requirements: **Node ≥ 24** recommended — it includes built-in SQLite
(`node:sqlite`) for the disk database. Older Node still works; the disk DB then
falls back to a plain JSON state file instead of `meatybeatz.db`.

### Quick start (one command)

```bash
cd MeatyBeatz
node server/start.js
```

Starts everything at once, with tagged logs in one terminal:

| What | Address | Required? |
|---|---|---|
| Web UI | http://127.0.0.1:8097 | yes — the app itself |
| Disk database (SQLite) | 127.0.0.1:8198 | optional, recommended |
| YouTube local proxy | 127.0.0.1:8199 | optional (built-in fallback route) |

**Open http://127.0.0.1:8097.** Ctrl+C stops all three; if any of them dies
unexpectedly (e.g. its port is already taken), the launcher stops everything.

- Your library file is created in `server/` next to the scripts
  (`server/meatybeatz.db`, or `meatybeatz-state.json` on old Node without
  SQLite). Relocate it with an env var:
  `MEATYBEATZ_DB_FILE=/path/to/meatybeatz.db node server/start.js`.
- All `MEATYBEATZ_*` variables from the table below work in this mode too,
  e.g. `MEATYBEATZ_WEB_PORT=9000 node server/start.js`.
- A plain Node setup has **no bundled Invidious** — point the app at your own
  instance (next section) or use the built-in route.

### Individual servers

Run any of them on their own instead (each in its own terminal, or as a
service):

```bash
node server/static-server.js   # web UI  → http://127.0.0.1:8097   (required)
node server/db-server.js       # optional: SQLite disk DB → 127.0.0.1:8198
node server/local-proxy.js     # optional: YouTube direct proxy → 127.0.0.1:8199
```

`db-server.js` checks that its data folder is writable by the user running it
and prints an actionable permission message if not (no cryptic SQLite errors).

---

## Using your own (external) Invidious instance

The Docker stack bundles an Invidious instance so everything works out of the
box — but MeatyBeatz happily uses **any** Invidious build instead: one you host
yourself on another machine, a VPS instance, or any public instance.

1. Open **Settings → Invidious instance**.
2. Paste your instance's address, e.g. `http://192.168.1.40:3010` or
   `https://invidious.example.com` (no trailing slash needed; a missing
   `http://` is added for you).
3. **Save** — search and streaming now go through that instance immediately, no
   restart. Leave the field empty to use the default (`<this-host>:3010`).

Notes:

- **Plain Node setups have no bundled instance**, so this is how you get the
  fast search/stream path there (without it, the built-in route still works).
- **Docker users who don't want the bundled instance:** comment out the
  `invidious`, `invidious-companion` and `invidious-db` services in
  `docker-compose.yml`, run `docker compose up -d --build` again, and free up
  roughly half the stack's RAM. Then set your external URL in Settings as above.
- The instance's API must be reachable from your browser — Invidious sends CORS
  headers itself, so a normal setup just works. Public instances are often
  rate-limited or overloaded; if search or streaming degrades, the app falls
  back to the built-in route automatically, and self-hosting is the reliable fix.
- Extra instances for **search only** can be added under Settings → *Search
  instances* → Add (Invidious or Piped).

---

## Configuration

### In the app (Settings gear)

- **Invidious instance** — URL of the instance used for search + streaming.
  Default: the bundled instance, auto-detected as `<this-host>:3010` from the
  address you opened the app at. Changeable without touching code (leave it
  empty to use the default). For using an external/self-hosted Invidious build,
  see *Using your own (external) Invidious instance* above.
- **Extractor mode** — `Auto` / `Built-in` / `Invidious`.
- **Your data** — export/import a full JSON backup, or reset everything.

### Environment variables (server side)

| Variable | Default | Meaning |
|---|---|---|
| `MEATYBEATZ_WEB_HOST` / `MEATYBEATZ_WEB_PORT` | `0.0.0.0` / `8097` | Web UI bind address/port (in Docker) |
| `MEATYBEATZ_DB_HOST` / `MEATYBEATZ_DB_PORT` | `0.0.0.0` / `8198` | Disk DB API bind address/port (in Docker) |
| `MEATYBEATZ_DB_FILE` | `/data/meatybeatz.db` | Where the SQLite file lives |
| `MEATYBEATZ_STATE_FILE` | `/data/meatybeatz-state.json` | JSON fallback file (only if Node has no built-in SQLite) |
| `MEATYBEATZ_PROXY_HOST` / `MEATYBEATZ_PROXY_PORT` | `0.0.0.0` / `8199` | YouTube proxy bind address/port (in Docker) |
| `MEATYBEATZ_UID` | `1000` | uid the app runs as — set to the owner of your data folder |
| `MEATYBEATZ_GID` | `1000` | gid the app uses — set to the group of your data folder |

---

## Troubleshooting

- **"data folder /data is not writable by uid N"** — the mounted folder isn't
  owned by (or writable for) the uid the app runs as:
  ```bash
  ls -ln ./meatybeatz-data        # see who owns it
  chown -R 1000:1000 meatybeatz-data   # or set MEATYBEATZ_UID to the current owner
  docker compose up -d
  ```
- **No search results / nothing plays** — the bundled Invidious is probably
  not ready yet (first start ~30 s) or unreachable. Check Settings → *Test
  all* and `docker compose ps` (wait until `invidious` shows *healthy*). If
  it's healthy but a search still fails, retry — YouTube rate-limits fresh
  instances occasionally; the app falls back to the built-in route meanwhile.
- **Disk database shows "offline"** — the container isn't running, or a
  permission problem stopped it: check `docker logs meatybeatz`.
- **Port already in use** — change the host mapping in `docker-compose.yml`
  (e.g. `"8090:8097"`). If you remap 8198/8199, also update `DISK_BASE` in
  `app/js/store.js` and `PROXY` in `app/js/builtin.js`. If you remap **3010**
  (e.g. `"3020:3000"`), set the new address in Settings → *Invidious instance*
  on each device.
- **Reset Invidious only** — `docker compose down -v && docker compose up -d`
  recreates the Invidious/Postgres/companion volumes (your library folder is
  untouched); on next start, Postgres re-runs the `invidious-init/` schema
  scripts automatically.

---

## Features

- **Search & play** — search by song, artist or album name, or paste any
  YouTube video/playlist link.
- **Playback engine** — streams through the bundled Invidious instance (or any
  instance you add in Settings) into a native `<audio>` element; automatic
  fallback to the built-in keyless player.
- **Your library** — liked songs, liked albums, playlists, genre collections,
  recent searches, artist/album pages with full tracklists.
- **Player** — queue, shuffle, repeat one / repeat all, volume.
- **Works on phones** — the UI is responsive: touch-friendly controls, a
  compact two-row player bar, full-width queue sheet and tap-to-play rows;
  every desktop feature (search, import, collections, queue reorder) stays
  usable in a mobile browser.
- **Persistence** — browser storage (localStorage + IndexedDB) plus a real
  **SQLite file** on disk when the disk database runs. Newest copy wins; an
  empty disk copy can never overwrite a non-empty local one.

## Project structure

```
MeatyBeatz/
├── app/                      # the web app (vanilla JS, no build step)
│   ├── index.html
│   ├── styles.css
│   └── js/
│       ├── icons.js          # inline SVG icon set
│       ├── store.js          # 4-tier persistence (localStorage → IndexedDB → file → SQLite)
│       ├── youtube.js        # playback engine, URL parsing (defaults to <this-host>:3010)
│       ├── builtin.js        # built-in YouTube data route
│       ├── search.js         # search: Invidious/Piped/auto-race, artist/album pages
│       └── app.js            # UI, views, player controls, settings
├── server/                   # zero-dependency Node sidecars
│   ├── start.js              # one-command launcher for the no-Docker setup (web + db + proxy)
│   ├── static-server.js      # serves app/ (no-cache for html/css/js)
│   ├── db-server.js          # SQLite disk DB API (:8198) + data-dir preflight with clear errors
│   ├── local-proxy.js        # direct YouTube data proxy (:8199, optional)
│   └── docker-entrypoint.sh  # UID/GID-aware: prepares /data once, drops root, writability checks, diag mode
├── invidious-init/           # vendored from the Invidious v2 repo — Postgres schema bootstrap (runs once)
│   ├── init-invidious-db.sh
│   └── sql/                  # CREATE TABLE scripts for Invidious' Postgres database
├── Dockerfile                # node:24-alpine; MEATYBEATZ_UID/GID env (default 1000)
├── docker-compose.yml        # 4 services: meatybeatz + invidious + companion + postgres; named volumes for IV data
└── README.md
```

`invidious-init/` is plain text only — nine `CREATE TABLE` scripts (no data, no
secrets) that build Invidious' Postgres schema, vendored from the official
Invidious v2 repo. The Postgres image runs them **automatically, exactly once**,
when its volume is first created; they are never meant to be run manually
(running `init-invidious-db.sh` by hand fails with
`POSTGRES_USER: unbound variable`, because those variables exist only inside
the postgres container). To reset Invidious' database, see *Reset Invidious
only* below.

## Privacy

No accounts, no analytics, no third-party tracking, no paid APIs. Your library
never leaves your machine except to talk to your own Invidious instance and
YouTube itself.
