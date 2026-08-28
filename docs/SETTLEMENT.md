# Fiat settlement without platform custody: the F-ladder

Real data buyers are AI labs. They pay by wire, ACH, or cash, never crypto. The
on-chain escrow tier in `docs/EXCHANGE.md` (Tier B) is dead weight if nobody
touches USDC. This document is the fiat answer: do not put money on chain, put a
**proof the wire happened** into the system, bound to the deal, and let that
proof gate delivery and settle the fee.

It is the payment half of the exchange. The dataset handoff stays Tier A
(`lib/exchange.ts`): commit, encrypt, deliver ciphertext, reveal the key. What
changes is the `pay` step, which today is a self-reported signal. The ladder
below upgrades it in three rungs, F1 to F3, each honest about what it removes
trust in, what it leaves behind, and what the owner must provide before it can
ship.

## The bottom line, stated first

There is **no universal cryptographic proof of objective fiat finality**. No
protocol makes a bank irrevocably credit an account and proves it to a third
party. The strongest true statement available is narrow:

> the receiving bank or a regulated provider reported an incoming wire of amount
> X, carrying deal reference N, as accepted / credited / posted at time T.

A buyer's wire receipt proves only **initiation**. Even an accepted wire can be
returned, frozen, or reversed. So the terminal state a proof earns is
`wire_credit_observed`, and a later `wire_reversed` event can reopen the deal.
It is never `fiat_final`, and nothing on this ladder claims it is.

The canonical predicate a payment proof binds, at every rung that has one:

```
deal id + 128-bit deal nonce + WIRE + CREDIT
  + exact amount / currency
  + terminal bank status (accepted / credited / posted)
  + value time
  + hidden recipient-account nullifier (seller-bound)
  + H(IMAD / UETR)
  + evidence / schema version
```

Raw evidence travels end-to-end encrypted between seller, buyer, and any
arbiter. The transparency log stores only its salted hash, the normalized
result, and the parties' signatures. The server never sees bank details, the
payer's legal identity, or the exact amount (amounts are bucketed in anything
public).

## The wire-reference nonce (N15)

Every rung references one deal by a nonce the parties can carry on a wire.

- Internal: a random **128-bit deal nonce**, stored bound to the deal.
- Rail-safe alias shown to the buyer:
  **N15 = first 15 Crockford-Base32 characters of `SHA-256(dealId || nonce)`**,
  uppercase ASCII, no spaces.
- The buyer is told to put N15 in the wire **End-to-End ID /
  reference-for-beneficiary** AND at the **start** of the remittance text (the
  start position survives trailing truncation).

Honest rail caveats, printed next to N15 in the UI:

- **Fedwire** (ISO 20022 since July 2025): `EndToEndId` is 35 chars, 140 chars of
  unstructured remittance, but a sender may send `NOTPROVIDED` and the bank's
  memo UI need not map the field.
- **CHIPS** (ISO 20022): 35-char end-to-end id.
- **SWIFT CBPR+**: `EndToEndId` 35 chars is supposed to pass unchanged; capture
  the 36-char UETR; legacy MT103 field 20 is only 16 chars.
- **ACH**: optional id 15 chars, addenda 80 chars, and Nacha warns the addenda
  may not display. Same Day ACH is capped at $1M, so a $5M ticket must be wired.

Acceptance never keys off the nonce alone. It matches amount + currency +
receiving account + terminal credit status + a time window + IMAD/UETR. A
**per-deal virtual account is stronger than any narrative reference**, because it
routes on the account number, not on a memo string a bank may drop. That is F3.

---

## F1: bilateral WireCreditClaim (built now, no external dependency)

The `pay` step becomes a three-party attested claim on the existing hash-linked,
signed event chain. No bank API, no chain, no escrow. It removes unilateral
self-reporting, equivocation, and log-rewriting. It does **not** prove a bank
event, collect the fee, or make the trade atomic.

### The claim

1. **`PAYMENT_SENT_COMMIT` (buyer).** After wiring, the buyer signs a salted
   SHA-256 (computed in the browser, the confirmation file never uploaded) of its
   wire confirmation + amount bucket + N15.
2. **`WireCreditClaim` (seller).** After observing the inbound credit, the seller
   signs the canonical claim (the predicate fields above) plus a salted
   commitment to its receiving-bank record.
3. **Countersign (buyer).** The buyer countersigns. Only then does the exchange
   advance to the DEK reveal.

Each is a signed leaf in the chain, the same construction as every other
exchange step. A `wire_reversed` event, signed later, reopens the deal and
reverts any weighting.

### What F1 removes trust in

- **No unilateral self-report.** The old pay step was one party asserting
  payment. Now both sign, over the same reference and bucket, and the buyer
  countersigns before the key is revealed.
- **No equivocation or log rewriting.** The claim is a signed, hash-linked leaf.
  A party cannot later show a different story than the one they signed.
- **The reference is bound.** N15 ties the attested wire to this one deal.

### The residual

- **It does not prove a bank event.** It is mutual attestation that a wire with
  this reference was sent and observed, not proof a bank credited it. Both
  parties could collude to attest a wire that never landed.
- **Not atomic, not `fiat_final`.** The last mover can still stop, and an
  observed credit can still be reversed. F1 supports `wire_reversed`; it cannot
  prevent the underlying reversal.
- **The fee is not collected at source.** F1 records the obligation; it does not
  move money or take the 2.5%.

### Weighting

A countersigned `wire_credit_observed` deal feeds the existing verified-amount
weighting (it counts like an evidence-committed deal), reverted on
`wire_reversed`. The weighting rule lives with the rest of the tier weights and
is documented on `/transparency/verification`.

### What the owner must provide

Nothing external. F1 is client-side crypto over the existing chain. The one
decision is copy: the UI and `/transparency` must say plainly that this is
attestation, not proof.

---

## F2: verifiable proof of an incoming wire (near term, seam built)

The upgrade that makes the credit **checkable**, not just attested. The brief's
recommendation, and what the seam in `lib/payproof.ts` is shaped for, is one
strict **Reclaim zkTLS custom provider** against a single known receiving bank.
Reclaim is the most productized of the web-proof options, browser-verifiable,
and privacy-preserving; TLSNotary is the stronger trust model but pre-1.0 alpha;
ZK Email proves a bank DKIM-signed a credit notice (notification semantics, not
ledger); Plaid/Teller/MX and Wise are attestor-style fallbacks.

### The shape (where the code runs)

- The **seller** produces the proof against their own bank portal.
- It travels **E2EE to the buyer**.
- The buyer **verifies it in their own browser** (the `PayProofVerifier`
  interface, plus the provider's witness-signature check).
- The platform logs **only a salted hash of the proof envelope, the normalized
  bucketed result, and the buyer's acceptance**. It never receives the proof, the
  bank credentials, the account number, or the exact amount.

### The required predicate

A Reclaim custom provider discloses only: receiving bank, CREDIT/WIRE, amount,
currency, nonce, terminal status, and posting time, while hiding credentials and
account numbers. To count, a proof must satisfy (this is `PAYPROOF_PREDICATE` in
`lib/payproof.ts`, verbatim):

- inbound **WIRE/CREDIT**, not a debit and not a pending authorization;
- **exact amount and currency**, inside the deal's declared amount bucket;
- **N15 matched** in the End-to-End ID / reference-for-beneficiary;
- a **bank terminal credit status** (accepted / credited / posted), not merely
  initiated;
- a **seller-bound recipient-account nullifier**, account number hidden;
- a **fresh proof session**, so an older witnessed session cannot be replayed;
- a **pinned provider version/hash**, so the browser verifier checks a known
  template.

### The seam, and its inert default

`lib/payproof.ts` is an env-flagged pluggable verifier, the same OTP-provider
pattern as `lib/verify.ts`: a `Boolean(env)` feature check, inert until
configured.

- Unconfigured (default): `POST /api/payproof/verify` answers **503** and the UI
  says "verifiable proof-of-payment: planned".
- `PAYPROOF_DEMO=1` (dev only, refused in production): a clearly-labeled demo
  verifier walks the flow and proves nothing about real money. Every demo result
  carries `demo: true` and is never counted as a real proof.
- `PAYPROOF_PROVIDER=reclaim` with `PAYPROOF_RECLAIM_PROVIDER_ID` and
  `PAYPROOF_PROVIDER_VERSION_HASH` pinned: the real provider is selected. Until
  the browser verifier is actually shipped, this answers **503, not implemented**,
  rather than fabricating a pass. We do not fake a real proof.

### What F2 removes trust in

- **The bank really credited it.** A zkTLS proof authenticates the bank's own
  HTTPS transaction record, not a party's word.
- **The platform stays blind.** Verification happens in the buyer's browser; the
  server sees a hash and an acceptance.

### The residual

- **Bank status semantics.** The proof authenticates whatever the bank's page
  says; "credited" on the portal is not a court's finding of finality.
- **Reclaim witnesses and version pinning.** Trust moves to the Reclaim attestor
  set and to the pinned provider template; template drift and bank bot defenses
  are permanent operational costs.
- **Bank-page stability.** One bank, one portal. If the portal changes, the
  proof breaks. Fallbacks: F1, Wise's RSA-signed webhook for funds received into
  Wise, or MX's beta signed transaction Verifiable Credential.
- **Still not `fiat_final`.** A verified credit can still be reversed; the
  `wire_reversed` path from F1 remains.

### What the owner must provide

- A **known receiving bank** whose portal exposes a stable, structured wire-credit
  record (not a rendered PDF statement).
- A Reclaim app/provider registration and a **pinned provider version/hash**.
- The seller-side account nullifier binding, and a decision on which bank the one
  strict provider targets first.

---

## F3: atomicity without the platform custodying (blueprint)

F1 and F2 make the payment attested, then checkable. Neither makes delivery and
payment **atomic**, because atomic fair exchange needs a trusted mediator
(Pagnia-Gaertner; see `docs/EXCHANGE.md`). F3 gets atomicity from a **licensed
escrow** or an **invisible on-chain bridge**, with the platform never custodying
funds. Milestone release keys off party-signed delivery/reveal hashes and buyer
acceptance, because the escrow agent cannot read the E2EE dataset.

### FinCEN posture (both routes)

The platform **never receives principal, holds no balance, and has no unilateral
release key**. FinCEN has treated "hold the money until the buyer clicks release"
as money transmission. A genuine escrow that administers delivery, inspection,
and refund conditions, or a licensed money transmitter that on-ramps and
off-ramps, can fall outside that line. The platform is at most a referrer that
passes states and tokens, never money. This is a posture, not legal advice, and
it is why the owner must provide a written no-money-transmission memo before
either route ships.

### Default route: no crypto, licensed escrow

**Escrow.com (US, high ticket).** Native milestone API, sandbox, funded and
disbursed states, buyer funds upfront. Fees roughly 2.4% under $50k, down to
about 0.95% at $3M to $5M; all parties verify above $3000; broad US escrow and
money-transmitter licenses. Crucially, the API supports a **fixed partner fee OR
a percentage broker fee, so Escrow.com can disburse the platform's 2.5% referral
directly**: at-source fee collection through a licensed escrow, with no platform
custody.

**Tazapay (cross-border fallback).** Cross-border B2B escrow, bank/wire funding,
milestones, seller KYB. The best fallback when the parties are in different
countries.

(Trustap exists at 4 to 5% with Stripe holding funds but no native multi-
milestone, noted only as a distant third.)

- **Removes trust in:** payment reality and, at last, atomicity of the milestone.
  A licensed agent verified both the incoming and disbursement names under KYB and
  releases only on the agreed condition.
- **Residual:** the escrow agent learns both legal identities (that is the point
  and the price); vendor discretion on holds and disputes; the platform stays
  blind only if the integration passes nothing but states and tokens.
- **Milestone release** keys off the party-signed delivery/reveal hashes from
  Tier A plus buyer acceptance and deadlines, since the agent cannot read the
  encrypted dataset.

### Optional route: invisible on-chain bridge

**Bridge.xyz (Stripe-acquired, holds US money-transmitter licenses).** Buyer
wires USD to a buyer-named Bridge virtual account, which auto-converts to USDC,
into a per-deal escrow address, to a seller liquidation address, and auto-wires
the seller's bank. No seed phrase, wallet, or gas UI. Roughly 1.25% round trip
(about 0.75% on-ramp + 0.5% off-ramp). USD wire up to about two hours; large
transactions get extra review. Pilot-realistic at $50k to $250k; a $5M ticket
needs pre-clearance. **Circle Mint** is the institutional alternative (cheaper,
less composable, weekly limits around $1M in / $500k out by default). Zero Hash
is a strong second bridge (named virtual accounts + auto conversion). CCTP is not
an on-ramp.

- **Removes trust in:** atomicity via the on-chain escrow leg, without the
  parties ever seeing a wallet.
- **Residual:** it does **not** hide USDC exposure, KYB, or issuer freeze risk;
  chain exposure and stablecoin issuer discretion are real; large tickets need
  pre-clearance.
- **Milestone release** must, as above, key off the party-signed delivery/reveal
  hashes and buyer acceptance, and for Bridge the owner must provide an audited
  per-deal escrow contract.

### What the owner must provide (F3, either route)

- A legal **entity** and, for the chosen vendor, **vendor KYB**; and hosted
  **counterparty KYB** for the parties the escrow onboards.
- A **DPA** with the vendor.
- **Written approval** for dataset licensing as the escrow's subject matter, for
  $5M tickets, and for the countries in scope.
- **Negotiated fees** and explicit treatment of the platform's 2.5% (fixed
  partner fee vs. percentage broker fee).
- **Milestone, refund, and arbitration rules** the escrow can administer.
- A **no-money-transmission legal memo**.
- For Bridge specifically, an **audited per-deal escrow contract**.

---

## The ladder at a glance

| | Payment is attested | Payment is proved | Fee at source | Atomic settlement | Platform custody |
| --- | --- | --- | --- | --- | --- |
| **F1 (built)** | yes (three-party claim) | no | no | no | none |
| **F2 (seam built)** | yes | yes (zkTLS, one bank) | no | no | none |
| **F3 escrow (blueprint)** | yes | yes (KYB'd agent) | **yes** (Escrow.com) | **yes** (milestone) | none |
| **F3 bridge (blueprint)** | yes | yes (on-ramp record) | at off-ramp | **yes** (on-chain leg) | none |

The order is deliberate. F1 is the floor everyone gets today with no dependency.
F2 makes the credit checkable against one real bank. F3 adds atomicity and
at-source fee collection through a licensed third party, never through an account
of ours. The exchange ladder in `docs/EXCHANGE.md` and the payment rung on
`/transparency/verification` both point here.
