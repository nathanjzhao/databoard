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

- `sth-<treeSize>.json`: the full signed tree head at that size, one file per
  size, written once and never overwritten. Each is
  `{ v, logId, treeSize, rootHash, timestamp, signature }`.
- `anchors.ndjson`: one appended line per anchoring run, so the sequence of
  observed heads is itself a log.
- `FORK-size-*.json`: written **only** if the anchor script ever sees a
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

## Independent witnesses (C2SP tlog-witness / sigsum)

The git and OTS anchors above are external, but a witness is a stronger thing:
a party that holds its own Ed25519 key and its own memory of the last head it
accepted, and **refuses to cosign a new head** unless the log proves, with an
RFC 6962 consistency proof, that the new head is an append-only extension of the
exact head that witness last saw. Once N recognized witnesses have cosigned a
head, a client that requires that quorum will not trust any head those witnesses
did not cosign, so an operator fork has to make a witness double-sign: collude,
leak a key, or roll its state back.

This is implemented:

- `lib/witness.ts`: the pure, isomorphic protocol (verify the log signature,
  require `old` == the witness's last cosigned size, verify the consistency
  proof `old -> new`, cosign). It also verifies cosignatures and checks the
  quorum, so the browser and `scripts/verify-log.sh` run the same code.
- `scripts/witness.ts`: a runnable witness with its own key.
- `.github/workflows/witness.yml`: a scheduled job that runs a witness with a
  secret key (`WITNESS_ED25519_SEED`), independent of the anchor job, and
  commits cosignatures under `docs/transparency-log/witnesses/`.
- `POST /api/translog/add-checkpoint`: where a witness posts its cosignature so
  the live head (`/api/translog/sth`) carries it.
- `GET /api/translog/witnesses`: the recognized-witness registry and the
  required quorum N.

### Cosignature format

A cosignature is canonical JSON and binds the witness key to a specific
`(logId, treeSize, rootHash)`:

```json
{
  "v": 1,
  "witnessId": "<sha256 of the witness public key hex>",
  "keyName": "databoard-witness-ci",
  "logId": "<sha256 of the log public key>",
  "treeSize": 42,
  "rootHash": "<hex>",
  "cosignedAt": 1730000000000,
  "publicKey": "<witness ed25519 public key hex>",
  "signature": "<ed25519 over the body, hex>"
}
```

The signed body is the same object without `signature` and `publicKey`, plus a
`domain` tag, canonicalized (see `witnessCosignatureBody`). It deliberately does
**not** cover the log's own timestamp, so a cosignature verifies against any STH
with the same `logId`/`treeSize`/`rootHash`.

### The quorum policy (2N > M)

Clients require **N of M** recognized cosignatures before trusting a head.
Requiring N such that `2N > M` guarantees any two heads that each reach a quorum
share at least one witness, so an operator fork at the same size would need a
recognized witness to have cosigned two different roots, a double-sign that is
itself portable proof. With a single operator-run witness (M = 1, N = 1) the
property is weaker: a fork then only needs that one witness to collude or leak
its key. **A witness the operator runs is only partial independence.** Real fork
resistance needs multiple EXTERNAL witnesses.

### Run a witness yourself (third party)

You do not need our permission, our database, or our infra. You need Node 24, a
checkout of this repo, and your own key.

```sh
# 1. Generate your own Ed25519 witness key (32-byte seed, hex).
node -e 'console.log(require("crypto").randomBytes(32).toString("hex"))'

# 2. Cosign the live head with it. The runner fetches the head + the log key,
#    verifies the log signature and the consistency proof from the head you last
#    cosigned, cosigns, writes docs/transparency-log/witnesses/<key>/, and POSTs
#    the cosignature to /api/translog/add-checkpoint.
WITNESS_ED25519_SEED=<your 64-hex seed> \
WITNESS_KEY_NAME=acme-witness \
  node scripts/witness.ts --url https://getdataboard.vercel.app

# Commit-only (no POST back to the log), e.g. a fully offline witness:
WITNESS_ED25519_SEED=<seed> node scripts/witness.ts --url https://getdataboard.vercel.app --no-push
```

Your durable state lives under `docs/transparency-log/witnesses/<key>/state.json`
(the last head you cosigned); set `WITNESS_STATE_DIR` to keep it somewhere else,
outside this repo's tree. If the log ever presents a head that is **not** a
consistent extension of that state, the runner writes a `FORK-*.json` alarm and
exits nonzero instead of cosigning: that file is the portable evidence a fork
happened.

To have your cosignatures **count** toward the quorum, your public key has to be
in the recognized registry. Add it via `WITNESS_REGISTRY_JSON` (a JSON array of
`{ keyName, publicKey, operator?, url? }`) and raise `WITNESS_QUORUM_N` so
`2N > M`. That is deployment config, not a code change; a third party who wants
to be counted opens a PR adding their `{ keyName, publicKey }` to the registry.

### The remaining upgrade

The witness key can still be lost or coerced. Holding the log key (and,
eventually, a witness key) inside measured hardware (a TEE) so the running code
proves its own identity is the next step, together with a public timestamp on
each `sth-<n>.json` (already done here via OpenTimestamps under `ots/`).
