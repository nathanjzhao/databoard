/**
 * /terms
 *
 * The terms of use. Publicly reachable (allowlisted in middleware.ts) for the
 * same reason /transparency is: you should be able to read the rules before
 * handing over anything. Reuses the transparency section shell; this is a
 * document page, not a new design surface.
 *
 * OPERATOR NOTE (Nathan): this page is a draft, not legal advice. Review it
 * with counsel and fill the [set before launch: jurisdiction] placeholder in
 * section 07 before real launch. The same note is embedded as an HTML comment
 * in the served markup below.
 */

import type { Metadata } from "next";
import Link from "next/link";
import { TSection } from "@/components/transparency/section";

export const metadata: Metadata = {
  title: "Terms",
  description:
    "What the service is and is not, the rules, moderation, and where liability ends. Short, because the service is small.",
};

const CONTENTS = [
  ["01", "service", "The service"],
  ["02", "accounts", "Accounts"],
  ["03", "use", "Acceptable use"],
  ["04", "moderation", "Moderation"],
  ["05", "liability", "Disclaimers and liability"],
  ["06", "changes", "Changes"],
  ["07", "law", "Governing law"],
  ["08", "referrals", "Referral fees"],
] as const;

/** What the service is not, one row each. */
const NOT_THE_SERVICE: ReadonlyArray<readonly [string, string]> = [
  [
    "an escrow",
    "we never hold deal funds, fiat or crypto, in any amount, for any duration",
  ],
  [
    "a payment processor",
    "no money moves through the platform; deals close off the platform, on rails you and your counterparty choose",
  ],
  [
    "a verifier of deals",
    "a deal on the ledger is a claim by accounts, graded exactly by the labeled tiers at /transparency/verification and never more than the tier says; no deal here is independently verified",
  ],
  [
    "a party to your transactions",
    "contracts, delivery, payment, and disputes are between you and your counterparty",
  ],
  ["advice", "nothing here is legal, financial, or tax advice"],
];

/** The prohibitions. Short names, concrete descriptions. */
const PROHIBITED: ReadonlyArray<readonly [string, string]> = [
  [
    "fraud",
    "no invented deals, inflated totals, ring confirmations, sock-puppet accounts, or misrepresenting what you have or who you act for",
  ],
  [
    "data you lack rights to sell",
    "do not offer, solicit, or broker data you have no legal right to license: personal data collected without a basis to resell it, other parties' proprietary data, anything gathered in breach of the terms it was gathered under",
  ],
  [
    "deanonymization",
    "no attempts to tie another handle to a person or organization: correlating their posts, probing the blind index, social engineering, or off-platform research aimed at unmasking them; do not post anyone's real name or contact details, your own included",
  ],
  [
    "scraping",
    "no crawling, bulk export, or automated collection of board content; the board is members-only on purpose",
  ],
  [
    "attacks on the service",
    "no probing the gate, evading rate limits, testing stolen credentials, or otherwise interfering with the service or other accounts",
  ],
  [
    "illegal use",
    "nothing that is unlawful where you are or where your counterparty is; a pseudonym is not a shield against the law, only against this database",
  ],
];

export default function TermsPage() {
  return (
    <div className="mx-auto w-full max-w-[880px] px-5 py-14">
      {/* A real HTML comment in the served page, invisible to readers. */}
      <div
        hidden
        aria-hidden="true"
        dangerouslySetInnerHTML={{
          __html:
            "<!-- Operator note: draft, not legal advice. Review with counsel and set the governing-law jurisdiction before real launch. -->",
        }}
      />

      <div className="bt-label">Terms</div>
      <h1 className="bt-display mt-3 text-[2.5rem] leading-[1.05] text-ink">
        The terms, in plain language.
      </h1>
      <p className="mt-4 max-w-[64ch] text-[0.9375rem] leading-relaxed text-ink-dim">
        DataBoard is operated by an individual, not a company with a legal
        department, and the terms are sized to match. Using the board means
        you accept them. The privacy side has its own page:{" "}
        <Link href="/privacy" className="text-blue hover:text-amber">
          /privacy
        </Link>
        .
      </p>
      <p className="mt-2 font-mono text-[0.6875rem] text-ink-faint">
        last updated 2026-08-24
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
          id="service"
          num="01"
          title="The service, and what it is not"
          lede="DataBoard is a members-only board where pseudonymous, vetted accounts post requests for datasets, find counterparties, and negotiate. That is the whole product. The list of things it is not matters more than the list of things it is."
        >
          <div className="border border-rule bg-panel">
            <ul className="divide-y divide-rule">
              {NOT_THE_SERVICE.map(([what, why]) => (
                <li
                  key={what}
                  className="grid grid-cols-1 gap-x-6 gap-y-1 px-4 py-3 sm:grid-cols-[minmax(0,12rem)_minmax(0,1fr)]"
                >
                  <span className="font-mono text-[0.75rem] text-ink">
                    not {what}
                  </span>
                  <span className="text-[0.8125rem] leading-relaxed text-ink-dim">
                    {why}
                  </span>
                </li>
              ))}
            </ul>
          </div>
          <p className="mt-3 max-w-[64ch] text-[0.8125rem] leading-relaxed text-ink-faint">
            The tier vocabulary the ledger uses, and how little each tier
            proves, is specified at{" "}
            <Link
              href="/transparency/verification"
              className="text-blue hover:text-amber"
            >
              /transparency/verification
            </Link>
            . Beyond those labels the platform verifies nothing about any
            deal.
          </p>
        </TSection>

        <TSection
          id="accounts"
          num="02"
          title="Accounts"
          lede="An account is a handle, a password, and one seat per contact. Everything below follows from the schema."
        >
          <div className="border border-rule bg-panel px-5 py-4">
            <ul className="max-w-[64ch] space-y-3 text-[0.875rem] leading-relaxed text-ink-dim">
              <li>
                You must be an adult acting in a business capacity. The board
                is matchmaking between parties who deal in data; it is not a
                consumer service.
              </li>
              <li>
                One account per contact. The contact&apos;s blind index is
                UNIQUE in the schema, so the phone number or email that opened
                an account cannot open another.
              </li>
              <li>
                The password is the account. No contact is stored, so no
                recovery exists: lose the password and the account, and that
                contact&apos;s one seat, are gone.{" "}
                <Link
                  href="/transparency#recovery"
                  className="text-blue hover:text-amber"
                >
                  /transparency
                </Link>{" "}
                section 04 explains why this is deliberate.
              </li>
              <li>
                You are responsible for everything done under your handle,
                including by anyone you gave the password to.
              </li>
            </ul>
          </div>
        </TSection>

        <TSection
          id="use"
          num="03"
          title="Acceptable use"
          lede="Six prohibitions. Breaking any of them is grounds for the moderation actions in section 04, and the parts that are crimes remain crimes."
        >
          <div className="border border-rule bg-panel">
            <ul className="divide-y divide-rule">
              {PROHIBITED.map(([what, detail]) => (
                <li
                  key={what}
                  className="grid grid-cols-1 gap-x-6 gap-y-1 px-4 py-3 sm:grid-cols-[minmax(0,12rem)_minmax(0,1fr)]"
                >
                  <span className="font-mono text-[0.75rem] text-ink">
                    {what}
                  </span>
                  <span className="text-[0.8125rem] leading-relaxed text-ink-dim">
                    {detail}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        </TSection>

        <TSection
          id="moderation"
          num="04"
          title="Moderation"
          lede="The operator may hide any content and ban any account, at discretion. The privacy design makes the consequences unusually final, so they are spelled out here rather than discovered later."
        >
          <div className="border-l-2 border-red bg-red-wash px-4 py-3.5">
            <div className="bt-label text-red">A ban burns the seat</div>
            <p className="mt-2 max-w-[62ch] text-[0.8438rem] leading-relaxed text-ink-dim">
              No contact is stored, so there is no way to warn you, hear an
              appeal, or restore access to someone who cannot prove they are
              the account holder. Enforcement looks like content disappearing
              or a login that stops working. A banned account is not restored,
              and the contact behind it does not get a new seat: the same
              one-contact-one-account rule that stops farming also makes a ban
              permanent. This is the same no-recovery trade the whole design
              makes, applied to moderation.
            </p>
          </div>
          <p className="mt-3 max-w-[64ch] text-[0.8125rem] leading-relaxed text-ink-faint">
            Moderation is used against the prohibitions in section 03 and
            against anything that endangers the board or its members. It is
            not a promise to police content: posts are not reviewed before
            they appear.
          </p>
        </TSection>

        <TSection
          id="liability"
          num="05"
          title="Disclaimers and liability"
          lede="Plain language, no capital letters pretending to be law."
        >
          <div className="border border-rule bg-panel px-5 py-4">
            <p className="max-w-[64ch] text-[0.875rem] leading-relaxed text-ink-dim">
              The service is provided as is and as available. No warranty that
              it stays up, that anything stored persists, that matches are
              good, that counterparties are honest, or that any claim on the
              board is true. You use it at your own risk, and you do your own
              diligence on anyone you deal with.
            </p>
            <p className="mt-3 max-w-[64ch] text-[0.875rem] leading-relaxed text-ink-dim">
              To the maximum extent the law allows, the operator is not liable
              for lost deals, lost profits, lost data, or anything a
              counterparty does to you. If a court finds liability anyway, it
              is capped at 100 US dollars or the amount you paid for the
              service in the past year, whichever is greater. The service has
              no fees today, so that number is 100 dollars.
            </p>
            <p className="mt-3 max-w-[64ch] text-[0.8125rem] leading-relaxed text-ink-faint">
              Some jurisdictions do not allow some of these limits; where one
              does not apply, it does not apply, and the rest stand.
            </p>
          </div>
        </TSection>

        <TSection
          id="changes"
          num="06"
          title="Changes"
          lede="Terms can change. The change history is public, because the repo is."
        >
          <p className="max-w-[64ch] text-[0.875rem] leading-relaxed text-ink-dim">
            The current terms live at this URL and carry their date at the
            top. Every edit is a commit in the{" "}
            <a
              href="https://github.com/nathanjzhao/databoard"
              className="text-blue hover:text-amber"
            >
              public repository
            </a>
            , so the diff between what you accepted and what stands now is
            always inspectable. Continued use after a change is acceptance of
            it.
          </p>
        </TSection>

        <TSection
          id="law"
          num="07"
          title="Governing law"
          lede="One blank remains, and it is marked rather than papered over."
        >
          <div className="border-l-2 border-amber bg-amber-wash px-4 py-3.5">
            <p className="max-w-[62ch] text-[0.8438rem] leading-relaxed text-ink-dim">
              These terms are governed by the law of{" "}
              <span className="bg-panel px-1 font-mono text-[0.75rem] text-amber">
                [set before launch: jurisdiction]
              </span>{" "}
              and disputes belong to its courts. Until that blank is filled
              this section is unfinished, and it is shown unfinished instead
              of pretending otherwise. The rest of the page stands on its own.
            </p>
          </div>
          <p className="mt-4 text-[0.8125rem] leading-relaxed text-ink-faint">
            See also{" "}
            <Link href="/privacy" className="text-blue hover:text-amber">
              /privacy
            </Link>{" "}
            and{" "}
            <Link href="/transparency" className="text-blue hover:text-amber">
              /transparency
            </Link>
            .
          </p>
        </TSection>

        <TSection
          id="referrals"
          num="08"
          title="Referral fees"
          lede="The board is invite-only, and joining through an invite carries a fee. It is stated here because it is a term of service, not a surprise on a ledger."
        >
          <div className="border border-rule bg-panel px-5 py-4">
            <ul className="max-w-[64ch] space-y-3 text-[0.875rem] leading-relaxed text-ink-dim">
              <li>
                By creating an account with an invite code you agree that every
                ancestor in your invite chain accrues a fee from your
                board-recorded earnings: 2.5% to your inviter, 2.5% of 2.5%
                (0.0625%) to theirs, and so on, capped at six steps.
              </li>
              <li>
                Earnings means your own confirmed shares on deals at
                co-attested tier or better. Solo claims, declined shares and
                pending shares accrue nothing.
              </li>
              <li>
                The platform computes and records these figures; it never
                holds or moves the money. You settle directly with each
                ancestor, off the platform, and either of you can record and
                confirm the settlement on the invites page.
              </li>
              <li>
                Falling more than 60 days behind gates posting new asks and
                recording new deals until you settle or dispute. Disputing is
                one click, lifts the gate, and puts the pair in front of an
                operator. That gate is the entire enforcement today; deduction
                at source is a planned upgrade and will be announced as a
                change under section 06 before it exists.
              </li>
            </ul>
          </div>
        </TSection>
      </div>
    </div>
  );
}
