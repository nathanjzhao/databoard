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
| `BLIND_TENDER_DEMO`  | Optional. Unset or `true` = demo mode (verification codes shown in the UI). `false` requires a delivery provider; see "Going live" below. |
| `CRON_SECRET`        | `openssl rand -hex 32`. Authorizes the autoclose cron (see "Cron: stale-ask autoclose" below). With it set, Vercel sends `Authorization: Bearer <value>` on scheduled invocations; without it, the production cron endpoint answers 503 and no sweep runs. |

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

The seed also grants the operator flag to `quiet-ledger` (it shells out to
`scripts/grant-operator.ts`, the only writer to the operators table), so
/admin is reachable out of the box wherever the seed ran. On a real board,
grant flags by hand instead: `npm run grant-operator -- <handle>`.

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

## Going live (real OTP delivery)

Demo mode shows the verification code on screen. Going live means the code is
actually delivered, which needs a provider per contact kind: SES or Resend for
email, Twilio for SMS. Either alone is fine; `/api/auth/request-code` returns
503 ("email delivery is not configured" / "SMS delivery is not configured")
plus a `contactKinds` list for the kind that has no provider, and the signup
UI surfaces that copy.

Do this in order. Flipping the flag before a provider works locks signups out.

### 1a. Email via Amazon SES (configured 2026-08-24, preferred when present)

Already provisioned: domain identity `send.taiku.live` (DKIM verified via the
Route53 zone in account 975050290996), IAM user `databoard-otp` whose only
permission is `ses:SendEmail` on that identity, and production env vars
`SES_ACCESS_KEY_ID` / `SES_SECRET_ACCESS_KEY` / `SES_REGION` /
`OTP_EMAIL_FROM`. When both SES and Resend are configured, SES wins.

One gate remains: the SES account is in sandbox (verified recipients and the
mailbox simulator only) until AWS approves the production access request filed
the same day (typically under 24 hours). Check with:

    aws sesv2 get-account --region us-west-2 --query ProductionAccessEnabled

Once it prints `true`, flip the flag (step 3). Flipping while sandboxed would
bounce every signup from an unverified address.

### 1b. Email via Resend (alternative)

1. In the Resend dashboard: Domains, add your sending domain, create the
   DKIM/SPF records it prints at your DNS host, wait for status "Verified".
   Resend refuses to send from an unverified domain.
2. Create an API key with sending permission.
3. Set the env vars:

| Variable         | Value                                                     |
| ---------------- | --------------------------------------------------------- |
| `RESEND_API_KEY` | The API key.                                              |
| `OTP_EMAIL_FROM` | Optional. Defaults to `DataBoard <code@databoard.dev>`. The domain after the `@` must be one YOUR Resend account has verified, so override this unless you own databoard.dev. |

### 2. SMS via Twilio

1. In the Twilio console: buy an SMS-capable number, or register an
   alphanumeric sender where that is allowed. US-bound traffic additionally
   needs A2P 10DLC registration on the number before carriers pass messages.
2. Set the env vars:

| Variable             | Value                                              |
| -------------------- | -------------------------------------------------- |
| `TWILIO_ACCOUNT_SID` | Account SID from the console dashboard.            |
| `TWILIO_AUTH_TOKEN`  | Auth token from the same page.                     |
| `TWILIO_FROM`        | The sending number, E.164, e.g. `+14155550142`.    |

### 3. Redeploy, still in demo mode

Env changes need a deployment. Deploy, then confirm the variables are present
(`vercel env ls production`). Demo mode ignores the providers, so nothing
user-visible changes yet.

### 4. Flip the switch

```sh
printf '%s' "false" | vercel env add BLIND_TENDER_DEMO production
vercel deploy --prod --yes
```

### 5. Verify with a real contact

Run one signup with an address or number you control. The code arrives with a
ten minute expiry, and the code screen says "We sent a code to ..." instead of
showing the demo panel. If delivery fails, the server log has exactly one line
per failure: provider name and HTTP status. Contacts and codes are never
logged, so that line is all there is.

Notes:

- `OTP_TEST_CAPTURE=1` is a test-only transport: `deliverCode` appends
  `{kind, code}` lines to `data/otp-capture.jsonl` so the Playwright suites
  can drive non-demo mode without a provider. The server throws if it is set
  in a production deployment. Never set it on Vercel.
- Rate limits are on in every mode (`lib/ratelimit.ts`): request-code 5 per
  10 min per contact and 20 per 10 min per IP, signup 10 per 10 min per IP,
  login 10 per 5 min per handle and 30 per 5 min per IP, VOPRF evaluate 30
  per min per user. Counters live in the `rate_limits` table keyed by
  `HMAC(SERVER_PEPPER, scope|key)`, so no raw IP or contact is stored.

## Cron: stale-ask autoclose

Open or partial asks whose last affirmation (posting, a supply update, the
"Still ongoing" button, or a linked deal reaching co-attested) is more than
7 days old are closed automatically, recorded in `ask_closures` with reason
`auto_stale`.

The sweep runs three ways, all the same pass (`lib/autoclose.ts`):

- **Vercel cron** (production): `vercel.json` schedules
  `GET /api/cron/autoclose` daily at 06:00 UTC. Set `CRON_SECRET` on the
  project; Vercel attaches it as `Authorization: Bearer <CRON_SECRET>` and
  the route rejects anything else. The schedule activates on the next
  deployment after `vercel.json` changes.
- **npm script** (local/ops): `npm run autoclose` runs the pass directly
  against whatever database the environment points at (add the Turso vars
  for production, same pattern as the seed).
- **bare GET in dev/test**: outside production builds the route skips the
  bearer check so suites can trigger a sweep with a plain fetch.

Sanity check after deploy:

```sh
curl -s https://<prod-url>/api/cron/autoclose \
  -H "Authorization: Bearer $CRON_SECRET"     # {"closed":n}
curl -sI https://<prod-url>/api/cron/autoclose  # 401 without the header
```

## Ops: error capture

Server errors are captured by the Next instrumentation hook
(`instrumentation.ts` to `lib/ops.ts`) into the `ops_errors` table: pathname,
router context, capped and scrubbed message/stack, and a digest. No request
bodies, headers, cookies, query strings, user ids or IPs, ever; the same
digest is written at most once a minute, and rows age out after 30 days.
Capture failures are silent by design, so a broken database cannot take
requests down with it.

Read the last 50 as an operator (grant with `npm run grant-operator`):

```sh
curl -s https://<prod-url>/api/admin/errors?limit=50 \
  -H "Cookie: bt_session=<your session cookie>"
```

Non-operators get a 404, same as a wrong URL.

## Ops: backups

`scripts/backup.ts` dumps every table of the target database to
`backups/databoard-<utc timestamp>.json.gz` as
`{ schema_version, exported_at, tables: {name: rows[]} }`, where
`schema_version` is the sha256 of `db/schema.sql` at dump time.

```sh
npm run backup          # local file DB (data/app.db or BLIND_TENDER_DB)
npm run backup:prod     # needs TURSO_DATABASE_URL + TURSO_AUTH_TOKEN in env
```

The default target is always the local file, even with Turso vars in the
shell; production is only ever touched via the explicit `--prod` flag.

Restore replays a dump into an EMPTY database and refuses anything else:

```sh
npm run restore -- backups/databoard-<ts>.json.gz          # local target
npm run restore -- backups/databoard-<ts>.json.gz --prod   # Turso target
```

An older dump restores into a newer schema because the schema only grows
(`CREATE ... IF NOT EXISTS`, new tables only). A dump naming a table the
schema no longer has aborts before writing anything.

**Dumps are sensitive.** They contain password hashes, session token hashes,
contact blind indexes and all pseudonymous content (asks, notes, messages,
exact deal figures). Keep them somewhere private: not in the public repo,
not in CI artifacts, not in shared folders. `backups/` is gitignored and
nothing in CI produces a dump, on purpose. Treat a backup file with the same
care as the production database, because that is what it is.

Retention: nightly dumps, keep 14 days of dailies plus the first of each
month for a year, delete the rest. The dumps are small (gzipped JSON); the
constraint is exposure, not disk.

Nightly local run on macOS (cron survives on macOS; use the full node path
from `which node`):

```sh
( crontab -l 2>/dev/null; echo '17 3 * * * cd /path/to/databoard && set -a && . ./.env.production.local && set +a && /opt/homebrew/bin/node scripts/backup.ts --prod >> backups/backup.log 2>&1' ) | crontab -
```

The same line works as a launchd `ProgramArguments` shell string if you
prefer a LaunchAgent; cron is the one-liner.

## Redeploy

Config-only changes (env vars) need a fresh deployment to take effect:

```sh
vercel deploy --prod --yes
```

Schema changes: edit `db/schema.sql` (additively; everything is
`CREATE ... IF NOT EXISTS`), rerun `node scripts/apply-remote.ts` with prod
env, then redeploy.
