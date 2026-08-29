# Witness cosignatures

This folder holds the cosignatures of the transparency log's signed tree heads
by **independent witnesses** (the C2SP tlog-witness / sigsum model, `lib/witness.ts`).

Each witness writes under its own subfolder, keyed by its `WITNESS_KEY_NAME`:

```
witnesses/
  <key-name>/
    state.json           the last head this key cosigned { logId, treeSize, rootHash }
    cosig-<size>.json     one cosignature per tree size
    cosignatures.ndjson   the append log of everything this witness cosigned
    FORK-*.json           written ONLY when the log presented a non-consistent
                          or forked head: the alarm the design exists to raise
```

A witness cosigns a new head only after verifying the log's signature and an
RFC 6962 consistency proof from the exact head it last cosigned, so a cosignature
here is a portable statement that the head was, at cosign time, an append-only
extension of everything that witness had seen. See `../README.md` for the
protocol, the cosignature format, the N-of-M quorum policy (`2N > M`), and how to
run a witness yourself with your own key.

The scheduled `.github/workflows/witness.yml` runs the operator's own witness and
commits here. A witness the operator runs is only **partial** independence; true
fork resistance needs external witnesses run by other people on their own keys.
