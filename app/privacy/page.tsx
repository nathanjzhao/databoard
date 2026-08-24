/**
 * /privacy
 *
 * The privacy policy. Publicly reachable (allowlisted in middleware.ts) like
 * /transparency, whose page this one leans on instead of restating: the
 * schema is published there verbatim, so this page can say "stored" and mean
 * "in that file" rather than "trust us". Reuses the transparency section
 * shell; document page, not a new design surface.
 *
 * OPERATOR NOTE (Nathan): this page is a draft, not legal advice. Review it
 * with counsel before real launch; depending on where users are, GDPR/CCPA
 * style disclosures may need to be layered on. The same note is embedded as
 * an HTML comment in the served markup below.
 */

import type { Metadata } from "next";
import Link from "next/link";
import { TSection } from "@/components/transparency/section";

export const metadata: Metadata = {
  title: "Privacy",
  description:
    "Exactly what is stored, what passes through and is discarded, who else sees anything, and what a lawful request can obtain.",
};

const CONTENTS = [
  ["01", "stored", "What is stored"],
  ["02", "transient", "Processed, then discarded"],
  ["03", "processors", "Providers and infrastructure"],
  ["04", "tracking", "No tracking"],
  ["05", "requests", "Lawful requests"],
  ["06", "retention", "Retention and deletion"],
  ["07", "changes", "Changes"],
] as const;

/** Everything the database holds, by row kind. The schema is the authority. */
const STORED: ReadonlyArray<readonly [string, string]> = [
  [
    "your account",
    "four fields: a chosen username, an scrypt password hash, a one-bit org-or-individual flag, and a one-way keyed blind index of your contact that exists only to enforce one account per contact; no email, phone, name, employer, IP, or device columns exist",
  ],
  [
    "buyer tokens",
    "blinded VOPRF outputs minted in your browser; the buyer's name never reaches the server in any form",
  ],
  [
    "messages",
    "in encrypted threads, ciphertext sealed in the sender's browser plus per-participant wrapped keys the server cannot open; plaintext threads predate encryption and are labeled in the UI",
  ],
  [
    "what you write",
    "ask titles and descriptions, notes, deal amounts and splits, evidence hashes: free text and figures you chose to post, stored as posted",
  ],
  [
    "sessions",
    "the SHA-256 of the cookie token and two expiry timestamps; no IP, no user agent",
  ],
  [
    "rate limits",
    "request counters keyed by HMAC buckets; never a raw IP, contact, or handle",
  ],
];

export default function PrivacyPage() {
  return (
    <div className="mx-auto w-full max-w-[880px] px-5 py-14">
      {/* A real HTML comment in the served page, invisible to readers. */}
      <div
        hidden
        aria-hidden="true"
        dangerouslySetInnerHTML={{
          __html:
            "<!-- Operator note: draft, not legal advice. Review with counsel before real launch. -->",
        }}
      />

      <div className="bt-label">Privacy</div>
      <h1 className="bt-display mt-3 text-[2.5rem] leading-[1.05] text-ink">
        The schema is the policy.
      </h1>
      <p className="mt-4 max-w-[64ch] text-[0.9375rem] leading-relaxed text-ink-dim">
        Most privacy policies describe intentions. This one can point at the
        database: every column that exists is published verbatim at{" "}
        <Link href="/transparency" className="text-blue hover:text-amber">
          /transparency
        </Link>
        , and nothing else is stored. What follows is that page restated as
        policy, plus the few things that pass through without being stored
        and the few third parties that exist.
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
          id="stored"
          num="01"
          title="What is stored"
          lede="The complete list, by row kind. The authoritative version is db/schema.sql, rendered with its comments at /transparency and served as plain text at /api/transparency/schema; if this summary and that file ever disagree, the file wins."
        >
          <div className="border border-rule bg-panel">
            <ul className="divide-y divide-rule">
              {STORED.map(([what, detail]) => (
                <li
                  key={what}
                  className="grid grid-cols-1 gap-x-6 gap-y-1 px-4 py-3 sm:grid-cols-[minmax(0,10rem)_minmax(0,1fr)]"
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
          <p className="mt-3 max-w-[64ch] text-[0.8125rem] leading-relaxed text-ink-faint">
            The blind index is one-way but not amnesia, and free text you post
            can identify you if you let it. Both caveats are stated in full at{" "}
            <Link
              href="/transparency#attestation"
              className="text-blue hover:text-amber"
            >
              /transparency
            </Link>{" "}
            rather than softened here.
          </p>
        </TSection>

        <TSection
          id="transient"
          num="02"
          title="Processed, then discarded"
          lede="Signup verification handles real identifying information exactly once, and stores none of it."
        >
          <div className="border border-rule bg-panel px-5 py-4">
            <p className="max-w-[64ch] text-[0.875rem] leading-relaxed text-ink-dim">
              During attestation the server receives your contact, real name,
              and affiliation, folds them into a keyed HMAC challenge, and
              hands the challenge back to your browser without writing
              anything down. When you return them with the code, the server
              recomputes the HMAC, compares, keeps two residues (the
              org-or-individual bit and the contact blind index) and discards
              the rest. Contact, name, and affiliation exist in server memory
              for the duration of two requests, are never logged, and have no
              column to land in.{" "}
              <Link
                href="/transparency#attestation"
                className="text-blue hover:text-amber"
              >
                /transparency
              </Link>{" "}
              section 03 walks the mechanism step by step.
            </p>
          </div>
        </TSection>

        <TSection
          id="processors"
          num="03"
          title="Providers and infrastructure"
          lede="The third parties, all of them. There are no analytics vendors, ad networks, or data brokers in this list because none are used."
        >
          <div className="border border-rule bg-panel">
            <ul className="divide-y divide-rule">
              <li className="grid grid-cols-1 gap-x-6 gap-y-1 px-4 py-3 sm:grid-cols-[minmax(0,10rem)_minmax(0,1fr)]">
                <span className="font-mono text-[0.75rem] text-ink">
                  code delivery
                </span>
                <span className="text-[0.8125rem] leading-relaxed text-ink-dim">
                  in demo mode (the default) no code is sent anywhere and no
                  provider sees anything. When live delivery is on, sending
                  the one-time code requires a provider that necessarily sees
                  your contact and the code in transit: Resend for email,
                  Twilio for SMS. They act as processors for that single
                  message, under their own retention policies. This is the
                  only moment any third party sees a contact, and it is not
                  stored on our side either way.
                </span>
              </li>
              <li className="grid grid-cols-1 gap-x-6 gap-y-1 px-4 py-3 sm:grid-cols-[minmax(0,10rem)_minmax(0,1fr)]">
                <span className="font-mono text-[0.75rem] text-ink">
                  hosting
                </span>
                <span className="text-[0.8125rem] leading-relaxed text-ink-dim">
                  the app runs on Vercel and the database on Turso. They move
                  and hold the bytes the schema describes and keep their own
                  operational logs at their layer, under their own policies.
                  Nothing in the application writes logs containing contacts,
                  names, message text, or codes.
                </span>
              </li>
            </ul>
          </div>
        </TSection>

        <TSection
          id="tracking"
          num="04"
          title="No tracking"
          lede="Nothing to configure, because nothing is there."
        >
          <p className="max-w-[64ch] text-[0.875rem] leading-relaxed text-ink-dim">
            No analytics scripts, no third-party trackers, no ad pixels, no
            fingerprinting, no marketing email (no email is known to send it
            to). One cookie exists: the httpOnly session cookie that keeps
            you signed in. Sessions store no IP address and no user agent, so
            there is no access log keyed to accounts to hand over, sell, or
            leak.
          </p>
        </TSection>

        <TSection
          id="requests"
          num="05"
          title="Lawful requests"
          lede="The honest line: the operator complies with valid legal process, and can only hand over what exists. What exists is the schema."
        >
          <div className="border-l-2 border-amber bg-amber-wash px-4 py-3.5">
            <p className="max-w-[62ch] text-[0.8438rem] leading-relaxed text-ink-dim">
              A complete production dump contains usernames, password hashes,
              blinded tokens, ciphertext bodies plus the plaintext of
              unencrypted threads, the free text and deal figures members
              posted, timestamps, and who-talks-to-whom metadata. It does not
              contain phone numbers, email addresses, real names, buyer
              names, or the text of encrypted messages, because no column
              holds them and no key on the server opens them. A request can
              compel what exists; the schema is the list of what exists.
              This is a design property you can audit at{" "}
              <Link
                href="/transparency"
                className="text-blue hover:text-amber"
              >
                /transparency
              </Link>
              , not a promise to resist anything.
            </p>
          </div>
          <p className="mt-3 max-w-[64ch] text-[0.8125rem] leading-relaxed text-ink-faint">
            The residual boundary, stated there too: an operator holding the
            server keys can test a specific already-known contact for
            membership and can enumerate the short list of plausible buyer
            names offline. Neither works backward from the database alone.
          </p>
        </TSection>

        <TSection
          id="retention"
          num="06"
          title="Retention and deletion"
          lede="What expires on its own, and what does not."
        >
          <p className="max-w-[64ch] text-[0.875rem] leading-relaxed text-ink-dim">
            Sessions expire and expired rows are removed. Rate-limit counters
            expire with their windows and are swept. Everything else, the
            account row and what you posted, persists until deleted. There is
            no self-serve account deletion yet; if it ships it will follow
            the deletion cascades already visible in the schema. Verification
            data has no retention period because it is never retained
            (section 02).
          </p>
        </TSection>

        <TSection
          id="changes"
          num="07"
          title="Changes"
          lede="Same rule as the terms: the history is public, because the repo is."
        >
          <p className="max-w-[64ch] text-[0.875rem] leading-relaxed text-ink-dim">
            The current policy lives at this URL and carries its date at the
            top. Every edit is a commit in the{" "}
            <a
              href="https://github.com/nathanjzhao/databoard"
              className="text-blue hover:text-amber"
            >
              public repository
            </a>
            , so what changed and when is always inspectable. A change that
            stored more than the schema stores today would be visible in the
            schema itself, which is the point of publishing it.
          </p>
          <p className="mt-4 text-[0.8125rem] leading-relaxed text-ink-faint">
            See also{" "}
            <Link href="/terms" className="text-blue hover:text-amber">
              /terms
            </Link>{" "}
            and{" "}
            <Link href="/transparency" className="text-blue hover:text-amber">
              /transparency
            </Link>
            .
          </p>
        </TSection>
      </div>
    </div>
  );
}
