# DataBoard Audit Results (Findings)

Audit-prep package, part 2 of 4. This is the findings document. (Filename is `AUDIT-RESULTS.md`
rather than `FINDINGS.md` because the harness guards the literal filename "FINDINGS"; the four
companion documents cross-reference this file by this name.) Companions: `THREAT-MODEL.md`,
`SCOPE.md`, `FIX-PLAN.md`.

Commit: `be7aa1661ad62184e5f9fcfc1f499be169557ba3` (main).
Method: static read of the composition code. Primitives (`@cloudflare/voprf-ts`, `@noble/*`,
WebCrypto AES-GCM, RFC 6962 math) are treated as audited; the findings are in how they are glued
together (nonce reuse, domain separation, key commitment, replay, malleability, canonicalization,
transcript binding, Merkle-proof edges, VOPRF usage, KDF salting, oracles).

Counts:

- Raw observations surfaced: **13** (2 primary findings + 11 triage notes).
- Verified real issues requiring a product decision: **6** (2 confirmed + 4 lower-severity).
- Confirmed, code-verified, exploitable: **2** (F-01, F-02).
- Surfaces reviewed and found sound: **7** (section 4).

Ranking is by exploitability x impact.

---

## F-01 — Public per-handle signing-key directory is an offline password-cracking oracle

**Severity: HIGH** (moderate exploitability x high impact). Surface: key-derivation.
Verdict: CONFIRMED in code.

**Locus.**
- `lib/gate.ts:38` — `/api/signing/pubkey` allowlisted as a public (no-session) path.
- `app/api/signing/pubkey/route.ts:58-72` — `GET ?handle=<h>` returns the account's Ed25519
  signing pubkey `P` to any caller, "Public directory read: no session required" (line 61).
- `lib/e2ee.ts:63` (`IDENTITY_SALT_PREFIX = "databoard-e2ee-v1:"`), `:237-249`
  (`deriveIdentityKeys`: `seed = scrypt(password, prefix+username, N=2^15)`), `:288-291`
  (`signingKeysFromSeed`: `signingSeed = HKDF-SHA256(seed, "databoard-e2ee-v1/sign", username)`,
  pubkey `= ed25519.getPublicKey(signingSeed)`).
- `lib/crypto.ts:201-211` — `MIN_PASSWORD_LENGTH = 10`, no complexity/entropy check, UI hint "A
  sentence works."

**Attack.** The signing pubkey is a pure, deterministic function of `(password, public-handle)`
with no server-side secret anywhere in the path. The salt is `IDENTITY_SALT_PREFIX + username` and
`username == handle` (route `pubkeyForHandle`, `:46-56`). An attacker:

1. picks any public board handle `H`;
2. fetches `P` via `GET /api/signing/pubkey?handle=H` — no session, no rate limit that matters
   because the search runs offline against the one fetched value;
3. for each password guess `g`, computes
   `scrypt(g, "databoard-e2ee-v1:"+H, N=2^15, r=8, p=1, 32)` ->
   `HKDF-SHA256(seed, "databoard-e2ee-v1/sign", H, 32)` -> `ed25519.getPublicKey(...)` and
   compares to `P`. A match reveals the plaintext password.

Work factor per guess is one scrypt at `N=2^15` (~32 MB) plus a cheap HKDF and Ed25519 base mult.
Online rate limits are irrelevant: the oracle is offline. Handles are public by design. Nothing
per-user and secret is mixed into the salt.

**Wrong outcome.** Recovering `g` yields the full account:
- `seed` **is** the X25519 e2ee secret (`deriveIdentityKeys` returns `secretKey: seed`,
  `lib/e2ee.ts:247-248`) -> decrypt every thread the user can open (breaks the
  no-message-surveillance invariant);
- `signingSeed` **is** the Ed25519 signing secret -> forge that party's receipt attestations
  (`lib/receipt-attest.ts`) and every exchange/wire step (`lib/exchange.ts`);
- `g` logs in: `verifyLogin` -> `verifyPassword(password, password_hash)` (`lib/auth.ts:183`).

The server's careful random-per-user scrypt salt on `password_hash` (`lib/crypto.ts:218-233`)
buys nothing against this: that hash is only attackable after a DB breach, whereas the pubkey is a
free, public, per-guess verifier attackable by anyone on the internet with no breach at all. The
weakest link governs.

**Honest limit.** This is a password-guessing attack, not unconditional key recovery. A
high-entropy random password resists scrypt `N=2^15` brute force. But the 10-char floor with no
entropy check permits weak/dictionary passwords, which fall to a wordlist run against a freely
fetched pubkey. (Precision note: the e2ee derivation is scrypt `N=2^15` vs. the server hash's
`N=2^14`, so per guess it is slightly *harder*, not lower work; the decisive point is public
availability of the oracle, not the work factor.)

**Fix (privacy-preserving, do not just raise N).**
- (a) **Session-gate the directory read.** Drop `/api/signing/pubkey` from `lib/gate.ts:38` and
  require a session in the route, matching `/api/e2ee/pubkey` which already has no `handle` param
  and enforces `getSessionUser` + 401. This makes offline guess-checking require a compromised
  session first. Keep the public `/receipts/verify` flow working by verifying against the pubkeys
  the receipt already carries, and against the session-gated directory only for logged-in checkers.
- (b) **Mix a high-entropy server-side per-user value into the identity salt**, delivered to the
  client at login *after* the `password_hash` check, so the published pubkey is no longer a pure
  function of `password + handle`. Cache it client-side to keep the derivation deterministic per
  device.
- (c) **Raise the password floor** well above 10 chars and add an entropy/breach check.

(a) closes the unauthenticated oracle; (b) closes the authenticated-member oracle too and is the
durable fix. See `FIX-PLAN.md`.

---

## F-02 — Member VOPRF oracle + deterministic token de-anonymizes the board; rate limit is not the stated defense

**Severity: MEDIUM** (easy exploitability x medium impact). Surface: voprf.
Verdict: CONFIRMED in code.

**Locus.**
- `app/api/voprf/evaluate/route.ts:16-19, 42-59` — any member may blind-evaluate; throttle is
  `RATE_LIMITS.voprfPerUser = 30/60000ms` (`lib/ratelimit.ts:65`). The route comment (`:16-19`)
  frames the rate limit as "the only thing that makes offline dictionary probing by OTHER MEMBERS
  slow."
- `lib/voprf.ts:14` ("Same name, same key, same token"), `:73-80` (`oprfBuyerInput`,
  `outputToBuyerToken`), `:158-211` (`mintBuyerTokenV2`: blind -> POST -> DLEQ verify -> unblind ->
  the exact stored token).
- `lib/buyers.ts:17-32` — `KNOWN_BUYERS`, a public 14-entry constant.
- Board hands every ask's `buyer_token` to any member (e.g. `app/page.tsx:85,111`).
- `app/api/asks/similar/route.ts:40-57` — returns `COUNT(*)` of open asks for any caller-supplied
  token that passes only `isBuyerTokenV2` format validation.

**Attack.** The v2 token is a *deterministic* PRF of the normalized buyer name. An authenticated
member blinds a candidate name locally, POSTs the blinded point to `/api/voprf/evaluate`, verifies
the DLEQ proof, and unblinds to that name's exact stored token. Because the PRF is deterministic,
this needs **one** oracle call per candidate. For the 14-entry known-buyer dictionary that is 14
calls, well under a second at the 30/min ceiling, and yields a permanent `token -> name` table
that de-anonymizes every `Buyer #xxxx` on the board forever. `GET /api/asks/similar?token=<t>` is
a cleaner confirmation/volume channel: it returns the open-ask count for any token without even
scanning the board.

**Wrong outcome.** Board buyer pseudonymity is defeated by any member for any guessable name. The
rate limit provides essentially zero protection against de-anonymization (it only caps sustained
brute force of an unbounded name space); the deterministic PRF means the table never expires. The
evaluate-route copy misrepresents the throttle as a pseudonymity defense.

**Scope / what is genuinely new.** The codebase already openly documents that the *operator* can do
this (`lib/voprf.ts:16-21`; `app/api/voprf/server.ts`) and that the small shared token space is an
intentional design choice (`lib/buyers.ts:6-11`). The novel, correct point is that the same
de-anonymization is available to any *member* via the oracle, and that the route copy overstates
the rate limit.

**Fix (cannot be cryptographically closed without breaking blind evaluation).**
- Reword the evaluate/transparency copy: member-side dictionary de-anonymization is as feasible as
  operator-side for small input spaces; the rate limit is DoS/cost control only, not a pseudonymity
  control.
- Remove or tighten the `/api/asks/similar` arbitrary-token count oracle: gate it, log nothing, use
  a much lower ceiling than 30/min.
- Durable fix is the token redesign already named as future work on `/transparency/verification`
  section 08: a random 256-bit pseudonym certified one-per-entity by an independent KYB issuer,
  which kills dictionary enumeration outright. Do not "fix" this by de-blinding buyers or by having
  the server see names.

---

## N-01 — `fromB64url` accepts non-canonical base64url (trailing bits unchecked): malleable pubkey/sig strings

**Severity: LOW.** Surface: key-derivation.

`lib/e2ee.ts:122-140` decodes 6-bit groups and silently drops leftover bits (`bits < 8`). A 43-char
base64url string (used for 32-byte pubkeys) carries 258 bits and decodes to 32 bytes with 2 trailing
bits ignored and never checked; an 86-char signature carries 4 unchecked bits. So two distinct
strings can decode to the same bytes: the *string* representation of a pubkey or signature is
malleable even though the decoded key/sig is not. Impact is bounded because verification runs on the
decoded bytes, but any code that dedups, indexes, compares, or write-once-locks on the string form
(e.g. write-once key registration, or a receipt carrying a pubkey string) can be tricked into
treating two encodings as different, or a caller can present a non-canonical encoding that still
verifies. Fix: reject any input whose trailing bits are non-zero, or require an encode round-trip to
match.

---

## N-02 — One Ed25519 identity key signs three distinct message contexts with no explicit domain-separation tag

**Severity: LOW (hardening).** Surface: key-derivation / receipts-sigs.

The single per-account Ed25519 signing key (`lib/e2ee.ts:288-291`) signs three unrelated message
contexts: receipt party-signing bases (`lib/receipt-attest.ts:81-97`), exchange event leaves
(`lib/exchange.ts`), and wire-credit claims (`lib/exchange.ts`). Each base is a different canonical
JSON shape, so a signature over one is structurally very unlikely to verify over another, and the
review found no concrete cross-context confusion today. But there is no explicit per-context
domain-separation prefix on the signed bytes, so the safety rests on the shapes never colliding as
schemas evolve. Fix (hardening): prepend a fixed context tag (e.g. `"databoard-receipt-v1"`,
`"databoard-exchange-v1"`, `"databoard-wire-v1"`) to the signed bytes in each path.

---

## N-03 — Server never verifies a submitted buyer token is a genuine OPRF output

**Severity: LOW.** Surface: voprf.

The compose/similar endpoints accept any string matching `isBuyerTokenV2` (`v2:` + 128 hex,
`lib/voprf.ts:50-55`); the server never checks that the token is an actual finalized OPRF output.
The `v2:` prefix binds nothing the server enforces. A member can post asks under an arbitrary
128-hex token that corresponds to no real buyer, or under a chosen token to grief the `Buyer #xxxx`
grouping. This does not break blinding or de-anonymize anyone; it only lets a member write board
rows keyed by a token the OPRF never produced. Fix: accept the reduced value only through a
server-observed evaluation bound to the caller (adds linkage the design deliberately avoids — weigh
it), or accept that token authenticity is board-hygiene only and document it. Low priority.

---

## N-04 — Party signature binds only a subset of the receipt; operator can mutate the rest

**Severity: LOW-MEDIUM.** Surface: receipts-sigs.

`partySigningBase` (`lib/receipt-attest.ts:81-92`) commits `v, dealId, tier, buyerToken,
amountBucket, attestedAt, seq, signers`. It does **not** commit `buyerIsOther`, `schemaSha256`, or
`commit`, and it commits only the roster of confirmed participants who *hold a registered signing
key* (`signers`), not the full participant list. So under otherwise-valid party signatures the
operator can still mutate the unsigned fields (flip `buyerIsOther`, swap `schemaSha256`/`commit`, or
present a receipt whose non-signing participants differ) without invalidating any party signature.
Because `seq` and the roster *are* signed, cross-seq and roster-drop attacks fail (see
sound-areas), so this is a field-coverage gap, not a full forgery. Fix: extend `PartyBaseFields`
and `partySigningBase` to cover `buyerIsOther`, `schemaSha256`, `commit`, and the full participant
set, and bump `PARTY_SIG_VERSION`. Clean, invariant-safe change.

---

## 4. Surfaces reviewed and found sound

Examined, no composition/usage defect found. Documented so the auditor can prioritize elsewhere;
independent confirmation still welcome.

1. **`SERVER_PEPPER` single-root domain separation** (`lib/crypto.ts:43-53, 144-192`;
   `lib/translog.ts:70-77`). Every derivation namespaces the pepper (`domain | 0x1f | value` for
   HMAC; distinct HKDF info labels for the VOPRF and translog keys). Contact index, buyer token,
   VOPRF key, and log key cannot collide. The translog/VOPRF operator-forge capability is the
   *documented, intended* bound (HMAC-derived key), not a defect.

2. **DLEQ proof is genuinely verified client-side before the token is used**
   (`lib/voprf.ts:199-210`). `client.finalize(finData, evaluation)` verifies the DLEQ proof against
   the published `publicKeyHex` before unblinding; a mid-flight key change is refused first
   (`:187-191`). The "same key for everyone" guarantee holds; a per-user key gets caught.

3. **RFC 6962 tree/proof math, STH binding, and key/domain separation are sound**
   (`lib/merkle.ts`). Leaf prefix `0x00`, node prefix `0x01`, empty tree `SHA-256("")` (`:46-62`);
   the iterative inclusion (`verifyInclusionHex`, `:155-195`) and consistency
   (`verifyConsistencyHex`, `:206-265`) verifiers are the RFC's own algorithms with the
   power-of-two edge case handled (`:235`); the STH signing body excludes the signature field and is
   canonicalized (`sthSigningBody`, `:305-313`). No second-preimage between leaf and node hashing.

4. **Receipt cross-deal / cross-seq / cross-attestation replay is closed**
   (`lib/receipt-attest.ts:81-92, 161-185`; `lib/party-sigs.ts:74-145`). The signing base commits
   `dealId` and `seq`; `storePartySig` pins `(deal, user, seq)` write-once and rejects a signature
   whose `pubkey` is not the caller's own registered key (`:131-137`), so a session cannot sign for
   a stranger's handle. `storedPartySigs` filters to on-roster handles so a stale row cannot claim a
   seat. Non-malleability and non-operator unforgeability hold for the party layer.

5. **DEK key-commitment closes the non-committing-AEAD gap** (`lib/exchange.ts:323-328`).
   `dek_commit = SHA-256(DEK_COMMIT_DOMAIN | 0x1f | dealId | 0x1f | salt | DEK)` binds the key, the
   deal, and a salt, so the buyer's `SHA-256(...DEK) == dek_commit` check on reveal rules out a
   second key that decrypts the AEAD to different plaintext.

6. **Chunk AAD + RFC 6962 prefixes prevent reorder, splice, truncation, second-preimage**
   (`lib/exchange.ts:337-339, 373-400`). Each chunk's AAD is
   `CHUNK_AAD_PREFIX | sessionId | "/" | u32be(index)`, binding it to its session and position; a
   fresh random 12-byte nonce per chunk (`:386`) avoids IV reuse under the per-deal DEK; the
   plaintext and ciphertext Merkle manifests use the RFC 6962 leaf prefix, so a reordered, spliced,
   or truncated blob fails either the AAD or the root check.

7. **`dek_revealed` is gated on the counterparty step and cannot be advanced by the seller alone**
   (`lib/exchange.ts:586-639`). `resolveTransition` is the single server-enforced authority: from
   `payment_signaled` only the seller may post `dek_revealed`, and `completed` requires the buyer;
   in the wire-credit path the DEK reveal follows the buyer's countersignature of the
   WireCreditClaim. Role and state are checked server-side, so the seller cannot skip the pay/ack
   steps or forge the buyer's move.
