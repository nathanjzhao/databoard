# DataBoard Security Audit — Scope Brief

Audit-prep package, part 3 of 4. A scoped brief a firm (Trail of Bits, NCC Group, Cure53,
zkSecurity) can quote against. Companion documents: `THREAT-MODEL.md`, `AUDIT-RESULTS.md`
(findings), `FIX-PLAN.md`.

---

## 1. Target

- Repository: `datasecretshare` (product "DataBoard"), Next.js (vendored, non-standard build; see
  `AGENTS.md`), TypeScript, Turso/libSQL.
- Commit to audit: **`be7aa1661ad62184e5f9fcfc1f499be169557ba3`** (branch `main`, 2026-08-28).
- Pin this commit. The tree evolves quickly; do not audit `HEAD` of `main` without re-pinning.
- Product: pseudonymous data-marketplace board. Privacy invariants: no PII at rest, no
  message-content surveillance, no buyer de-blinding. A fix that breaks any of these is not a valid
  fix.

## 2. Primitives and libraries (audited upstream — audit the *composition*, not the primitive)

| Primitive | Library | Used for |
|---|---|---|
| VOPRF, RFC 9497, ristretto255-SHA512 | `@cloudflare/voprf-ts` (+ `/crypto-noble`) | Blinded buyer tokens |
| X25519 | `@noble/curves/ed25519` | E2EE key agreement, crypto_box wraps |
| Ed25519 | `@noble/curves/ed25519` | Party sigs, exchange/wire sigs, STH signing, leaf sigs |
| AES-256-GCM | WebCrypto (`crypto.subtle`) | Message bodies, key wraps, dataset chunks |
| SHA-256 | `@noble/hashes/sha2` + WebCrypto | Merkle, commitments, session-token hashing |
| scrypt | `@noble/hashes/scrypt` (client), `node:crypto` (server) | Identity KDF (N=2^15), password hash (N=2^14) |
| HKDF-SHA256 | `@noble/hashes/hkdf` + `node:crypto` | Key splitting, wrap keys, log/VOPRF key seeds |
| HMAC-SHA256 | `node:crypto` | Contact index, v1 buyer token, translog subject, rate-limit buckets |
| RFC 6962 Merkle | hand-written `lib/merkle.ts` | Transparency log tree, inclusion + consistency proofs |

## 3. Crypto-critical file inventory (line counts at the pinned commit)

Core library (`lib/`):

| File | Lines | What to audit |
|---|---:|---|
| `lib/e2ee.ts` | 414 | Identity KDF, signing-key split, thread-key wrap/unwrap, message AEAD, base64url codec |
| `lib/voprf.ts` | 211 | Client VOPRF mint, DLEQ verify, token normalization/format |
| `lib/crypto.ts` | 272 | `SERVER_PEPPER` root, HMAC domain separation, password hash/verify, canonicalization |
| `lib/merkle.ts` | 332 | RFC 6962 leaf/node hashing, proof gen + verify, STH canonicalization + verify |
| `lib/translog.ts` | 436 | Log key derivation (HMAC-from-pepper), leaf encoding, STH signing, append |
| `lib/receipts.ts` | 354 | Receipt canonical encoding, platform HMAC layer, mint path |
| `lib/receipt-attest.ts` | 200 | Party signing base, per-party verify, roster canonicalization |
| `lib/party-sigs.ts` | 145 | Roster assembly, write-once sig storage, own-key enforcement |
| `lib/exchange.ts` | 1046 | Commit-encrypt-pay-reveal, chunk AEAD + AAD, DEK commitment, state machine, wire-credit chain |
| `lib/payproof.ts` | 395 | zkTLS payment-proof seam (inert until a verifier is configured) |
| `lib/auth.ts` | 303 | Sessions, login timing, password hashing glue |
| `lib/ratelimit.ts` | 163 | HMAC-bucketed rate limits (the VOPRF/login/OTP throttles) |
| `lib/verify.ts` | 447 | Stateless signup challenge (attest-and-discard contact/name) |
| `lib/gate.ts` | 71 | Public-path allowlist shared with edge middleware |
| `lib/buyers.ts` | 45 | Known-buyer dictionary (the small input space) |

Route handlers (`app/api/`), crypto-relevant:

| Route | Lines | What to audit |
|---|---:|---|
| `app/api/voprf/server.ts` | 171 | Server VOPRF key derive + blind evaluate + DLEQ prove |
| `app/api/voprf/evaluate/route.ts` | 79 | Member oracle, rate-limit, auth gate (F-02) |
| `app/api/voprf/pubkey/route.ts` | 38 | Public VOPRF pubkey (verification anchor) |
| `app/api/signing/pubkey/route.ts` | 125 | Signing-key directory; unauthenticated `?handle=` read (F-01) |
| `app/api/e2ee/pubkey/route.ts` | 94 | E2EE key directory (session-gated; contrast to F-01) |
| `app/api/asks/similar/route.ts` | 69 | Arbitrary-token count oracle (F-02) |
| `app/api/receipts/verify/route.ts` | 63 | Public receipt verify (pure recompute) |
| `app/api/deals/[id]/receipt-sign/route.ts` | 121 | Party-sig submission (own-key check) |
| `app/api/translog/proof/inclusion/route.ts` | 42 | RFC 6962 inclusion proof serving |
| `app/api/translog/proof/consistency/route.ts` | 47 | RFC 6962 consistency proof serving |
| `app/api/translog/sth/route.ts` | 42 | Signed tree head serving |
| `app/api/exchange/[id]/events/route.ts` | 59 | Exchange event append (state-machine enforcement) |
| `app/api/exchange/[id]/wire/route.ts` | 66 | Wire-credit claim chain |
| `app/api/exchange/[id]/blob/route.ts` | 74 | Ciphertext blob transfer |
| `app/api/payproof/verify/route.ts` | 144 | Payment-proof verification seam |
| `app/api/auth/*` | ~450 | Signup challenge, login, session issue |

Client verifier components worth reading alongside the libs: `components/transparency/log-verifier.tsx`
(browser RFC 6962 recompute), `components/exchange/*` (the exchange UI + step transcript),
`components/verification/*` (the on-site claims this audit should confirm match the code).

Total crypto-critical surface: ~9.8k lines in `lib/` plus ~5.3k lines across `app/api/` routes.

## 4. Properties to audit, per component

**E2EE messaging (`lib/e2ee.ts`)**
- No IV reuse across messages/wraps (random 12-byte nonce per seal; confirm the RNG path).
- AAD binds ciphertext to its thread (`msg/`+threadId, `key/`+threadId); confirm no thread-swap.
- Identity KDF: confirm the pubkey is *not* an offline oracle (see F-01) and the salt domain is
  disjoint from the password hash.
- base64url codec canonicality (see N-01: trailing-bit malleability).
- Low-order-point handling in `wrapThreadKey`/`unwrapThreadKey`.

**Buyer token / VOPRF (`lib/voprf.ts`, `app/api/voprf/*`)**
- Client-side DLEQ verification actually gates token use (confirmed sound; re-verify).
- No blind reuse; key-rotation behavior; the member-oracle de-anonymization and route copy (F-02).
- Server never persists or logs the blinded point in a name-recoverable form.

**Transparency log (`lib/merkle.ts`, `lib/translog.ts`)**
- RFC 6962 leaf/node prefixes, empty-tree, power-of-two consistency edge cases (confirmed sound;
  re-verify against a brute-force reference).
- STH signing body excludes signature, is canonical, binds `logId`/`treeSize`/`rootHash`.
- The HMAC-from-pepper log key (operator can fork) is the *documented* bound, not a finding;
  confirm no path treats the log as unconditionally trustworthy.

**Receipts (`lib/receipts.ts`, `lib/receipt-attest.ts`, `lib/party-sigs.ts`)**
- Canonicalization identical client vs. server; no two inputs to the same signed bytes.
- Party base field coverage (N-04: `buyerIsOther`/`schemaSha256`/`commit`/full participants
  unsigned).
- Cross-deal / cross-seq / cross-attestation replay (confirmed closed; re-verify).
- Own-key enforcement on sig submission; write-once locks.

**Exchange (`lib/exchange.ts`)**
- Chunk AAD binds session + index; per-chunk nonce uniqueness under the per-deal DEK.
- DEK key-commitment (confirmed closes non-committing-AEAD; re-verify the domain/salt binding).
- State machine: no out-of-order acceptance, no role confusion, no forged/skipped step; the
  hash-linked chain and prevHash checks.
- Wire-credit chain: countersignature gating of DEK reveal; reversal handling; no bank data at rest.

**Auth (`lib/auth.ts`, `lib/crypto.ts`)**
- Login timing (decoy hash), session-token hashing, no username-existence oracle.
- Password floor / entropy (F-01 fix (c)).

## 5. Out of scope

- The internals of the audited primitive libraries (`@cloudflare/voprf-ts`, `@noble/*`, WebCrypto,
  `node:crypto`). Audit their *use*, not their math.
- Reputation-economics / Sybil-pricing correctness (`lib/independence.ts`, `lib/stats.ts`,
  `lib/referrals.ts`) except where a Sybil is the vehicle for a crypto attack (e.g. a free member
  account reaching the VOPRF oracle in F-02).
- Business-logic fee accounting beyond its crypto touchpoints.
- The vendored Next.js build machinery itself (`node_modules/next/...`), except as it affects the
  served-JS trust assumption (an integrity concern the product already documents).
- Fair-exchange atomicity: known-impossible without a chain/escrow; the design bounds cheating and
  says so. Do not report "the last mover can stop" as a novel finding.
- Denial of service and infra hardening, unless it converts into a confidentiality/integrity break.

## 6. Known issues to confirm, not rediscover

Two confirmed findings (F-01 signing-key offline password oracle; F-02 member VOPRF
de-anonymization) and four lower-severity notes (N-01 base64url malleability, N-02 missing
signature domain tags, N-03 unverified buyer-token authenticity, N-04 partial party-sig coverage)
are documented in `AUDIT-RESULTS.md`. Please confirm, refute, or extend them, and treat the seven
sound-area confirmations there as claims to independently re-check rather than as settled.

## 7. Deliverable expectations

- Findings ranked by exploitability x impact, each with file:line, a concrete attacker input, and
  the wrong outcome.
- For each finding, a fix that preserves the three privacy invariants (call out explicitly if a
  finding cannot be fixed without weakening one).
- Confirmation or refutation of the seven sound-area claims.
- A statement on whether the on-site `/transparency` and `/transparency/verification` claims match
  the code as pinned.
