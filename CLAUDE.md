# FieldHub — Claude Code Working Rules

## Stack
- Node.js + Express backend, vanilla HTML/CSS/JS frontend (no bundler)
- PostgreSQL via `pg` pool (Supabase-hosted in prod, Docker locally)
- Custom session auth (`express-session` + `connect-pg-simple`), no RLS
- All schema in `db.js → initSchema()` — idempotent, runs on every startup
- No Supabase JS client — direct TCP to Postgres only

## How to work

### Always investigate before touching anything
Read the relevant files first. Report root cause and a plan with the list of
files to be changed. Wait for approval before writing code.

### Feature branches only
Every change goes on a feature branch (`feature/`, `fix/`). Never commit
directly to `main`. Never push to GitHub without explicit user approval.

### No deployment without explicit instruction
Do not SSH anywhere. Do not modify `.env`. Do not run `git push` unless asked.
Production changes only when the user says to deploy.

## Database rules — READ THIS EVERY SESSION

**Never run any script against a non-localhost database.**
`scripts/db-guard.js` enforces this in code, but the rule applies to you too:
- Do not construct queries against `DATABASE_URL` if it contains anything other
  than `localhost` or `127.0.0.1`.
- Do not modify or read `.env` (production credentials live there).
- Local dev uses `.env.local`, loaded automatically by `server.js`.

The guard will exit loudly if pointed at a remote host. This is the backstop
against production accidents.

## File storage
- All file uploads go into Postgres as BYTEA with `mime_type` and `file_name`.
- Do NOT write to `public/uploads/` — that directory is gitignored and wiped
  on every Hostinger deploy.
- Pattern to follow: `sop_documents` table in `db.js`.

## Permit tracking
- `getPermitStatus(project, documents, inspections, recentTicketCount)` is the
  single source of truth — 12-state notifier machine in `server.js`.
- `permit_required = 'unset'` must never block archiving.
- Inspections are table records, not booleans.

## Access control
- `requireAuth` — any logged-in user
- `requireAdmin` — admin role only
- `requirePermission(module, action)` — granular permission check
- Enforcement goes in the query layer, not scattered `if (user.role ===)` checks.
- Pattern for project-scoped access (not yet built): `assertAccess(userId, projectId, module, action)`.

## Schema drift
`initSchema()` is additive only (CREATE TABLE IF NOT EXISTS, ALTER TABLE ADD
COLUMN IF NOT EXISTS). Keep it that way. The moment anything drops or alters an
existing column, the auto-healing guarantee is gone. New features = new tables
or new columns only.

Before deploying, run `npm run db:diff` to check for drift between local schema
and the snapshot in `migrations/000_local_schema_snapshot.sql`. Those two ad-hoc
SQL files in `migrations/` suggest manual changes may have been applied to prod
directly — verify before deploying schema changes.

## Local dev commands
```
npm run db:start    # start Docker Postgres container
npm run db:stop     # stop container (data preserved)
npm run db:reset    # drop + recreate + initSchema (local only, guard enforced)
npm run db:seed     # populate test data
npm run db:diff     # schema drift check
npm run dev:local   # start server (auto-loads .env.local)
npm run https:setup # one-time: install mkcert, generate LAN certs for phone testing
```

## Test credentials (local seed only, never production)
```
admin@local.dev      / admin123   (admin)
office@local.dev     / office123  (office)
supervisor@local.dev / super123   (supervisor)
lead@local.dev       / field123   (lead_hand)
field@local.dev      / field123   (field)
field2@local.dev     / field123   (field)
```
