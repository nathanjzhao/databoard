# DataBoard Threat Model

Audit-prep package, part 1 of 4. Companion documents: `FINDINGS.md`, `SCOPE.md`, `FIX-PLAN.md`.

Repo: `datasecretshare` (product name "DataBoard").
Commit under review: `be7aa1661ad62184e5f9fcfc1f499be169557ba3` (main, 2026-08-28).

DataBoard is a pseudonymous board where AI-lab data sellers and buyers post asks, message
end-to-end encrypted, record deals, mint portable receipts, and run a commit-encrypt-pay-reveal
dataset exchange with a wire-credit payment attestation. The privacy posture is aggressive on
purpose: no PII at rest, no message-content surveillance, no buyer de-blinding. This document
states what is trusted, what is protected, who the adversaries are, and the residual trust the
product already documents to its own users on `/transparency`.

---

## 1. Trust model

### 1.1 What the server is allowed to know

The server is treated as an honest-but-curious operator that we still try to blind wherever the
feature allows. The complete durable residue of an account is four columns (`lib/auth.ts:8-13`,
`98-140`): `username`, a scrypt `password_hash` with a random per-user salt, an `account_type`
bit, and a `contact_blind_index` = `HMAC(SERVER_PEPPER, "contact" | normalized)`
(`lib/crypto.ts:139-148`). The raw contact, real name, and org name are attested in a stateless
challenge (`lib/verify.ts`) and discarded in the same request handler.

The operator legitimately learns, by design and stated as honest limits:

- **Message metadata**: who talks to whom, when, and thread subjects (`lib/e2ee.ts:41-51`).
  Message bodies are E2EE and the server holds no keys.
- **Buyer pseudonyms**: the board shows `Buyer #xxxx` chips (`lib/voprf.ts:86-93`), and the
  operator holds the VOPRF key so it can enumerate the small known-buyer dictionary offline
  (`lib/voprf.ts:16-21`; `lib/buyers.ts:17-32`). This is the RFC 9497 small-input-space caveat.
- **Coarse deal shape**: tier, bucketed amounts (nearest $10k), blinded buyer token, a bucketed
  size for exchanges. Never exact amounts, never dataset bytes, never keys, never raw wire
  references (`lib/exchange.ts:44-54`, `300-314`).

### 1.2 What the server must never learn

- Message plaintext (E2EE under per-thread AES-256-GCM keys the server never holds).
- The buyer name off the wire (only a blinded ristretto255 point reaches
  `/api/voprf/evaluate`; `lib/voprf.ts:16-21`).
- Dataset plaintext, the DEK, exact payment amounts, or raw bank/wire references (only
  commitments, buckets, and signatures are stored; `lib/exchange.ts:44-54`).

### 1.3 Cryptographic roots of trust

- **`SERVER_PEPPER`** (`lib/crypto.ts:24-53`): one fixed server-side HMAC key. Every server-side
  derivation is namespaced off it (`hmacHex(domain, value)` prepends `domain | 0x1f`). It seeds
  the contact blind index, the legacy v1 buyer token, the VOPRF key
  (`voprfKeySeed`, `lib/crypto.ts:188-192`), the transparency-log Ed25519 key
  (`lib/translog.ts:70-77`), and the rate-limit buckets. The domain separation across these uses
  was reviewed and found sound (see `FINDINGS.md`, sound-areas).
- **Per-account password** (`lib/e2ee.ts:237-291`): client-side, deterministically derives the
  X25519 encryption key and the Ed25519 signing key. There is no password reset and no recovery
  channel by design; the derivation is stable for the life of the account so a second device works
  without server-held key escrow.
- **Audited primitives** (out of scope as primitives, in scope as composition): RFC 9497 VOPRF via
  `@cloudflare/voprf-ts` (ristretto255-SHA512); X25519, Ed25519, AES-GCM, SHA-256, scrypt, HKDF via
  `@noble/*` and WebCrypto; RFC 6962 Merkle math hand-transcribed in `lib/merkle.ts`.

---

## 2. Assets

| Asset | Where | Confidentiality | Integrity | Consequence if broken |
|---|---|---|---|---|
| Message plaintext | E2EE threads | Must stay client-only | AEAD-authenticated | Full message surveillance; core invariant broken |
| Per-thread AES key | Client, wrapped per recipient | Client-only | AAD-bound to thread | Thread decryption |
| Account password | Client memory / sessionStorage | Never leaves device | n/a | Derives both e2ee and signing secret; account takeover |
| X25519 e2ee secret | Derived from password | Client-only | n/a | Decrypt every thread the user can open |
| Ed25519 signing secret | Derived from password | Client-only | n/a | Forge party-signed receipts and every exchange/wire step |
| Buyer pseudonym unlinkability | VOPRF token | Blinded on the wire | DLEQ-checked | De-anonymize the board's buyers |
| Deal receipt authenticity | HMAC + party sigs | Public artifact | Party sigs unforgeable by operator | Fabricated track record |
| Transparency log append-only-ness | RFC 6962 tree, signed STH | Public | Consistency-proof-checked | Undetected history rewrite |
| Exchange fairness bound | Signed event chain | Public commitments | Hash-linked, role-gated | Undetected out-of-order or forged step |
| `SERVER_PEPPER` | Server env | Server secret | n/a | Recompute contact index; forge HMAC receipts; sign a log fork |

---

## 3. Adversaries

### 3.1 Malicious / compromised operator

The strongest adversary the product reasons about. Holds `SERVER_PEPPER`, the database, and the
serving path.

- **Can (documented, accepted)**: read message metadata; enumerate the small buyer dictionary
  offline; forge the HMAC-only receipt layer (`lib/receipts.ts`); sign a *fork* of the
  transparency log because the log key is HMAC-derived from the pepper (`lib/translog.ts:24-30`) —
  detectable via consistency proofs and external anchoring, not impossible; serve tampered
  JavaScript to exfiltrate client keys (the WhatsApp / Code-Verify problem;
  `lib/e2ee.ts:48-51`) — made detectable by open code and a published JS manifest, not impossible.
- **Must not (invariant)**: read message plaintext without tampering with served JS; forge a
  *fully party-signed* receipt (no participant private key server-side; `lib/receipt-attest.ts`);
  de-blind a buyer without running the dictionary; produce a valid exchange step attributed to a
  party without that party's signing key.
- **Front-running risk (documented TOFU)**: the signing-key and e2ee-key directories are
  operator-served, so an operator that front-runs a user's first key registration could plant a
  key. This is trust-on-first-use, stated as such; the fix (witness-cosigned key transparency) is
  named as future work (`lib/receipt-attest.ts:26-35`).

### 3.2 Malicious authenticated member (counterparty / insider)

Any account. This is where the two confirmed findings live.

- Can call `/api/voprf/evaluate` (a member capability, throttled at 30/min per user;
  `app/api/voprf/evaluate/route.ts:37-59`) and `/api/asks/similar` (arbitrary-token count;
  `app/api/asks/similar/route.ts`).
- Can read any handle's public Ed25519 signing key via the *unauthenticated* directory
  (`app/api/signing/pubkey/route.ts:58-72`; allowlisted in `lib/gate.ts:38`).
- Threats: de-anonymize the board's buyers by building an offline token->name table
  (F-02); attempt cross-context replay of signatures/receipts/events; attempt out-of-order or
  forged exchange steps; mutate receipt fields the party signature does not cover (N-04).

### 3.3 Unauthenticated network attacker

Reaches only the allowlisted public surface (`lib/gate.ts:22-58`): the gate/login/signup pages,
`/transparency*`, `/api/voprf/pubkey`, `/receipts/verify` + `/api/receipts/verify`,
`/api/signing/pubkey` (directory read), `/api/translog/*`, `/api/transparency/*`, `/api/auth/*`,
`/api/cron/*`. Everything else requires a session cookie.

- The signing-key directory being public is what makes F-01 (offline password cracking oracle)
  reachable by *anyone*, no account needed.
- Cron routes carry no cookie and enforce `CRON_SECRET` themselves.
- The receipt verifier and translog proofs are pure recompute with no DB write, safe to expose.

### 3.4 Sybil adversary

Handles are cheap and nothing ties two of them to one person, on purpose
(`/transparency/verification`, section 09). The product does not try to make Sybils impossible
(Douceur 2002 is cited on-site); it prices them: reputation from a counterparty inside your own
invite subtree earns zero collaborator/value credit until that account grows independent history
(`lib/independence.ts`, `lib/stats.ts`). This is a reputation-economics defense, out of scope for
the cryptographic audit except where a Sybil is the *vehicle* for a crypto attack (e.g. a free
member account to reach the VOPRF oracle in F-02).

### 3.5 Fair-exchange counterparty (last-mover)

The commit-encrypt-pay-reveal exchange cannot be made atomic without a blockchain or escrow agent
(Pagnia-Gaertner; stated on-site at `/transparency/verification` section 06). The last mover can
always stop. The design goal is to *bound and evidence* cheating (chunking caps a
stop-after-receiving to one chunk; every step is party-signed and hash-linked), not to prevent it.

---

## 4. Security goals per component

| Component | Primary goal | Mechanism | File |
|---|---|---|---|
| E2EE messaging | Confidentiality + integrity of bodies vs. the DB | AES-256-GCM per thread, X25519 crypto_box wrap, per-thread AAD | `lib/e2ee.ts` |
| Identity keys | Deterministic per-device keys, no escrow | scrypt(password, "prefix"+username) then X25519; HKDF split to Ed25519 | `lib/e2ee.ts:237-291` |
| Buyer token (VOPRF) | Name never on the wire; one key answers everyone | RFC 9497 blind eval + client-side DLEQ verify | `lib/voprf.ts`, `app/api/voprf/*` |
| Portable receipts | Operator cannot forge a co-attested receipt | Per-party Ed25519 sig over canonical base + platform HMAC | `lib/receipts.ts`, `lib/receipt-attest.ts`, `lib/party-sigs.ts` |
| Transparency log | Append-only, externally checkable | RFC 6962 tree, signed STH, inclusion + consistency proofs | `lib/merkle.ts`, `lib/translog.ts` |
| Dataset exchange | Bound + evidence cheating; non-committing-AEAD closed | AES-GCM chunks w/ session-bound AAD, DEK key-commitment, signed hash-linked chain | `lib/exchange.ts` |
| Wire-credit payment | Mutual attestation of a wire, no bank data at rest | Three-party signed WireCreditClaim, salted commitments only | `lib/exchange.ts`, `lib/payproof.ts` |
| Auth / sessions | No password reset, timing-safe login | scrypt hash, decoy-hash timing, sha256-hashed session tokens | `lib/auth.ts`, `lib/crypto.ts` |

---

## 5. Known residual trust (already documented to users)

These are stated on the live `/transparency` and `/transparency/verification` pages. They are not
findings; they are the honestly-disclosed limits of the current design, listed here so the auditor
does not re-report them as novel.

1. **Served-JavaScript trust.** The E2EE guarantee is against the database, not against the code
   path. An operator serving tampered JS could exfiltrate keys. Open code and a published JS
   manifest (`/api/transparency/js-manifest`) make tampering detectable, not impossible.
   (`lib/e2ee.ts:48-51`.)

2. **HMAC-derived transparency-log key.** The log's Ed25519 key is `HKDF(SERVER_PEPPER, ...)`
   (`lib/translog.ts:70-77`), so the operator *can sign a fork*. The design buys detectability of a
   fork (consistency proofs, external anchoring), not impossibility. A real upgrade (independent
   witnesses co-signing STHs, or a TEE-held key) is named future work (`lib/translog.ts:24-30`).

3. **Fair-exchange impossibility.** Atomic data-for-payment between two distrusting parties is
   impossible without a chain or escrow (Pagnia-Gaertner). The exchange bounds and evidences
   cheating; the last mover can still stop. Chunking caps the exposure of a stop-after-receiving to
   one chunk (`/transparency/verification` section 06; `lib/exchange.ts:55-62`).

4. **Buyer-token de-anonymization by the key holder.** The plausible-lab dictionary is small, so
   the pepper-holder can enumerate it offline. Against a DB dump the token is a blind; against the
   operator it is a pseudonym, not a secret (`/transparency/verification` section 08;
   `lib/voprf.ts:16-21`). Finding F-02 extends this from the operator to *any member* via the
   evaluate oracle, and flags the evaluate-route copy that overstates the rate limit as a defense.

5. **Operator-served key directories are trust-on-first-use.** Both the e2ee-key and signing-key
   directories are operator-served, so a front-running operator could plant a key at first
   registration. Stated as TOFU, not key transparency (`lib/receipt-attest.ts:26-35`;
   `/transparency/verification` section 05). Note that the *unauthenticated* exposure of the
   signing-key directory is separately what makes F-01 reachable without any account.

6. **Party signature covers a subset.** The party signing base commits tier, buyerToken,
   amountBucket, attestedAt, seq, dealId, and the signer roster, but not `buyerIsOther`,
   `schemaSha256`, or `commit` (`lib/receipt-attest.ts:81-92`). Tracked as N-04; the operator can
   still mutate the unsigned fields under otherwise-valid party signatures.

7. **No forward secrecy in messaging.** Keys are deterministic from the password, so anyone who
   learns the password derives the same private key. This is the deliberate trade for an account
   with no recovery channel and is what makes a second device work (`lib/e2ee.ts:44-47`).
   Finding F-01 is what makes that password recoverable in the weak-password case.
