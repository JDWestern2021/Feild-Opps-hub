# Local Development — FieldHub

## Prerequisites
- Docker Desktop (download at https://docker.com/products/docker-desktop)
- Node.js 18+ (`node --version`)
- The repo cloned with `.env.local` present in the root

## Cold start (first time, or after a machine restart)

```bash
# 1. Start the local Postgres container
npm run db:start

# 2. Reset to a clean database with test data
npm run db:reset
npm run db:seed

# 3. Start the server
npm run dev:local
```

Open http://localhost:3001 in your browser.
The startup log will print which database host you're pointed at:
```
  DATABASE: localhost (LOCAL)
```
If you ever see `(PRODUCTION ⚠)` in that line, stop immediately — something is wrong with your env setup.

## Daily start (after the first time)

```bash
npm run db:start      # starts Docker container if it stopped (data is preserved)
npm run dev:local     # start server
```

## Stop

```bash
# Ctrl+C stops the server.
npm run db:stop       # stops the container (data preserved in Docker volume)
```

## Full reset (clean slate, all local data wiped)

```bash
npm run db:reset      # drops + recreates database, applies schema
npm run db:seed       # populates test data
```

## Test credentials

| Email | Password | Role |
|---|---|---|
| admin@local.dev | admin123 | admin |
| office@local.dev | office123 | office |
| supervisor@local.dev | super123 | supervisor |
| lead@local.dev | field123 | lead_hand |
| field@local.dev | field123 | field |
| field2@local.dev | field123 | field |

## Phone testing (PWA + service worker)

Service workers require HTTPS even on a local network. One-time setup:

```bash
npm run https:setup
```

This downloads `mkcert`, installs a local certificate authority on your Mac,
and generates a cert for your LAN IP. Follow the on-screen instructions to
trust the CA on your phone (different steps for iOS vs Android).

After setup, `npm run dev:local` will print both URLs:
```
  HTTP  → http://localhost:3001
  HTTPS → https://localhost:3443
  Phone → https://192.168.x.x:3443   ← use this on your phone
```

Re-run `https:setup` if your LAN IP changes (e.g. after connecting to a different network).

## Schema drift check (run before deploying)

```bash
npm run db:diff
```

Compares your local schema against the baseline snapshot. If it shows drift,
review it before deploying — the `migrations/` folder has two ad-hoc SQL files
that may represent manual changes applied to production directly.

## How production is protected

1. `.env` (production credentials) is never loaded when `.env.local` is present.
2. `scripts/db-guard.js` reads `DATABASE_URL` and exits loudly if the host is not localhost.
   Every destructive script (`db:reset`, `db:seed`) calls this guard first.
3. There is no CI/CD pipeline. Production only changes when you SSH in manually and pull.
4. Nothing in this local setup connects to the Supabase-hosted production database.
