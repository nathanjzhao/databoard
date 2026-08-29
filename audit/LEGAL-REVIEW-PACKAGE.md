# DataBoard: legal review package

Prepared for payments/fintech counsel. Date of assembly: 2026-08-29.
Prepared by: the operator (an individual, not an entity).

## How to read this

This is a design memo, not a research request. Each section states the design
position the platform already takes in code and in its published terms, then
asks the one or two questions counsel needs to confirm or correct. The goal is
a fast review: the analysis and the primary sources are already gathered here,
so the lawyer's job is to check the conclusions, not to build them.

Nothing below is a legal conclusion by the operator. Where a section says "the
position is X," read it as "the platform is built and documented as if X, and
needs counsel to confirm X holds." The governing-law jurisdiction is unset and
marked **[SET BEFORE LAUNCH]**; several answers depend on it.

Live product: https://getdataboard.vercel.app
Public code: https://github.com/nathanjzhao/databoard
The exact files a reviewer should open are listed in section 7.

---

## 1. What the platform is, and what it deliberately is not

DataBoard is a gated, pseudonymous, invite-only board. Vetted accounts post
RFP-style asks for data (buyers are AI labs seeking training and eval data),
match on blinded buyer tokens, message end-to-end encrypted, record deals on a
ledger, and owe a geometric referral fee to their invite chain. It is operated
by one individual; there is no company today.

What it deliberately is NOT (this list is published verbatim at `/terms`,
section 01, and enforced by the schema and the code):

- **Not an escrow.** It never holds deal funds, fiat or crypto, in any amount,
  for any duration.
- **Not a payment processor.** No money moves through the platform. Deals close
  off-platform, on rails the parties choose.
- **Not a custodian of a release key.** In every settlement tier the platform
  holds no principal, no balance, and no unilateral authority to release,
  redirect, or freeze funds.
- **Not a verifier of deals.** A deal on the ledger is a claim by accounts,
  graded only by labeled tiers (`/transparency/verification`) that each say how
  little they prove. The strongest built tier is mutual attestation between
  pseudonymous parties, never independent verification.
- **Not a party to the transactions.** Contracts, delivery, payment, and
  disputes are between the parties.
- **Not a store of legal identity.** The database holds a chosen username, an
  scrypt password hash, a one-bit org/individual flag, and a one-way keyed
  blind index of the signup contact used only to enforce one-account-per-contact.
  No email, phone, name, employer, IP, or device column exists. Signup contact,
  name, and affiliation pass through server memory for two requests during
  attestation and are never written down (`/privacy`, sections 01 to 02).

**Design position.** The platform is a matching forum and a record-keeper. It
takes no custody of funds and stores no PII, by construction, not by promise.
The "what it is not" list is the load-bearing part of the design.

**Question for counsel.** Confirm that this self-description (matching forum +
non-custodial record-keeper, no PII) is the right characterization to anchor
the analyses in sections 2 to 6, and flag any place where the platform's
conduct would nonetheless be recharacterized (for example, as a broker, dealer,
or intermediary) regardless of the no-custody / no-PII posture.

---

## 2. Money transmission / MSB analysis

The platform never receives, holds, or transmits deal funds in any settlement
tier. Money moves seller-to-buyer over rails the parties own; the platform
reads states and records claims (`docs/PAYMENTS.md`, "The line: the platform
never custodies"; `docs/SETTLEMENT.md`, "FinCEN posture"; `/transparency/
verification` section 06, "The line we do not cross").

FinCEN's test is **activity-based**: money transmission generally means
accepting currency, funds, or other value that substitutes for currency from
one person and transmitting it to another. "Non-custodial" is helpful evidence,
not an automatic exemption. The favorable points in the 2019 CVC guidance the
design leans on:

- Mere development of software or a DApp is not money transmission; using or
  deploying it to conduct transmission can be.
- A matching forum whose users settle through outside, user-controlled wallets
  is not a transmitter on those facts.
- A multisig provider that supplies only an additional authorization key,
  without independent control of value, is not a transmitter; hosted balances
  or independent control change the result.

The three settlement tiers, all no-custody:

- **F1 (built): bilateral WireCreditClaim.** The pay step is a three-party
  mutual attestation on a signed, hash-linked chain: the buyer commits a salted
  hash of its wire confirmation plus amount bucket and the deal reference (N15);
  the seller, after observing the inbound credit, signs the canonical claim plus
  a salted commitment to its bank record; the buyer countersigns. The terminal
  state is `wire_credit_observed`, explicitly not `fiat_final`; a `wire_reversed`
  event can reopen the deal. No money touches the platform; it stores commitments,
  signatures, and buckets only. Code: `lib/exchange.ts` (WireCreditClaim region).
- **F2 (seam built, inert): verifiable proof.** A zkTLS web-proof (the shaped
  provider is Reclaim) produced by the seller against its own bank portal,
  carried E2EE to the buyer, verified in the buyer's browser; the platform logs
  only a salted hash of the proof envelope, the bucketed result, and the buyer's
  acceptance. It never receives the proof, credentials, account number, or exact
  amount. Inert until configured; answers 503 otherwise. Code: `lib/payproof.ts`.
- **F3 (blueprint): licensed third party.** Either a licensed escrow
  (Escrow.com for US, Tazapay cross-border) or an invisible on-ramp/off-ramp
  bridge (Bridge.xyz, a licensed money transmitter). The third party contracts
  with the parties, holds principal in its own trust/safeguarded account,
  performs KYC/KYB, and disburses. The platform passes states and tokens, never
  money, and holds no release key. `docs/SETTLEMENT.md`, F3.

**Design position.** Each tier keeps the platform outside the definition of a
money transmitter because at no tier does the platform accept or control value.
F3 specifically contemplates Escrow.com disbursing the platform's 2.5% referral
directly, as either a fixed partner fee or a percentage broker fee on the
Escrow.com transaction, so even the fee is collected by the licensed agent and
never routed through a platform account.

**Questions for counsel.**
1. Does each of F1, F2, and F3 keep the platform outside money transmission
   under the activity-based test and the 2019 CVC guidance?
2. Does having Escrow.com (or Bridge) disburse the 2.5% referral as a partner or
   broker fee change the analysis, that is, does the platform "receive" that
   value in any regulated sense when a licensed agent pays it out on the
   platform's instruction?
3. Please treat as separate follow-ups, flagged but not assumed resolved:
   state money-transmitter licensing (activity-based tests vary by state and do
   not always track FinCEN), and Travel Rule obligations if any tier were ever
   recharacterized. The design assumes these live with the F3 vendor, not the
   platform; confirm.

**Sources.**
- FinCEN, Application of MSB regulations (administrative rulings):
  https://www.fincen.gov/resources/statutes-regulations/administrative-rulings/application-money-services-business
- FinCEN 2019 CVC guidance (PDF):
  https://www.fincen.gov/sites/default/files/2019-05/FinCEN%20Guidance%20CVC%20FINAL%20508.pdf
- Escrow.com API / fees / licenses:
  https://www.escrow.com/api/docs/create-transaction ,
  https://www.escrow.com/fee-calculator , https://www.escrow.com/escrow-licenses
- Bridge licenses / developer agreement / virtual accounts:
  https://www.bridge.xyz/legal/licenses/us-licenses-and-registrations ,
  https://www.bridge.xyz/legal/developer-agreement ,
  https://apidocs.bridge.xyz/platform/orchestration/virtual_accounts/virtual-account
- Tazapay licenses: https://tazapay.com/licenses
- Pagnia-Gaertner (why atomic fair exchange needs a third party, the reason F3
  exists at all): https://www.cs.utexas.edu/~shmat/courses/cs395t_fall04/pagnia.pdf

---

## 3. The referral fee as a contractual obligation

The mechanics, exactly as built in `lib/referrals.ts` and stated at `/terms`
section 08:

- **Geometric fee.** Each ancestor in an account's invite chain accrues a fee
  from that account's board-recorded earnings, decaying by step: direct inviter
  2.5% (exactly 1/40), the next 2.5% of 2.5% (0.0625%), and so on, capped at 6
  steps. Dust beyond depth 6 is not charged.
- **Earnings.** An account's own confirmed shares on deals where at least one
  named counterparty has also confirmed. Solo/unilateral claims accrue nothing.
  The predicate that grants reputation and the one that charges the fee are
  identical, so a member cannot earn standing on a share that owes no fee.
- **Off-platform closes.** The fee is on the recorded deal; it is a price on
  being on the record. The platform cannot reach deals it never sees (stated
  plainly at `/transparency/verification` section 09).
- **Clickwrap.** "By creating an account with an invite code you agree that
  every ancestor in your invite chain accrues a fee..." Assent is at account
  creation with an invite code.
- **House floor.** No confirmed share is fee-free; a grandfathered account with
  no human inviter owes the 2.5% floor to the operator ("the house").
- **Standing-gate enforcement.** An account more than 60 days behind on an
  outstanding balance of at least $1, not actively disputed, cannot post new
  asks or record new deals until it settles or disputes. This gate is the
  entire enforcement today; at-source deduction is planned, not shipped. The
  platform never holds or moves the money; each pair settles off-platform and
  records the settlement two-sidedly (payee records receipt against its own
  interest, payer confirms).
- **Disputes.** One click lifts the gate for 45 days and puts the pair before
  an operator, who upholds or rejects.
- **Timely-recording credit.** A deal recorded within 14 days of its stated
  close date with committed evidence earns a 20% reduction of the referral owed
  up its whole chain. A carrot, never a penalty; never below zero.

**Design position.** The 2.5% is an **earned contractual fee** on a
platform-introduced, platform-recorded deal, not liquidated damages and not a
prohibition on dealing. The research recommends recovery be framed as unpaid
fee plus lawful interest plus reasonable audit/collection cost, not a punitive
multiple, because the lost fee is readily calculable (JMD Holding). Enforcement
against pseudonymous parties is understood to be the weak point: the current
design holds no legal identity, so the fee is collectible in practice only via
the standing gate and network value, not via suit, unless private KYB is added
later.

**Questions for counsel.**
1. Is a percentage referral fee enforceable as a contract against a
   **pseudonymous** counterparty the platform cannot legally identify? What is
   the minimum identity the platform would need to hold (or have an independent
   vault hold) for the fee to be collectible by suit rather than only by
   privilege-gating?
2. Is the invite-acceptance **clickwrap** sufficient assent under E-SIGN and the
   conspicuous-notice/unambiguous-assent line (Berman v. Freedom Financial)?
   What notice or interaction, if any, is missing?
3. Should the fee be documented strictly as an **earned fee** (unpaid fee +
   interest + collection cost) rather than liquidated damages, per JMD Holding?
   Is any current terms language at risk of being read as an unenforceable
   penalty?
4. Does a **percentage success fee on data licensing** create regulated-
   intermediation risk (broker/finder/agency licensing) in the chosen
   jurisdiction? The research flags securities/capital-raising/real-estate
   success fees as the danger zone and recommends excluding those until
   separately reviewed; confirm data licensing is outside it, or scope the
   carve-out.

**Sources.**
- Axial terms (closest analogue: fee on every platform-sourced close, on or off
  platform, with a tail): https://www.axial.net/legal/terms/
- Axial v. Zachert, $750k default judgment, with the caveat that it was not a
  fully litigated merits decision and the penalty portion was challengeable:
  https://law.justia.com/cases/federal/district-courts/new-york/nysdce/1%3A2021cv07323/565873/52/
- E-SIGN Act, 15 U.S.C. 7001: https://www.law.cornell.edu/uscode/text/15/7001
- Berman v. Freedom Financial (clickwrap notice and assent, 9th Cir.):
  https://cdn.ca9.uscourts.gov/datastore/opinions/2022/04/05/20-16900.pdf
- JMD Holding v. Congress Financial (liquidated damages vs. earned fee, NY):
  https://law.justia.com/cases/new-york/court-of-appeals/2005/2005-02565.html
- SEC broker-dealer registration guide (the regulated-intermediation flag):
  https://www.sec.gov/about/divisions-offices/division-trading-markets/division-trading-markets-compliance-guides/guide-broker-dealer-registration
- Upwork user agreement / 10-K, Faire pricing (non-circumvention comparables):
  https://www.upwork.com/legal#useragreement ,
  https://investors.upwork.com/static-files/30673492-032c-4fea-b707-94969a5942f0 ,
  https://www.faire.com/support/articles/360015893392?section=3

---

## 4. Pyramid / MLM risk on the multi-level referral

The fee is multi-level (six geometric steps up an invite chain), which is the
shape that draws pyramid-scheme scrutiny. The distinguishing design fact:

- **The fee pays only from real, confirmed deal earnings.** An ancestor earns a
  cut only when a descendant records a confirmed share on a deal at least one
  named counterparty also confirmed. Recruiting someone who never deals pays
  **zero at every level**. There is no headhunting bounty, no pay-to-join, no
  payment triggered by recruitment itself, and no purchase or membership fee
  required to participate (the service has no fees today; `/terms` section 05).
- Solo/unilateral claims accrue nothing, so a chain cannot manufacture payouts
  by recording fake self-deals; the same predicate gates reputation and fee.
- The 2.5%/40x geometric decay means deep chains collect dust; the value is in
  the direct step.

**Design position.** Because payout is tied strictly to actual downstream
commercial earnings and never to recruitment or to a buy-in, the structure is
intended to sit outside pyramid-scheme statutes: there is no reward for
enrolling participants, only a referral share of genuine transactions those
participants complete. The touchstones a reviewer would apply are the FTC's
recruitment-versus-retail-sales line (the Koscot standard, as applied in FTC v.
BurnLounge), plus any state endless-chain / pyramid statute in the governing
jurisdiction; those authorities are named for counsel to apply, not asserted as
a conclusion here.

**Questions for counsel.**
1. Does the earnings-only payout (zero for recruiting a non-dealer, no buy-in,
   no recruitment bounty) keep the multi-level referral clear of federal and
   state pyramid/endless-chain statutes in the chosen jurisdiction?
2. What specific **terms language** would best reinforce this, for example an
   explicit recital that no fee is ever paid for recruitment, that participation
   requires no purchase or fee, and that every accrual traces to a confirmed
   third-party transaction? Draft or bless the recital.

**Sources.** The mechanics counsel should check against the statutes are in
`lib/referrals.ts` (the accrual predicate, `earningEventsFor`, and the house
floor) and `/terms` section 08. The source research for this section covered
non-circumvention/leakage economics rather than pyramid case law, so the
pyramid authorities (Koscot, BurnLounge, state endless-chain statutes) are for
counsel to supply and apply.

---

## 5. Pseudonymity vs. KYC / BSA tension

The platform stores no legal identity (section 1). The research is explicit that
if the platform ever **became** a money transmitter, its no-PII model would
conflict with BSA customer identification, monitoring, and Travel Rule duties.
The design avoids that conflict by never becoming a transmitter: in every tier
where real identity and KYC/KYB are required (F3 licensed escrow, the Bridge
on-ramp, or the Stripe Connect path in `docs/PAYMENTS.md`), the compliance
obligation lives with the **vendor** (Escrow.com, Bridge, Stripe), which
onboards and identifies the parties directly. The platform stores at most an
opaque account id (for example `acct_...` for Stripe), keyed to a pseudonymous
user id, and does not receive the legal identity through the integration.

**Design position.** The no-PII model is compatible with each settlement tier
because KYC/KYB is discharged by whichever regulated party actually touches the
money, not by the platform. The platform remains pseudonymous end to end; the
vendor knows the parties, the platform does not.

**Questions for counsel.**
1. Confirm the platform's no-PII, no-KYC model is compatible with the chosen
   settlement tier's compliance obligations, that is, that KYB/KYC sitting
   entirely with the F3 vendor (or Stripe) leaves the platform with no
   independent BSA/AML identification or recordkeeping duty.
2. Is there any tier or fact pattern (for example, the platform instructing the
   escrow agent to pay the 2.5% referral, or holding per-user vendor account
   ids) that would pull a KYC or recordkeeping obligation back onto the
   platform?

**Sources.**
- FinCEN 2019 CVC guidance (BSA identification/monitoring/Travel Rule tie to
  transmitter status):
  https://www.fincen.gov/sites/default/files/2019-05/FinCEN%20Guidance%20CVC%20FINAL%20508.pdf
- Vendor KYB references: Bridge business KYB
  https://apidocs.bridge.xyz/platform/customers/compliance/businesses/overview ;
  Escrow.com all-parties verification above $3,000 (see fee/licenses links in
  section 2). Repo: `db/schema.sql` (the complete stored-columns list),
  `app/privacy/page.tsx`, `docs/PAYMENTS.md`.

---

## 6. Data-brokering and the nature of the goods

The deals are for datasets sold to AI labs. Two distinct data-law questions
arise, and the platform sits differently in each.

- **The platform never sees the data.** The dataset handoff is Tier A
  commit-encrypt-pay-reveal (`lib/exchange.ts`): the seller encrypts client-side
  under a per-deal key, the server stores only Merkle roots and a key
  commitment (hashes), and the key and plaintext never reach the server.
  Messages are E2EE. So whatever the underlying data is, the platform is not a
  recipient, processor, or reseller of it.
- **The underlying data may itself carry obligations.** Datasets sold to AI
  labs can implicate dataset-licensing / IP rights, and privacy law if the data
  contains personal information. `/terms` section 03 already prohibits offering
  or brokering data the poster lacks the right to license (personal data
  collected without a basis to resell, other parties' proprietary data, anything
  gathered in breach of its collection terms). That is a contractual push-down
  to the seller, not platform diligence.

**Design position.** Hosting a marketplace for data, while never holding,
seeing, or transmitting the data (E2EE handoff, no plaintext on the server),
should not by itself make the platform a "data broker" within the registration
statutes, because the platform does not collect, sell, or license personal
information; the parties do, off-platform. The registration laws to check are
California (data broker registration under the Delete Act), Vermont (Act 171,
9 V.S.A. ch. 62), and Texas (SB 2105 data broker law); these are named for
counsel, not concluded here.

**Question for counsel.** Does operating this marketplace, given that the
platform never sees or transmits the underlying data and stores no PII, create
data-broker **registration** obligations (California / Vermont / Texas or
elsewhere in the chosen jurisdiction)? Separately, flag whether the terms should
carry more than the current seller-side prohibition to allocate the dataset-
licensing / IP / underlying-data-privacy risk cleanly to the parties.

**Sources.**
- `lib/exchange.ts` and `docs/EXCHANGE.md` (the E2EE, no-plaintext-on-server
  handoff), `app/terms/page.tsx` section 03 (the data-rights prohibition),
  `app/privacy/page.tsx` (no PII stored). The data-broker registration statutes
  (CA Delete Act / Civil Code, Vermont 9 V.S.A. ch. 62, Texas Bus. & Com. Code
  ch. 509) are for counsel to pull and apply; the source research did not carry
  those URLs.

---

## 7. Disclaimer, jurisdiction placeholder, and reading list

**No legal advice; this is a design memo.** This document is an assembly of the
platform's own design positions and the operator's background research, written
so a lawyer can review a built system quickly. It is not legal advice, contains
no legal conclusions by the operator, and should not be relied on as either.
Every "position" stated above is a claim to be confirmed or corrected by
counsel, not an assertion of law. Where a section names a statute or case, it is
a pointer for the reviewer, not a representation that it applies or that the
platform complies.

**Jurisdiction: [SET BEFORE LAUNCH].** The governing law and forum are unset.
`/terms` section 07 shows the blank in the live product rather than papering
over it: "These terms are governed by the law of [set before launch:
jurisdiction]." Several answers above (money-transmitter licensing, pyramid/
endless-chain statutes, success-fee intermediation licensing, data-broker
registration) depend on this choice. It must be fixed before launch and the
sections above re-read against it.

**Documents a reviewer should open, in order:**

1. Live product: https://getdataboard.vercel.app
2. Public repository: https://github.com/nathanjzhao/databoard
3. Terms of use, referral fee is section 08, "what it is not" is section 01,
   liability is section 05, governing-law blank is section 07:
   `app/terms/page.tsx` (live at /terms)
4. Privacy policy, the no-PII / schema-is-the-policy model:
   `app/privacy/page.tsx` (live at /privacy)
5. Verification and the tier vocabulary, "The line we do not cross" is section
   06: `app/transparency/verification/page.tsx` (live at
   /transparency/verification)
6. Referral fee engine (the geometric fee, house floor, standing gate,
   disputes, timely-recording credit): `lib/referrals.ts`
7. Dataset exchange and WireCreditClaim (no custody, E2EE handoff):
   `lib/exchange.ts`; verifiable-proof seam: `lib/payproof.ts`
8. Payment / settlement / exchange blueprints (the three tiers, the FinCEN
   posture, Escrow.com and Bridge): `docs/PAYMENTS.md`, `docs/SETTLEMENT.md`,
   `docs/EXCHANGE.md`
9. The stored-columns authority (what any lawful request could compel):
   `db/schema.sql` (rendered at /transparency)
</content>
</invoke>
