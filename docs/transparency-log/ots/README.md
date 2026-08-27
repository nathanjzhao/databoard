# OpenTimestamps anchors

This folder holds the **Bitcoin-anchored** timestamps of the transparency log's
signed tree heads. It is the external anchor that does not depend on our git.

## Why this exists

The parent folder (`docs/transparency-log/`) commits each signed tree head to
git. That is a real witness, but the repository is still ours: a determined
operator could force-push and rewrite it. OpenTimestamps closes that gap. It
stamps the hash of a head into the Bitcoin blockchain through calendar servers
we do not run, so once a head is anchored, its existence at that time is fixed
by Bitcoin's own timestamp. The operator cannot backdate a head, or fork the
log's history before an anchored point, without the anchor and the live log
disagreeing, and that disagreement does not route through anything we control.

The git-committed head stays as a **secondary** witness. Two independent
witnesses (git plus Bitcoin) are strictly better than either alone.

## What is here

- `sth-<treeSize>.<calendar>.ots`: a standard OpenTimestamps DetachedTimestamp
  proof for `../sth-<treeSize>.json`, one per calendar that answered. Each is a
  normal `.ots` file: header, version, the SHA-256 file-hash op, the 32-byte
  digest, and the calendar's timestamp. The ordinary `ots` client reads them.
- `sth-<treeSize>.ots.json`, a small companion record: the digest that was
  stamped, which calendars answered, and when.
- `stamps.ndjson`, one line per anchoring run, so the sequence of stamps is
  itself a log alongside `../anchors.ndjson`.

Fresh proofs are **pending**: they commit the digest to each calendar's own
Merkle tree and point at the Bitcoin attestation the calendar will publish over
the next few hours. This is exactly what `ots stamp` produces; it is not a
half-finished proof, it is the first half of a normal OTS lifecycle.

## How anchors get here

`scripts/ots-anchor.ts` writes them, with **no new dependency**: it speaks the
documented calendar HTTP API directly (`POST <calendar>/digest` with the raw
32-byte digest; the calendar returns a serialized timestamp) and wraps the
response in the OTS header to produce a standard `.ots`.

```sh
# Stamp the current head of the live deployment (fetches + verifies the STH).
node scripts/ots-anchor.ts --url https://getdataboard.vercel.app

# Stamp the head of whatever database this environment points at.
node scripts/ots-anchor.ts --local

# Stamp an existing head file's bytes directly (offline).
node scripts/ots-anchor.ts --stamp-file docs/transparency-log/sth-3.json
```

## Verifying and completing a proof

With the [OpenTimestamps client](https://github.com/opentimestamps/opentimestamps-client)
(`pip install opentimestamps-client`):

```sh
# Complete a pending proof once Bitcoin has confirmed it (hours after stamping).
ots upgrade docs/transparency-log/ots/sth-3.alice.ots

# Verify it. The digest is the SHA-256 of ../sth-3.json; ots checks that this
# digest is committed by a Bitcoin block header at the attested time.
ots verify --digest <sha256 of sth-3.json> docs/transparency-log/ots/sth-3.alice.ots
# or, against the head file itself:
ots verify docs/transparency-log/ots/sth-3.alice.ots   # looks for sth-3.json alongside
```

`ots info <file>.ots` prints the operation tree without touching the network,
which is enough to confirm the file parses and which calendars it points at.

If you have no `ots` client, the digest and the calendar URLs are in
`sth-<n>.ots.json`; the raw wire step is a single `POST` of the digest bytes to
`<calendar>/digest`, and `scripts/ots-anchor.ts` prints that exact command when
no calendar is reachable.

## The remaining upgrade

OpenTimestamps anchors the head to Bitcoin, and git witnesses it in a second
place. The remaining rung, named so the gap is a roadmap rather than a shrug:
**independent witness cosigning** (the sigsum / Certificate Transparency witness
model), where other parties fetch each head, check it is consistent with the
last one they saw, and co-sign it, so a fork has to fool every witness at once.
Together with holding the log signing key inside a TEE, that moves the log from
"a rewrite is detectable after the fact" toward "a rewrite cannot be attempted
unseen." Both are future work.
