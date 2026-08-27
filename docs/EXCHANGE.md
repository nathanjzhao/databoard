# Dataset exchange: the trust ladder

How a dataset actually changes hands for money on DataBoard, and exactly how
much trust each way of doing it removes. Tier A is built and live at
`/deals/[id]/exchange`. Tier B and Tier C are design, written down so the
compliance line and the integration order are settled before any code exists.
The payment rung on `/transparency/verification` points here.

## The result we are working around

Atomic fair exchange of a dataset for a payment between two mutually
distrusting parties is impossible without a trusted third party or a consensus
system. Pagnia and Gaertner (1999) reduce fair exchange to a fairness/agreement
problem equivalent to distributed consensus: with two parties and no trusted
mediator, whoever moves last can always refuse to complete, and no protocol run
purely between them closes that gap. A blockchain is a shared trusted mediator
made of many untrusted ones; an escrow agent is a single trusted one. There is
no third door.

So the goal is not trustlessness. It is **trust minimization plus evidence**:
push the amount of trust each party must extend as low as it will go, cap the
size of what a cheat can steal, and make any cheat detectable and attributable
after the fact. A tier is honest about what it removes trust in and what it
leaves behind.

---

## Tier A: commit-encrypt-pay-reveal (built)

No external service, no chain, no escrow. Everything cryptographic runs in the
two browsers (`lib/exchange.ts`). The server stores commitments, signatures and
state transitions, and never the dataset, the key, or any exact figure.

### The protocol

Two accounts, both confirmed participants of the same deal: a **seller** (the
data holder) and a **buyer**.

1. **Commit (seller).** The seller chunks the dataset, AEAD-encrypts each chunk
   under a per-deal key (the DEK) with AES-256-GCM, and builds two RFC 6962
   Merkle manifests: one over the plaintext chunk hashes, one over the
   ciphertext chunk hashes. They commit `plaintext_root`, `ciphertext_root`, and
   `dek_commit = SHA-256(domain || deal_id || salt || DEK)`, a hash of the key,
   and sign the commitment with their Ed25519 key.
2. **Deliver (seller, off the exchange server).** The encrypted chunks go to the
   buyer: directly, through the end-to-end-encrypted deal-room thread as
   ciphertext, or, in the demo, through a size-capped opaque blob the server
   holds as bytes it cannot read.
3. **Ciphertext ack (buyer).** The buyer recomputes the ciphertext root from what
   they received and signs "ciphertext received, matches the commitment". They
   now hold sealed data they cannot open.
4. **Payment signaled (buyer).** The buyer pays off-platform and signs a payment
   reference commitment: a hash, with no amount and no raw reference in it.
5. **Reveal (seller).** The seller sends the DEK to the buyer (off the exchange
   server) and signs "the key matching `dek_commit` is revealed". The server
   still never sees the key.
6. **Complete (buyer).** The buyer checks `SHA-256(...DEK) == dek_commit`,
   decrypts, verifies the plaintext against `plaintext_root`, and signs
   "plaintext verified". Terminal.

Either party may sign an **abort** on a non-terminal session.

Every step is a signed leaf, hash-linked to the last: leaf N carries
`prevHash = SHA-256(leaf N-1)`, and each leaf is Ed25519-signed by the acting
party over its canonical bytes. The chain is tamper-evident, and each party is
pinned to one signing key at their first step, so a valid chain proves the same
two parties took each step, in order. The browser reverifies every signature and
link on load; a broken chain is shown as broken.

### What the server can and cannot see

- **Can see:** the deal id, the two pseudonymous handles, the Merkle roots
  (hashes of hashes), `dek_commit` (a hash), chunk count and chunk size, a coarse
  byte-size bucket, a payment-reference commitment (a hash), every signature and
  signing pubkey, the state, and timestamps. On the demo path only, an opaque
  AEAD blob it cannot decrypt.
- **Cannot see:** the dataset, the DEK, the AEAD keys, the exact byte size (only
  a bucket), the payment amount (only that payment was signaled), the raw payment
  reference, or any chunk plaintext.

### What Tier A removes trust in

- **The seller cannot swap the data after committing.** The plaintext and
  ciphertext roots are signed at step 1; a different dataset produces different
  roots, and the buyer checks both.
- **The seller cannot reveal a wrong key undetected.** The buyer checks the
  revealed key against `dek_commit` and the decrypted plaintext against
  `plaintext_root` before completing. A wrong key fails locally and the buyer
  never signs complete.
- **The operator cannot forge a step or a completion.** The operator holds no
  signing key. Receipts and states that claim a party acted carry that party's
  own signature.
- **Exposure is capped to one chunk.** A party that stops after receiving has
  received at most one more chunk than it has paid for, because the manifests are
  per chunk and the reveal is all-or-nothing only at the key. (In this build the
  key unlocks every chunk at once; a per-chunk-key variant that caps exposure to
  literally one chunk is a straightforward extension noted below.)

### The residual (what Tier A does not fix)

- **It is not atomic.** The last mover can still stop. Step 5 depends on the
  seller choosing to reveal after the buyer has paid; step 4 depends on the buyer
  choosing to pay after acking ciphertext. What the chain buys is not completion,
  it is **evidence**: whoever stopped, and after which step, is provable from the
  signatures. This is the Pagnia-Gaertner gap, unremovable at this tier.
- **Payment is off-platform and self-reported.** Step 4 is a commitment to a
  reference the buyer holds, not proof that money moved. Binding a real payment
  to the step is the payment rung on `/transparency/verification` and Tier B/C
  below.
- **Trust in served code, not in stored data.** The guarantee is against the
  database, not against a malicious operator serving tampered JavaScript that
  exfiltrates a key. Open code and public CI make that detectable, not
  impossible. Same boundary as the end-to-end-encrypted messages.
- **Keys derive from passwords the client handles.** The signing and encryption
  keys are password-derived in the browser; there is no recovery, and a device
  that never held the DEK cannot reveal it.

### Extensions that stay in Tier A

- **Per-chunk keys** (`DEK_i = KDF(DEK, i)`), revealed one at a time against
  per-chunk hash-locks, so a stop-after-receiving costs exactly one chunk.
- **Independent witness cosigning** of the event chain, so the "operator served
  tampered JS" boundary shrinks to "operator and an independent witness both
  did".

---

## Tier B: on-chain, non-custodial (design)

This is the tier that adds real atomicity, by replacing the trusted third party
with a chain. The platform holds no funds and no keys at any point. It publishes
contract bytecode, renders unsigned calldata for the parties to sign in their own
wallets, relays already-signed transactions, and indexes the resulting events.

### Shape

- **Per-deal escrow.** A minimal non-custodial escrow contract, or a per-deal
  2-of-3 Safe (buyer, seller, arbitrator), funded by the buyer in USDC. Release
  is gated on the buyer's signature, or on an arbitrator ruling.
- **Hash-locked reveal.** The DEK commitment from Tier A becomes an on-chain
  hash-lock: the seller's reveal transaction posts the preimage, which both
  releases escrow and hands the buyer the key in one atomic step. This closes the
  Pagnia-Gaertner gap, because the chain is the trusted mediator that makes the
  last move atomic.
- **Arbitration.** A dispute routes to Kleros (or a named arbitrator on the
  Safe). The plaintext and ciphertext commitments from Tier A are the evidence
  the arbitrator rules over; nothing about the data leaves the parties.
- **Receipts.** Completion emits an EAS (Ethereum Attestation Service) attestation
  binding the deal id, the commitments, and the two signing keys, so the receipt
  is independently checkable on-chain, not just against the operator's MAC.

### Posture

The platform is a **developer of non-custodial software**. Under FinCEN's 2019
guidance, an anonymizing-software provider that never takes control of value is
not a money transmitter; the parties transact wallet to wallet through code the
platform merely publishes. The platform never holds a key to the escrow, never
signs a release, and never touches the funds. This is a posture, not legal
advice, and it is why the platform relays signed transactions rather than
building or co-signing them.

### What Tier B removes trust in

- **Atomicity.** The hash-locked reveal makes "reveal the key" and "release the
  payment" one transaction. The last mover can no longer take and run.
- **Independent verification.** Escrow state, the hash-lock preimage, and the EAS
  receipt are all on a public chain, checkable without the operator.

### The residual

- **Chain and contract risk.** Trust moves from a counterparty to the contract
  code, the chain's liveness, and the arbitrator's honesty for disputed cases.
- **Payment is on-chain only.** Fiat rails do not fit here; this tier is USDC or
  another on-chain asset. A buyer who wants to pay by wire is Tier C.
- **On-chain metadata.** Escrow amounts and timing are public on-chain, even
  though the parties stay pseudonymous. Amounts are not bucketed once they are a
  real transfer.
- **Gas and UX.** Both parties need wallets and gas. The platform relays but does
  not sponsor, to keep the non-custodial line clean.

---

## Tier C: regulated processor (design, and the honest not-trustless option)

For parties who want fiat and do not want a chain. The dataset handoff stays
Tier A; the money moves through Stripe Connect (see `docs/PAYMENTS.md`), which is
the regulated money transmitter. Sellers onboard their own Stripe accounts;
funds move buyer to seller through Stripe; the platform reads payment status and
never custodies. Completion of the Tier A reveal can be gated on Stripe reporting
the charge captured.

### What Tier C removes trust in

- **Payment reality.** Stripe reporting a captured charge is independent evidence
  that money moved, bound to the deal, which no self-report can be. This is the
  payment rung on `/transparency/verification`, made real.

### The residual

- **It is not trustless, and does not claim to be.** A regulated intermediary is
  trusted by construction; that is the trade for fiat and for chargeback
  protection. Stripe learns the payer.
- **KYB.** Sellers onboard to Stripe and are known to Stripe. The platform still
  never learns the real identity behind a handle, but the processor does.
- **Not atomic either.** Stripe capture and DEK reveal are two events the platform
  correlates, not one atomic step. Only Tier B's on-chain hash-lock is atomic.

---

## What each tier removes trust in, at a glance

| | Data integrity | Key correctness | Atomic settlement | Payment is real | Operator cannot forge | Trustless |
| --- | --- | --- | --- | --- | --- | --- |
| **A (built)** | yes (roots) | yes (buyer-checked) | no | no (self-report) | yes (party sigs) | mostly (served-code caveat) |
| **B (on-chain)** | yes | yes (hash-lock) | **yes** | yes (on-chain) | yes (EAS) | yes (contract/chain trust) |
| **C (Stripe)** | yes (Tier A) | yes (Tier A) | no | **yes** (processor) | yes (Tier A sigs) | no (regulated intermediary) |

The order is deliberate: Tier A is the floor everyone gets with no dependency;
Tier B adds atomicity at the cost of a chain; Tier C adds fiat and real-payment
evidence at the cost of a regulated intermediary. None of them lets the platform
hold funds or keys.
