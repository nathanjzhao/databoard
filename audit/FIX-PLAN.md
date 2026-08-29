# DataBoard Fix Plan

Audit-prep package, part 4 of 4. Companion documents: `THREAT-MODEL.md`, `AUDIT-RESULTS.md`
(findings), `SCOPE.md`.

For each confirmed issue: whether it is fixable now without breaking the privacy invariants (no PII
at rest, no message-content surveillance, no buyer de-blinding), and the order to fix. Nothing here
weakens an invariant; where an issue cannot be fully closed by code, that is stated.

---

## Invariant guardrails (apply to every fix)

1. No PII at rest. A fix may not start persisting a raw contact, name, org, amount, or bank
   reference.
2. No message-content surveillance. A fix may not move any message-decryption capability
   server-side.
3. No buyer de-blinding. A fix may not send a buyer name to the server or let the server invert a
   token beyond the already-documented dictionary bound.

---

## Fix order

### 1. F-01 — signing-key offline password oracle  (HIGH, fixable now, do first)

**Fixable without breaking invariants: yes.** None of the three moves touch message content, PII at
rest, or buyer blinding.

Ship in two stages:

- **Stage 1 (immediate, small): close the unauthenticated oracle.** Remove
  `/api/signing/pubkey` from the public allowlist (`lib/gate.ts:38`) and require a session for the
  `?handle=` directory read (`app/api/signing/pubkey/route.ts:58-72`), matching the already
  session-gated `/api/e2ee/pubkey`. The one consumer that needs it unauthenticated is the public
  `/receipts/verify` flow: keep that working by having the receipt *carry* the signer pubkeys (it
  already does, in the attestation roster) and verifying each carried pubkey against the
  session-gated directory only when a logged-in checker is present. This alone downgrades the
  attack from "anyone on the internet" to "an attacker who already holds a session," removing the
  no-account offline oracle. Verify by driving `/receipts/verify` on a logged-out browser and
  confirming a receipt still verifies from its embedded pubkeys.

- **Stage 2 (durable): de-oracle the derivation.** Mix a high-entropy server-side per-user value
  into the identity salt, delivered to the client at login *after* the `password_hash` check, so
  the published pubkey stops being a pure function of `password + handle`
  (`lib/e2ee.ts:237-291`). Cache the server value client-side so the derivation stays deterministic
  per device (preserving the no-recovery, second-device property). This also closes the
  *authenticated*-member variant of the oracle, which Stage 1 leaves open. Requires a schema column
  for the per-user salt and a login-response field; it does not change what is stored about a
  contact/name, so it is invariant-safe.

- **Stage 3 (defense in depth): raise the password floor** above 10 chars and add an
  entropy/breach check in `passwordProblem` (`lib/crypto.ts:201-211`). Independent of Stages 1-2;
  ship whenever.

Do **not** just raise scrypt `N`: it does not change that the pubkey is an offline verifier.

Regression guard to add: a test that fetches a handle's signing pubkey, runs the exact
scrypt->HKDF->getPublicKey recomputation for a candidate password, and asserts that after the fix
the recomputation can no longer be performed without the server-delivered salt (i.e. the pubkey is
no longer a pure function of password+handle). Make it fail against the current code first.

### 2. F-02 — member VOPRF de-anonymization + misleading copy  (MEDIUM, partly fixable now)

**Fully fixable by code: no** (a deterministic OPRF over a small public dictionary is inherently a
member oracle; closing it cryptographically would break blind evaluation, which is an invariant).
**Partly fixable now: yes.**

- **Now (copy):** reword `app/api/voprf/evaluate/route.ts:16-19,42-46` and the matching
  `/transparency` copy to state that member-side dictionary de-anonymization is as feasible as
  operator-side for small input spaces, and that the rate limit is DoS/cost control only, not a
  pseudonymity control. This removes an overclaim; it does not change behavior.
- **Now (oracle hygiene):** tighten `/api/asks/similar` (`app/api/asks/similar/route.ts:40-57`) —
  the arbitrary-token count is a cleaner confirmation/volume channel than the board itself. Gate it
  behind the compose flow, log nothing, and drop its ceiling well below the shared 30/min. Cheap
  and invariant-safe.
- **Durable (future work, larger):** the token redesign already named on
  `/transparency/verification` section 08 — a random 256-bit pseudonym certified one-per-entity by
  an independent KYB issuer — which kills dictionary enumeration outright. This is a design project,
  not a patch, and it adds an issuer to trust; track it, do not block on it.

Do not "fix" F-02 by de-blinding buyers or letting the server see names.

### 3. N-04 — party signature covers only a subset  (LOW-MEDIUM, fixable now, clean)

**Fixable without breaking invariants: yes**, and it is a clean, self-contained change. Extend
`PartyBaseFields` and `partySigningBase` (`lib/receipt-attest.ts:57-92`) to also commit
`buyerIsOther`, `schemaSha256`, `commit`, and the full confirmed-participant set (not only the
subset holding registered signing keys), and bump `PARTY_SIG_VERSION`. Coordinate the byte-identical
change in the client signer and the `/receipts/verify` verifier. Regression guard: mutate an
unsigned field on a signed receipt and assert verification now fails (it passes today).

### 4. N-02 — add explicit signature domain-separation tags  (LOW hardening, fixable now)

**Fixable now: yes.** Prepend a fixed context tag to the signed bytes in each of the three Ed25519
signing paths (receipt base `lib/receipt-attest.ts:81-97`, exchange leaves and wire claims in
`lib/exchange.ts`) so a signature can never be lifted across contexts regardless of future schema
drift. Version-bump each affected signature format. Structurally safe today, so this is
future-proofing; batch it with N-04 since both touch the party-sig base and both need a version
bump.

### 5. N-01 — reject non-canonical base64url  (LOW, fixable now)

**Fixable now: yes.** In `fromB64url` (`lib/e2ee.ts:122-140`) reject any input whose trailing bits
are non-zero (or require an encode round-trip to match). Audit every write-once lock, dedup, and
equality check that keys on the *string* form of a pubkey/signature to confirm none can be split by
two encodings of the same bytes. Small, invariant-safe.

### 6. N-03 — unverified buyer-token authenticity  (LOW, decision then optional fix)

**Fixable now: partially, with a trade-off.** The server accepts any `v2:`+128-hex string without
proof it is a real OPRF output (`lib/voprf.ts:50-55`; compose/similar routes). Options: (a) accept
the reduced value only through a server-observed evaluation bound to the caller so a posted token
must correspond to an evaluation the server actually performed — adds a linkage the current design
deliberately avoids, so weigh it against the unlinkability goal; or (b) accept that token
authenticity is board-hygiene only and document it. Impact is grouping-integrity, not
confidentiality, so this is a product decision, not an urgent patch. Recommend (b) short-term.

---

## Summary

| Ref | Severity | Fixable now w/o breaking invariants | Sequence |
|---|---|---|---|
| F-01 | High | Yes (staged; Stage 1 immediate) | 1 |
| F-02 | Medium | Copy + oracle hygiene now; cryptographic close is future work | 2 |
| N-04 | Low-Med | Yes, clean | 3 |
| N-02 | Low | Yes, batch with N-04 | 4 |
| N-01 | Low | Yes | 5 |
| N-03 | Low | Decision; optional | 6 |

Batching note: N-04 and N-02 both change a signed base and need a signature-format version bump, so
ship them together. F-01 Stage 1 is the single highest-value change and is independent of
everything else; do it first.
