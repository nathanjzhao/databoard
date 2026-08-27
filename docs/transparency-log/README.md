# Transparency log anchors

This folder is the **external, tamper-evident witness** for DataBoard's
append-only Merkle transparency log (`lib/translog.ts`, RFC 6962 / Certificate
Transparency).

The log lives in the database. Its tree head is signed with an Ed25519 key
derived from `SERVER_PEPPER`, which means the operator holds the private key
and *could* sign a fork. What stops a quiet rewrite is not the signature alone,
it is this folder: the signed head is committed to public git history. Once a
head others have pulled is in that history, the operator cannot rewrite the log
without the git record and a saved head disagreeing. That disagreement is
portable proof.

## What is here

- `sth-<treeSize>.json` — the full signed tree head at that size, one file per
  size, written once and never overwritten. Each is
  `{ v, logId, treeSize, rootHash, timestamp, signature }`.
- `anchors.ndjson` — one appended line per anchoring run, so the sequence of
  observed heads is itself a log.
- `FORK-size-*.json` — written **only** if the anchor script ever sees a
  different root at a size it already anchored. Its presence is an alarm.

## How anchors get here

`scripts/anchor-sth.ts` writes them. It verifies the head's signature before
trusting it, and refuses to overwrite an existing anchor (a differing root at a
known size is recorded as a fork, not silently replaced).

```sh
# Anchor the live deployment (no database needed; what CI runs on a schedule).
# It fetches /api/translog/sth + /api/translog/pubkey and verifies the head.
node scripts/anchor-sth.ts --url https://getdataboard.vercel.app

# Anchor whatever database this environment points at, directly.
node scripts/anchor-sth.ts --local
```

The scheduled GitHub Actions job in `.github/workflows/anchor.yml` runs the
first form and commits any new head, so the public git history keeps a running,
timestamped record of the log's growth that neither the operator nor a later
force-push can quietly alter without detection.

## Verifying an anchor yourself

- In a browser: `/transparency/log` fetches proofs and re-checks them client
  side. Paste a receipt, or pick two of the sizes below and run a consistency
  check.
- In a terminal: `scripts/verify-log.sh https://getdataboard.vercel.app`
  fetches the head and two proofs and verifies them offline with the repo's
  own `lib/merkle.ts`.
- Against an anchor file: the `rootHash` in any `sth-<n>.json` here must match
  the root the live `/api/translog/sth?size=<n>` reports, and both signatures
  must verify against `/api/translog/pubkey`. If a live head at a size you
  anchored ever shows a different root, the log was rewritten.

## The stronger anchor (future work)

Committing to our own repo is a real witness, but the repo is still ours. Two
upgrades make it independent, and are named here so the gap is a roadmap, not a
shrug:

1. **A public timestamp.** Stamp each `sth-<treeSize>.json` with a service like
   [OpenTimestamps](https://opentimestamps.org/): `ots stamp
   docs/transparency-log/sth-<n>.json` produces a `.ots` receipt anchored in
   the Bitcoin blockchain, proving the head existed at a time we cannot backdate.
   The file this script writes is exactly what you would stamp; wire the `ots`
   call into the workflow when you want it (no code change here needed).
2. **Independent co-signing witnesses.** Other parties fetch the head, check
   consistency against the last head they saw, and co-sign it. A fork then has
   to fool every witness at once. This is the sigsum / CT witness model and is
   the real endgame, together with holding the log key inside a TEE so the
   running code proves its own identity.
