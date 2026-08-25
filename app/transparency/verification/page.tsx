/**
 * /transparency/verification
 *
 * The verification story for the deals ledger and the ask board, publicly
 * reachable like /transparency (lib/gate.ts serves the /transparency/ prefix
 * without a session). One page, one job: state exactly how much a tier or a
 * mark proves, which is less than anyone wants, and document the rungs above
 * as research rather than dressing them up as features. Every mechanism
 * named here is either running, or labeled planned with its real maturity
 * and its real limits.
 */

import type { Metadata } from "next";
import Link from "next/link";
import { TSection } from "@/components/transparency/section";
import { FullLadder } from "@/components/verification/full-ladder";
import { MitigationsTable } from "@/components/verification/mitigations";
import {
  MechanismList,
  PAYMENT_MECHANISMS,
  PROOF_MECHANISMS,
} from "@/components/verification/mechanisms";
import { VocabTable } from "@/components/verification/vocab";

export const metadata: Metadata = {
  title: "Verification",
  description:
    "How we know a deal is real, rung by rung: what is running, what is planned, and what cannot work at all.",
};

const CONTENTS = [
  ["01", "ladder", "The ladder"],
  ["02", "co-attested", "Co-attested"],
  ["03", "evidence", "Evidence committed"],
  ["04", "asks", "The ask rungs"],
  ["05", "payment", "Payment rails"],
  ["06", "proofs", "Cryptographic proofs"],
  ["07", "token", "The buyer token problem"],
  ["08", "words", "The words"],
] as const;

/** Why each planned mechanism cannot, on its own, bind a hidden payer to our token. */
const TOKEN_GAPS: ReadonlyArray<readonly [string, string]> = [
  [
    "co-attestation",
    "both parties can sign the token, which proves nothing about which legal entity actually paid",
  ],
  [
    "bank APIs (Plaid, Stripe, Mercury, Ramp)",
    "they reveal payer fields to whoever consumes the API, which would be us; keeping us blind needs an attested verifier in the middle",
  ],
  [
    "zkTLS",
    "can authenticate and commit to hidden payer bytes, but proving that commitment equals HMAC(pepper, payer) is a computation over a secret split between two parties; neither side holds both inputs",
  ],
  [
    "ZK Email",
    "the most circuit-composable of the lot, and the prover still does not hold the pepper",
  ],
  [
    "escrow KYB",
    "establishes the legal entity to the escrow agent, with no documented way to attest privately into our token",
  ],
  [
    "the VOPRF we now run (RFC 9497)",
    "keeps the name off the wire and proves one key answers everyone, but does not bind a payer to the token, and the key holder can still enumerate the small dictionary of plausible lab names",
  ],
];

export default function VerificationPage() {
  return (
    <div className="mx-auto w-full max-w-[880px] px-5 py-14">
      <div className="bt-label">
        <Link href="/transparency" className="hover:text-ink">
          Transparency
        </Link>{" "}
        · Verification
      </div>
      <h1 className="bt-display mt-3 text-[2.5rem] leading-[1.05] text-ink">
        A deal here is a claim, not a fact.
      </h1>
      <p className="mt-4 max-w-[64ch] text-[0.9375rem] leading-relaxed text-ink-dim">
        The ledger records what accounts say happened. This page is the exact
        ladder from &quot;one account says so&quot; to things that could
        actually be proved: which rungs run today, which are research we have
        not shipped, and one that cannot work at all without new
        infrastructure. Where a mechanism has a hole, the hole is printed next
        to it.
      </p>

      <nav className="mt-8 flex gap-x-6 gap-y-2 overflow-x-auto border-y border-rule py-3">
        {CONTENTS.map(([num, id, label]) => (
          <a
            key={id}
            href={`#${id}`}
            className="group flex shrink-0 items-baseline gap-2 text-[0.8125rem] text-ink-dim transition-colors hover:text-ink"
          >
            <span className="bt-token">{num}</span>
            <span>{label}</span>
          </a>
        ))}
      </nav>

      <div className="mt-10 space-y-14">
        <TSection
          id="ladder"
          num="01"
          title="The ladder"
          lede="Six rungs, three running. The built rungs are named carefully, because the strongest thing two pseudonymous accounts can do today is agree with each other and commit hashes. The rest is payment-rail and cryptographic evidence, documented below as planned so nobody has to guess what a tier name is worth."
        >
          <FullLadder />

          <div className="mt-6 space-y-4">
            <div className="border border-rule bg-panel px-5 py-4">
              <div className="bt-label">Rung 0, spelled out</div>
              <p className="mt-2 max-w-[62ch] text-[0.8438rem] leading-relaxed text-ink-dim">
                Claimed means one account typed it in. A claimed deal surfaces
                nowhere publicly, with a single labeled exception: the
                reporter&apos;s own self value on the leaderboard, marked
                claimed-tier. Solo deals, where nobody else is named, stay on
                this rung forever; a hash committed by the same person who made
                the claim is still a unilateral claim, and the deal page says
                so rather than lighting a rung it did not earn.
              </p>
            </div>

            <div className="border-l-2 border-amber bg-amber-wash px-4 py-3.5">
              <div className="bt-label text-amber">
                The bar for &quot;verified&quot;
              </div>
              <p className="mt-2 font-mono text-[0.75rem] leading-relaxed text-ink-dim">
                verified deal = independent posted or released payment evidence
                + payer bound to the buyer token + buyer-signed dataset
                commitment + no observed reversal
              </p>
              <p className="mt-2 max-w-[62ch] text-[0.8438rem] leading-relaxed text-ink-dim">
                No deal on this board clears that bar today, so the product
                never uses the word as a status; its only appearance is inside
                the negation &quot;not yet independently verified&quot;. Even a
                deal that someday clears
                it will have proved that money moved as described, and nothing
                else: not that the dataset was lawful or valuable, not that the
                transaction was economically independent.
              </p>
            </div>
          </div>
        </TSection>

        <TSection
          id="co-attested"
          num="02"
          title="Rung 1: co-attested"
          lede="Every non-declined named participant confirmed their own share, from their own login, at least one of them. That is agreement between pseudonymous accounts. It is deliberately not called verification, and the interface never calls it that."
        >
          <p className="max-w-[64ch] text-[0.875rem] leading-relaxed text-ink-dim">
            Co-attestation raises the price of a lie from one account to
            several. Here is what it cannot rule out: one person running every
            account on the deal (Sybil accounts are cheap, and resisting them
            fundamentally requires an identity or resource assumption we do
            not impose; Douceur made this point in 2002 and nobody has
            unmade it), real counterparties inventing a deal that never
            happened, rings of accounts confirming each other, one deal split
            into several for the optics, totals inflated on the way in. Even
            real payment evidence, once we have it, proves money moved; it
            does not prove a deal was real, independent, or lawful.
          </p>
          <p className="mt-3 max-w-[64ch] text-[0.875rem] leading-relaxed text-ink-dim">
            The pattern has prior art, none of it magic. eBay binds feedback
            to platform transactions and counts a repeated counterparty once a
            week; Airbnb holds both reviews blind until the second lands;
            OpenBazaar bound signed trade records to funded multisigs; EAS
            ships attestation plumbing and says plainly that it does not
            establish truth. All of it raises the cost of a fake. None of it
            makes fakes impossible, and neither do we.
          </p>

          <div className="mt-6">
            <MitigationsTable />
          </div>

          <p className="mt-3 max-w-[64ch] text-[0.8125rem] leading-relaxed text-ink-faint">
            One mitigation we considered and rejected: refundable stakes. A
            bond with no objective challenge and adjudication rule is theater,
            because colluding parties simply collect their own bonds back.
            Stakes earn their keep only on claims that can be randomly audited
            or objectively disputed, which these cannot be, yet.
          </p>
        </TSection>

        <TSection
          id="evidence"
          num="03"
          title="Rung 2: evidence committed"
          lede="On top of co-attestation, the reporter and every confirmed participant each committed a SHA-256 hash of an official document: a bank statement line, a signed receipt email. Committed, not uploaded. The file is hashed in the participant's own browser and never crosses the wire; the database holds 64 hex characters and a short label."
        >
          <ol className="border border-rule bg-panel">
            {(
              [
                [
                  "1",
                  "Commit now.",
                  "The participant picks the document on their own machine; the browser computes its SHA-256 with WebCrypto and sends only the hash and a label. Nothing else leaves the machine. The server could not read the document if it wanted to, because the document never arrives.",
                ],
                [
                  "2",
                  "Reveal later, off-platform, if it ever matters.",
                  "A counterparty, an auditor, or a court asks to see the evidence. The participant shows them the original document directly, through whatever channel they choose. The platform is not in this step.",
                ],
                [
                  "3",
                  "Anyone can check the match.",
                  "The verifier hashes the document themselves and compares against the commitment on file. A match proves these exact bytes existed no later than the commitment's timestamp and have not been altered since. That is the entire claim.",
                ],
              ] as const
            ).map(([n, head, body]) => (
              <li
                key={n}
                className="grid grid-cols-[2.5rem_minmax(0,1fr)] gap-x-2 border-b border-rule px-4 py-4 last:border-b-0"
              >
                <span className="bt-token pt-0.5">{n}</span>
                <div>
                  <div className="text-[0.875rem] font-medium text-ink">
                    {head}
                  </div>
                  <p className="mt-1 text-[0.8125rem] leading-relaxed text-ink-dim">
                    {body}
                  </p>
                </div>
              </li>
            ))}
          </ol>

          <div className="mt-6 border-l-2 border-red bg-red-wash px-4 py-3.5">
            <div className="bt-label text-red">
              What a commitment does not prove
            </div>
            <p className="mt-2 max-w-[62ch] text-[0.8438rem] leading-relaxed text-ink-dim">
              The platform never reads the document, so the commitment does
              not prove the document is genuine, that its contents match the
              deal row, or that money moved. A participant can hash any file
              they like; an unrevealed commitment is a sealed envelope that
              proves only that the envelope was sealed on a date. This is why
              the tier reads &quot;evidence committed, not yet independently
              verified&quot; everywhere it appears.
            </p>
            <p className="mt-2 max-w-[62ch] text-[0.8438rem] leading-relaxed text-ink-dim">
              Why not just upload the document? Because a stored bank
              statement is a stored liability: real names, account numbers,
              counterparties, exactly the list the rest of the schema exists
              to refuse. The commitment gets most of the audit value with none
              of the custody.
            </p>
          </div>
        </TSection>

        <TSection
          id="asks"
          num="04"
          title="The ask rungs"
          lede="Asks get a shorter ladder than deals: claimed, and mandate committed. An ask is claimed the moment a poster types it. Mandate committed means the poster also pinned the ask to one document, the RFP, MSA or buyer email thread behind it, by committing its SHA-256, hashed in their own browser, write-once, with the commitment date printed next to the posting date."
        >
          <p className="max-w-[64ch] text-[0.875rem] leading-relaxed text-ink-dim">
            What a mandate commitment proves: consistency, and ex-post
            provability. The poster is pinned to one document before anyone
            engages (or visibly after; a late pin carries its own date), and
            a counterparty later shown a document that does not hash to the
            commitment has receipts. What it does not prove: authenticity or
            authority. The poster can hash any file they like, and a genuine
            RFP does not make the person holding it entitled to buy on its
            terms. This is why the mark reads &quot;mandate committed&quot;
            and never &quot;verified&quot;, on the board, on the ask page,
            and here.
          </p>
          <p className="mt-3 max-w-[64ch] text-[0.875rem] leading-relaxed text-ink-dim">
            Two smaller records ride on asks, both stated rather than proved.
            Exclusivity terms (exclusive or non-exclusive) are the
            poster&apos;s own statement of whether supply sold into the ask
            can be resold elsewhere; the board displays the word and enforces
            nothing behind it. And every ask runs on an activity clock: an
            open ask nobody affirms for 7 days closes automatically, with the
            reason recorded and shown on the ask page, so &quot;open&quot;
            means the poster recently said so, not that anyone checked.
          </p>
          <p className="mt-3 max-w-[64ch] text-[0.875rem] leading-relaxed text-ink-dim">
            Two stronger rungs are planned, not shipped, because each has a
            hole we will not paper over. DKIM-proved artifacts: an email
            carries its sending domain&apos;s signature, and checking it
            could prove a mandate email really transited the buyer&apos;s
            mail servers, but any employee of that domain can send a signed
            email, so it would prove provenance, not purchasing authority.
            Buyer co-attestation: an account of the buyer&apos;s
            counter-signing the mandate would outrank a self-committed hash,
            but until buyer accounts are bound to a legal entity, that
            signature is another envelope the poster could have sealed
            themselves, because pseudonymous accounts are cheap to mint.
            Both stay in this section, as plans with their holes printed,
            until they exist.
          </p>
        </TSection>

        <TSection
          id="payment"
          num="05"
          title="Planned: payment rails"
          lede="The next rung up is money: independent evidence that funds posted or were released, bound to one specific deal. Nothing in this section is built. Time estimates are engineering guesses that exclude vendor approval, security audits, and legal review, which is where such estimates usually go to die."
        >
          <MechanismList items={PAYMENT_MECHANISMS} />

          <div className="mt-6 border-l-2 border-red bg-red-wash px-4 py-3.5">
            <div className="bt-label text-red">The line we do not cross</div>
            <p className="mt-2 max-w-[62ch] text-[0.8438rem] leading-relaxed text-ink-dim">
              The platform will never hold deal funds, fiat or stablecoin.
              FinCEN has treated &quot;hold the money until the buyer clicks
              release&quot; as money transmission, a licensed business we are
              not in; a genuine escrow that administers delivery, inspection
              and refund conditions can fall outside that line, and that is
              exactly the licensed third party the escrow rung names. If a
              payment ever earns a rung here, it is because a bank, a payment
              processor, or a licensed escrow agent reported it, not because
              it passed through an account of ours.
            </p>
          </div>
        </TSection>

        <TSection
          id="proofs"
          num="06"
          title="Planned: cryptographic proofs"
          lede="Cryptography can move parts of this from trust-the-platform to check-the-math. The tooling is real and moving quickly, and much of it is not production-grade; the maturity chips below repeat what the projects say about themselves, not what their landing pages imply."
        >
          <MechanismList items={PROOF_MECHANISMS} />
        </TSection>

        <TSection
          id="token"
          num="07"
          title="The buyer token problem"
          lede="The honest negative result, and the reason a payer-bound rung is future work rather than a sprint. None of the mechanisms above can produce our buyer token from a hidden payer on its own."
        >
          <p className="max-w-[64ch] text-[0.875rem] leading-relaxed text-ink-dim">
            The buyer token is the output of a verifiable OPRF (RFC 9497):
            your browser blinds the lab name before sending, the server
            evaluates a point it cannot read, and a DLEQ proof lets your
            client check that the same server key answers everyone, so the
            server never receives a name and cannot selectively break or
            forge matches without your own client catching it. Against a
            database dump the token is a blind: no key, no name. Against the
            operator it is a pseudonym, not a secret, because the set of
            plausible AI labs is small enough for the key-holder to evaluate
            offline; the schema and the main transparency page already say
            this. The new problem a payer-bound rung adds is harder: someone
            must prove that the entity that actually paid maps to the token
            on the deal, without telling us the entity. Every mechanism on
            this page fails that in its own way.
          </p>

          <div className="mt-5 border border-rule bg-panel">
            <ul className="divide-y divide-rule">
              {TOKEN_GAPS.map(([mech, gap]) => (
                <li
                  key={mech}
                  className="grid grid-cols-1 gap-x-6 gap-y-1 px-4 py-3 sm:grid-cols-[minmax(0,14rem)_minmax(0,1fr)]"
                >
                  <span className="font-mono text-[0.75rem] text-ink">
                    {mech}
                  </span>
                  <span className="text-[0.8125rem] leading-relaxed text-ink-dim">
                    {gap}
                  </span>
                </li>
              ))}
            </ul>
          </div>

          <p className="mt-5 max-w-[64ch] text-[0.875rem] leading-relaxed text-ink-dim">
            Two designs would actually close the gap. Both are future work,
            and neither is small.
          </p>

          <div className="mt-4 grid gap-4 md:grid-cols-2">
            <div className="border border-rule bg-panel px-5 py-4">
              <div className="flex items-baseline justify-between gap-3">
                <span className="text-[0.875rem] font-medium text-ink">
                  Attested verifier
                </span>
                <span className="inline-block border border-rule-strong bg-panel-2 px-1.5 py-0.5 font-mono text-[0.5625rem] uppercase tracking-[0.12em] text-ink-faint">
                  bridge · future work
                </span>
              </div>
              <p className="mt-2 text-[0.8125rem] leading-relaxed text-ink-dim">
                The pepper lives only inside a measured enclave (AWS Nitro
                attestation; the KMS releases the key exclusively to the
                approved code measurement). The enclave accepts authentic
                transaction evidence, never arbitrary name-to-token queries,
                and emits a signed minimal receipt: deal id, token, amount
                band, settled-at. Trust moves to the cloud vendor and the
                measurement, which is a real cost and an honest one.
              </p>
            </div>
            <div className="border border-rule bg-panel px-5 py-4">
              <div className="flex items-baseline justify-between gap-3">
                <span className="text-[0.875rem] font-medium text-ink">
                  Token redesign
                </span>
                <span className="inline-block border border-rule-strong bg-panel-2 px-1.5 py-0.5 font-mono text-[0.5625rem] uppercase tracking-[0.12em] text-ink-faint">
                  long term · future work
                </span>
              </div>
              <p className="mt-2 text-[0.8125rem] leading-relaxed text-ink-dim">
                The buyer token becomes a random 256-bit pseudonym instead of
                a keyed name, and an independent KYB issuer certifies exactly
                one token per legal entity. Later proofs compare the hidden
                payer against that credential and reveal only the token. This
                kills dictionary enumeration outright, adds an issuer to
                trust, and forces versioned normalization, because a lab, its
                treasury affiliate, and its AP processor are three different
                strings on a wire.
              </p>
            </div>
          </div>
        </TSection>

        <TSection
          id="words"
          num="08"
          title="The words"
          lede="One vocabulary, used identically on the deal pages, the leaderboard, and here, so that a tier name is a commitment you can hold us to rather than a mood."
        >
          <VocabTable />
          <p className="mt-4 max-w-[64ch] text-[0.8125rem] leading-relaxed text-ink-faint">
            Internally, each planned evidence state is a separate flag on the
            deal, not a blended score:{" "}
            <span className="font-mono text-[0.6875rem]">
              payment_received, payer_bound_to_buyer_token,
              dataset_commitment_accepted, escrow_released,
              reversal_checked_at
            </span>
            . The leaderboard will report which of them a deal earned rather
            than collapsing them into one reassuring word.
          </p>
          <p className="mt-4 text-[0.8125rem] leading-relaxed text-ink-faint">
            Back to{" "}
            <Link href="/transparency" className="text-blue hover:text-amber">
              the schema
            </Link>
            , or to{" "}
            <Link href="/gate" className="text-blue hover:text-amber">
              the gate
            </Link>
            .
          </p>
        </TSection>
      </div>
    </div>
  );
}
