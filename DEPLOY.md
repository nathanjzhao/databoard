# Deploying DataBoard

Target: Vercel serverless + Turso (libSQL). The app builds with `npm run build`
(which regenerates `lib/schema.generated.ts` from `db/schema.sql` first, so
there are no runtime fs reads).

## Environment variables

Set these on the Vercel project (Production):

| Variable             | Value                                                          |
| -------------------- | -------------------------------------------------------------- |
| `SERVER_PEPPER`      | `openssl rand -hex 32`. Permanent for a given database: rotating it orphans every account and re-keys every buyer token. |
| `TURSO_DATABASE_URL` | `libsql://<db>-<org>.<region>.turso.io`                        |
| `TURSO_AUTH_TOKEN`   | A database auth token (see Turso setup below)                  |
| `BLIND_TENDER_DEMO`  | Optional. Unset or `true` = demo mode (verification codes shown in the UI). `false` requires a delivery provider wired into `lib/verify.ts`. |

If `TURSO_DATABASE_URL`/`TURSO_AUTH_TOKEN` are absent in production, the app
deploys and runs but every data-backed page shows a "database not configured"
notice instead of crashing.

Non-interactive way to set a variable:

```sh
printf '%s' "<value>" | vercel env add SERVER_PEPPER production
```

## Turso setup

With the CLI:

```sh
turso auth login
turso db create blind-tender
turso db show blind-tender --url        # -> TURSO_DATABASE_URL
turso db tokens create blind-tender     # -> TURSO_AUTH_TOKEN
```

Or without the CLI, using a platform API token (`TURSO_API_TOKEN`):

```sh
# create the database in an existing group
curl -X POST -H "Authorization: Bearer $TURSO_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"blind-tender","group":"<group>"}' \
  https://api.turso.tech/v1/organizations/<org>/databases

# mint a database auth token
curl -X POST -H "Authorization: Bearer $TURSO_API_TOKEN" \
  "https://api.turso.tech/v1/organizations/<org>/databases/blind-tender/auth/tokens?expiration=never&authorization=full-access"
```

## Apply the schema remotely

The schema is applied idempotently on the first query anyway, but you can
apply it explicitly (and confirm the table list) from your machine:

```sh
npm run gen:schema
TURSO_DATABASE_URL=libsql://... TURSO_AUTH_TOKEN=... node scripts/apply-remote.ts
```

## Seed against production

The seed writes through the real code paths (scrypt, HMAC blind indexes,
buyer tokens), so it must run with the SAME `SERVER_PEPPER` as production.
Pull the production env and run the seed against the remote database:

```sh
vercel env pull .env.production.local --environment=production
set -a; source .env.production.local; set +a
npm run seed
```

Demo accounts: `quiet-ledger`, `granite-fox`, `midnight-audit`, `paper-trail`,
`cold-copy`, `vellum`, all with password `demo-demo-demo`.

## Deploy

```sh
vercel link --yes --project blind-tender --scope <scope>   # first time only
vercel deploy --prod --yes
```

Sanity checks after deploy:

```sh
curl -sI https://<prod-url>/              # 307 -> /gate (logged out)
curl -sI https://<prod-url>/gate          # 200
curl -sI https://<prod-url>/transparency  # 200
curl -s -X POST https://<prod-url>/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"quiet-ledger","password":"demo-demo-demo"}'   # {"username":"quiet-ledger"}
```

## Redeploy

Config-only changes (env vars) need a fresh deployment to take effect:

```sh
vercel deploy --prod --yes
```

Schema changes: edit `db/schema.sql` (additively; everything is
`CREATE ... IF NOT EXISTS`), rerun `node scripts/apply-remote.ts` with prod
env, then redeploy.
