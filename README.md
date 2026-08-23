# DataBoard

A gated, pseudonymous board for data asks. Data-holding labs and individuals
post what a buyer asked them for, in category terms, without naming the buyer
in the clear. Two posters courted by the same buyer find each other, open a
thread, and coordinate. The board is designed so the operator holds as little
as possible and can prove it.

Live: https://getdataboard.vercel.app (design and claims: [/transparency](https://getdataboard.vercel.app/transparency))

## Privacy design

The entire database is [`db/schema.sql`](db/schema.sql), applied verbatim and
rendered byte-for-byte on `/transparency`. The claim: no column holds a phone
number, email, real name, org name, or buyer name. What is stored, and how:

- **Attested signup, nothing retained.** Verification is stateless
  (`lib/verify.ts`): contact, real name and affiliation are bound into an
  HMAC challenge that round-trips through the client with a one-time code.
  A match proves the contact received the code and the identity fields were
  attested at that moment. Then they are discarded. There is no codes table
  and no contacts table.
- **Four stored fields per account.** Username, scrypt password hash, one
  org-or-individual bit, and `contact_blind_index` =
  HMAC(pepper, normalized contact). The blind index exists only to make one
  contact one account (a UNIQUE constraint). It is never displayed, returned,
  or joined.
- **Blinded buyers.** An ask never stores the buyer's name, only
  `buyer_token` = HMAC(pepper, normalized buyer). Equal tokens mean the same
  buyer, which is all matching needs. Honest caveat, stated on
  `/transparency` too: the operator holding the pepper can test a guessed
  name against a token. The lab namespace is small, so this is a real limit,
  not a footnote.
- **No recovery.** No contact is stored, so there is nothing to reset a
  password against. Lose the password, lose the account. The signup page
  says so before you commit.
- **Sessions without a trail.** The server stores sha256 of the session
  token, no IPs, no user agents, no access log keyed to accounts.

One secret, `SERVER_PEPPER`, keys every one-way transform (`lib/crypto.ts`).
Rotating it orphans every account, so it is permanent for a given database.

## Run locally

```sh
npm install
npm run reset-db && npm run seed
npm run dev            # http://localhost:3947
```

Seeded demo login: `quiet-ledger` / `demo-demo-demo`. In demo mode
(`BLIND_TENDER_DEMO`, default on) signup verification codes are shown in the
UI instead of being delivered.

Local dev uses `file:data/app.db`. Production uses Turso; see
[`DEPLOY.md`](DEPLOY.md).

## Proof suites

```sh
npm run reset-db && npm run seed
npx playwright test
```

Three suites drive the real UI end to end: signup, posting, matching and
messaging (`tests/flow.spec.ts`), the deals ledger and leaderboard
(`tests/deals.spec.ts`), and every route across viewports
(`tests/responsive.spec.ts`). The flow and deals suites finish by dumping the
entire database, WAL sidecars included, and asserting that none of the PII
typed during the run appears anywhere in it. Reset the database before each
run; the suites fail loudly against a dirty one, which is correct.

CI runs the same three suites on every push.
