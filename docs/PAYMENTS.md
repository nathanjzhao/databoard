# Payments blueprint

Design only. Nothing in this document is built, and the product shows no
payment UI. This is the architecture we would ship, written down so the
compliance line, the integration order, and the parts that require the owner
are settled before any code exists. The deals rung on
/transparency/verification points here.

## The line: the platform never custodies

FinCEN has treated "hold the money until the buyer clicks release" as money
transmission, a licensed business we are not in. The reasoning is spelled out
on /transparency/verification (section 05, "The line we do not cross"): if a
payment ever earns a verification rung, it is because a bank, a payment
processor, or a licensed escrow agent reported it, not because it passed
through an account of ours. Every design below obeys that line. Funds move
seller-to-buyer over rails both parties own; the platform reads states and
records claims.

That line is also why the referral ledger (lib/referrals.ts) is computed and
recorded, never held: the platform derives what descendants owe ancestors
(2.5% per step of invite depth, geometric, capped at depth 6) and lets each
pair record settlement two-sidedly. Today that obligation is contractual (the
/terms referral section) and privilege-gated (accounts behind on it lose
posting rights). At-source deduction, where the fee never reaches the earner
in the first place, is what path 1 below adds.

## Path 1: Stripe Connect (the upgrade)

Sellers onboard their own Stripe accounts. Money moves buyer to seller
through Stripe; the platform is the Connect "platform" that created the
account link and can read payment status. Stripe is the regulated money
transmitter, not us.

### Shape

- Each seller onboards a Stripe **Express** account (Stripe-hosted
  onboarding, Stripe handles KYC; the account belongs to the seller) or
  connects an existing **Standard** account. The platform stores only the
  account id (`acct_...`), keyed to the pseudonymous user id. Stripe learns
  the seller's legal identity; the platform does not receive it through this
  integration and does not ask for it.
- A deal that both sides want paid on-rail gets a Stripe **invoice** (or
  payment link) created on the seller's connected account, stamped with a
  random 128-bit deal nonce in the memo and metadata, same discipline as the
  channel-bound invoice mechanism on /transparency/verification.
- Deal verification reads the payment object: live mode, posted/succeeded
  state re-fetched from Stripe (never trusted from a webhook body alone), a
  one-use provider transaction id, reversal checks near 7 and 30 days. That
  is what would light the payment rung, with the same honest limits the
  verification page states: it proves money moved, not who the payer legally
  is, and nothing about the dataset.
- **Referral fees at source**: with a platform account in place, Stripe
  **application fees** deduct the referral obligation from the charge before
  the remainder settles to the seller. The geometric split (2.5% to the
  direct inviter, 2.5% of 2.5% to the next ancestor, capped at depth 6) is
  computed by the same lib/referrals.ts walk the ledger uses today, converted
  to per-ancestor transfer amounts in integer cents. Ancestors receive their
  cut as Stripe transfers to their own connected accounts. The platform
  routes instructions; Stripe holds and moves the money. The recorded ledger
  stays as the audit trail; it stops being the enforcement mechanism.

### Env flags

Same pattern as Resend/Twilio in lib/verify.ts: the integration is inert
until its variables exist, feature checks are `Boolean(process.env...)`, and
routes that need an unconfigured provider answer 503 with terse copy, never
crash.

| Variable                | Role                                                            |
| ----------------------- | --------------------------------------------------------------- |
| `STRIPE_SECRET_KEY`     | Platform API key. Absent = the entire path is off.              |
| `STRIPE_WEBHOOK_SECRET` | Verifies webhook signatures. Webhooks are hints only; state is re-fetched. |
| `STRIPE_CONNECT_MODE`   | `express` or `standard`; which onboarding flow /api/payments/onboard starts. |
| `STRIPE_FEES_ENABLED`   | `true` only when the owner's platform account can take application fees. Off = payments verify, referral fees stay ledger-recorded. |

### Endpoints (sketch)

| Endpoint                          | Method | Does                                                                 |
| --------------------------------- | ------ | -------------------------------------------------------------------- |
| `/api/payments/onboard`           | POST   | Creates/reuses the caller's connected account, returns the Stripe-hosted onboarding URL. |
| `/api/payments/onboard/status`    | GET    | `charges_enabled` / `payouts_enabled` for the caller's account.      |
| `/api/payments/invoice`           | POST   | Seller creates the nonce-stamped invoice for a deal they are a confirmed participant of. |
| `/api/payments/status`            | GET    | Re-fetches payment state for a deal's invoice; the only reader deal verification trusts. |
| `/api/payments/webhook`           | POST   | Signature-checked; marks a deal for re-fetch, decides nothing itself. |

All handlers async, rate-limited with the lib/ratelimit.ts pattern, and
answering 503 when `STRIPE_SECRET_KEY` is absent. New state lands in new
tables (`payment_accounts`, `payment_invoices`), never new columns, per the
schema rule.

### What requires the owner

- A **business entity**. A Stripe platform account that collects application
  fees is a business relationship with Stripe; Stripe's platform agreement
  and fee collection require one.
- **Stripe platform onboarding**: creating the platform account, enabling
  Connect, passing Stripe's platform review, configuring application fees.
- A decision on **Express vs Standard** default (Express is less friction
  for sellers and more platform responsibility; Standard is the reverse).
- Legal review of the /terms referral section against the at-source flow, so
  the contractual fee and the deducted fee are the same fee.

Until those exist, `STRIPE_SECRET_KEY` stays unset and everything below the
line stays exactly as it is today.

## Path 2: status quo (runs today)

Settlement happens off-platform, between the parties, over whatever rail
they choose. The platform records:

- **Evidence commitments**: participants commit SHA-256 hashes of payment
  documents, hashed in their own browsers; the document never crosses the
  wire (/transparency/verification, section 03).
- **Two-sided settlement records**: the payee records the referral money
  they received (against their own interest) and the payer confirms it in
  `referral_settlements`, the same mutual-confirmation ethos as deal
  shares. Recorded, never custodied.
- **Privilege gating**: accounts more than 60 days behind on referral
  obligations lose posting and deal-recording until settled or disputed.

Path 2 is not a degraded mode; it is the compliance-clean floor. Path 1 adds
verification strength and at-source fees on top of it, and both paths keep
the same ledger.
