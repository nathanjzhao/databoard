/**
 * /transparency
 *
 * Publicly reachable even though the board is gated: the privacy claims are
 * the pitch, so anyone may audit them before handing over anything.
 *
 * Load-bearing: the schema block renders db/schema.sql verbatim from the
 * generated module (the same bytes lib/db.ts applies at startup), and the
 * right rail reads the table and column list live out of the running
 * database. If those two ever disagree, the claim on this page is false and
 * you can see it. GET /api/transparency/schema serves the same bytes as
 * text/plain for terminal auditing.
 */

import type { Metadata } from "next";
import Link from "next/link";
import {
  isDbConfigured,
  listColumns,
  listTables,
  readSchemaSql,
} from "@/lib/db";
import { isUsingDevPepper, sha256Hex } from "@/lib/crypto";
import { getVoprfPublicKeyHex } from "@/app/api/voprf/server";
import { DEMO_MODE } from "@/lib/verify";
import { TSection } from "@/components/transparency/section";
import { SchemaBlock } from "@/components/transparency/schema-block";
import { VisibilityTable } from "@/components/transparency/visibility-table";
import { AuditIndex } from "@/components/transparency/audit-index";
import {
  LiveStatus,
  type TableColumns,
} from "@/components/transparency/live-status";

export const metadata: Metadata = {
  title: "Transparency",
  description:
    "The entire database schema, verbatim, plus what the operator can and cannot see and how to audit every claim.",
};
export const dynamic = "force-dynamic";

const PII_PATTERNS = [
  /phone/i,
  /email/i,
  /\bmail\b/i,
  /real_?name/i,
  /org_?name/i,
  /buyer_name/i,
  /lab_name/i,
];

const CONTENTS = [
  ["00", "verify", "Three layers"],
  ["01", "schema", "The schema"],
  ["02", "visibility", "Can and cannot see"],
  ["03", "attestation", "Stateless verification"],
  ["04", "recovery", "No recovery"],
  ["05", "audit", "Audit it yourself"],
  ["06", "log", "The append-only log"],
] as const;

export default async function TransparencyPage() {
  const schema = readSchemaSql();
  const schemaSha = sha256Hex(schema);

  let voprfPubKey: string | null = null;
  try {
    voprfPubKey = await getVoprfPublicKeyHex();
  } catch {
    // Rendered as unavailable below; /api/voprf/pubkey is the fallback.
  }

  const dbLive = isDbConfigured();
  let columns: TableColumns[] = [];
  if (dbLive) {
    const tables = await listTables();
    columns = await Promise.all(
      tables.map(async (t) => ({ table: t, columns: await listColumns(t) })),
    );
  }
  const offenders = columns.flatMap((t) =>
    t.columns
      .filter((c) => PII_PATTERNS.some((re) => re.test(c)))
      .map((c) => `${t.table}.${c}`),
  );

  return (
    <div className="mx-auto w-full max-w-[1180px] px-5 py-14">
      <div className="bt-label">Transparency</div>
      <h1 className="bt-display mt-3 text-[2.5rem] leading-[1.05] text-ink">
        Here is the whole database.
      </h1>
      <p className="mt-4 max-w-[64ch] text-[0.9375rem] leading-relaxed text-ink-dim">
        Not a summary of it, not a policy about it. The file below is compiled
        into the app at build time and applied at startup, and this page
        renders the same bytes. The rail on the right is read out of the live
        database, so you can check that the running schema is the published
        one. The board itself is members-only; this page never will be.
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

      <div className="mt-10 grid gap-x-10 gap-y-12 lg:grid-cols-[minmax(0,1fr)_300px]">
        <div className="min-w-0 space-y-14">
          <TSection
            id="verify"
            num="00"
            title="Verify it yourself, in three layers"
            lede="Trust claims sort into three piles: things you can check right now, things you still take on our word, and the work that moves items from the second pile into the first. Here is the sort, so you know which kind of claim you are reading everywhere else on this page."
          >
            <ol className="border border-rule bg-panel">
              <li className="grid grid-cols-[2.5rem_minmax(0,1fr)] gap-x-2 border-b border-rule px-4 py-4">
                <span className="bt-token pt-0.5">1</span>
                <div>
                  <div className="text-[0.875rem] font-medium text-ink">
                    Checkable now, by anyone.
                  </div>
                  <ul className="mt-2 space-y-2 text-[0.8125rem] leading-relaxed text-ink-dim">
                    <li>
                      The code is public at{" "}
                      <a
                        href="https://github.com/nathanjzhao/databoard"
                        className="font-mono text-blue hover:text-amber"
                      >
                        github.com/nathanjzhao/databoard
                      </a>{" "}
                      and every push runs{" "}
                      <a
                        href="https://github.com/nathanjzhao/databoard/actions"
                        className="text-blue hover:text-amber"
                      >
                        public CI
                      </a>
                      : typecheck, build, then Playwright suites
                      (tests/flow.spec.ts, tests/deals.spec.ts) that drive
                      signup, posting, and deals for real, dump the entire
                      database, and assert the planted contact, name, and
                      buyer strings appear nowhere in it.
                    </li>
                    <li>
                      Buyer names are blinded in your browser before they are
                      sent (RFC 9497 VOPRF). Every mint verifies a DLEQ proof
                      against the published server key, so your client checks,
                      cryptographically, that the same key answers everyone;
                      a server that keyed you differently to break or forge a
                      match would fail your own client&apos;s verification.
                      The key, also served at{" "}
                      <a
                        href="/api/voprf/pubkey"
                        className="font-mono text-blue hover:text-amber"
                      >
                        /api/voprf/pubkey
                      </a>
                      :
                      <span className="mt-1 block break-all font-mono text-[0.6875rem] text-amber">
                        {voprfPubKey ??
                          "unavailable right now; the endpoint above is authoritative"}
                      </span>
                    </li>
                    <li>
                      Message text in encrypted threads is sealed in the
                      sender&apos;s browser and stored as ciphertext plus
                      per-participant wrapped keys. Ciphertext-only storage
                      means a database dump, an operator query, or a subpoena
                      of the database yields no message text, with the
                      boundary stated in section 03.
                    </li>
                    <li>
                      The schema in section 01 and the same bytes at{" "}
                      <a
                        href="/api/transparency/schema"
                        className="font-mono text-blue hover:text-amber"
                      >
                        /api/transparency/schema
                      </a>{" "}
                      show every column that exists; the rail on the right
                      reads the live database to confirm the running schema is
                      the published one.
                    </li>
                    <li>
                      Every static JS and CSS file this deployment serves is
                      hashed right after the build into a manifest served at{" "}
                      <a
                        href="/api/transparency/js-manifest"
                        className="font-mono text-blue hover:text-amber"
                      >
                        /api/transparency/js-manifest
                      </a>
                      ; scripts/verify-served-js.sh in the repo fetches it,
                      samples the bundles, and compares SHA-256 and byte
                      counts. Said precisely, that step proves the static JS
                      you are served matches the manifest the same server
                      published, no more. The second step is what makes it
                      third-party: every CI run uploads the manifest for its
                      commit as a public workflow artifact, so you can fetch
                      the artifact for the commit stamped in the footer and
                      diff it against the manifest the site serves. A server
                      lying about its JS would have to get its lie into the
                      repo&apos;s own CI to survive both steps.
                    </li>
                  </ul>
                </div>
              </li>
              <li className="grid grid-cols-[2.5rem_minmax(0,1fr)] gap-x-2 border-b border-rule px-4 py-4">
                <span className="bt-token pt-0.5">2</span>
                <div>
                  <div className="text-[0.875rem] font-medium text-ink">
                    Still taken on our word.
                  </div>
                  <p className="mt-1 text-[0.8125rem] leading-relaxed text-ink-dim">
                    That the deployed code matches the commit stamped in the
                    footer: Vercel builds from the repo, but a malicious
                    deploy could stamp one commit and run another. That the
                    signup contact passing through memory is not logged on the
                    way. That the JavaScript served to your browser is the
                    repo&apos;s JavaScript. Layer 1 makes lying here
                    detectable in the code; it does not yet make it
                    impossible at runtime.
                  </p>
                </div>
              </li>
              <li className="grid grid-cols-[2.5rem_minmax(0,1fr)] gap-x-2 px-4 py-4">
                <span className="bt-token pt-0.5">3</span>
                <div>
                  <div className="text-[0.875rem] font-medium text-ink">
                    Shrinking the gap.
                  </div>
                  <p className="mt-1 text-[0.8125rem] leading-relaxed text-ink-dim">
                    Future work, named so the residue in layer 2 is a roadmap
                    rather than a shrug: TEE attestation, so the pepper and
                    the OPRF key exist only inside measured hardware and the
                    running code proves its own identity; and JS delivery
                    verification in the browser, the problem WhatsApp&apos;s
                    Code Verify addresses. One residue no blinding removes:
                    the buyer token is a deterministic function of the name over
                    a short public list of plausible labs, so the mapping from
                    token to name is recoverable by anyone who can evaluate that
                    list. The operator can do it offline with the key; any
                    signed-in member can do it too, one blinded call to
                    /api/voprf/evaluate per candidate name. The rate limit on
                    that endpoint is cost control, not a pseudonymity control: it
                    slows a script, it does not keep the mapping secret. The
                    protocol guarantees the server never receives a name, not
                    that a small dictionary is large. The durable fix is a
                    redesigned token (a random per-entity pseudonym), on the
                    verification page&apos;s roadmap.
                    And one residue no system removes: what you write in an
                    ask is public and yours. A description specific enough to
                    identify your company identifies it under any handle.
                  </p>
                </div>
              </li>
            </ol>
          </TSection>

          <TSection
            id="schema"
            num="01"
            title="The schema, verbatim"
            lede="db/schema.sql is the single source of truth. A prebuild step copies it into the module the database code imports, the first query applies it unchanged, and this block renders it comments and all. There is no second, private schema."
          >
            <SchemaBlock schema={schema} sha256={schemaSha} />
            <p className="mt-3 text-[0.8125rem] leading-relaxed text-ink-faint">
              The same bytes are served as plain text at{" "}
              <a
                href="/api/transparency/schema"
                className="font-mono text-blue hover:text-amber"
              >
                /api/transparency/schema
              </a>
              , no account needed, so you can diff and hash them outside a
              browser. Section 05 shows the expected checksum.
            </p>
          </TSection>

          <TSection
            id="visibility"
            num="02"
            title="What we can see, what we cannot"
            lede="An honest split. The left column is what an operator, an attacker with a database dump, or a subpoena gets. The right column is what none of them gets, because the columns do not exist."
          >
            <VisibilityTable />
            <p className="mt-3 max-w-[64ch] text-[0.8125rem] leading-relaxed text-ink-faint">
              One asterisk on the right column: the blind indexes are one-way
              keyed, not magic. Section 03 states exactly how far that
              protection goes.
            </p>
            <p className="mt-3 max-w-[64ch] text-[0.8125rem] leading-relaxed text-ink-faint">
              The deals rows deserve a second look: exact amounts, splits and
              evidence hashes are all operator-visible, on purpose. What a
              confirmed deal actually proves, and the ladder from a claim to
              anything worth calling verification, has its own page:{" "}
              <Link
                href="/transparency/verification"
                className="text-blue hover:text-amber"
              >
                /transparency/verification
              </Link>
              .
            </p>
          </TSection>

          <TSection
            id="attestation"
            num="03"
            title="Verification without a verification table"
            lede="The usual OTP design stores a row per attempt: contact, code, expiry. That table is a list of applicant phone numbers, so here it does not exist. The proof is carried by your browser instead of our disk."
          >
            <ol className="border border-rule bg-panel">
              {(
                [
                  [
                    "1",
                    "You submit a contact, a real name, and an affiliation.",
                    "The server draws a six digit code and computes challenge = expiry + HMAC(SERVER_PEPPER, contact, name, affiliation, code, expiry). It returns the challenge to your browser, sends the code to the contact, and writes nothing anywhere.",
                  ],
                  [
                    "2",
                    "You echo everything back, once, with the code.",
                    "Contact, name, affiliation, code and challenge come back in a single request. Between step 1 and now, the server held no state about you at all.",
                  ],
                  [
                    "3",
                    "The server recomputes the HMAC and compares.",
                    "A match proves the contact received the code and that the name and affiliation are the ones bound in at step 1; they were attested, and could not have been swapped afterward. Then they are discarded. What persists: an assigned handle, scrypt password hash, an org-or-individual bit, and the contact blind index.",
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

            <div className="mt-6 space-y-4">
              <div className="border-l-2 border-amber bg-amber-wash px-4 py-3.5">
                <div className="bt-label text-amber">
                  The blind index, honestly
                </div>
                <p className="mt-2 max-w-[62ch] text-[0.8438rem] leading-relaxed text-ink-dim">
                  Your contact survives as HMAC(SERVER_PEPPER, contact), kept
                  so one phone number cannot farm a hundred accounts. HMAC is
                  one-way, but it is not amnesia: an operator holding the
                  pepper can take a specific, already-known phone number or
                  email and test whether it is registered. What they cannot do
                  is run a stored index backward into a contact, or enumerate
                  contacts they have not guessed. That is the actual boundary.
                  Judge the design by it, not by a stronger claim we did not
                  make.
                </p>
              </div>
              <div className="border-l-2 border-amber bg-amber-wash px-4 py-3.5">
                <div className="bt-label text-amber">
                  Messages: ciphertext on the server, with named caveats
                </div>
                <p className="mt-2 max-w-[62ch] text-[0.8438rem] leading-relaxed text-ink-dim">
                  Thread text is end-to-end encrypted. Your browser seals each
                  message with a per-thread key, that key is wrapped for every
                  participant against public keys their own passwords derive,
                  and the server stores ciphertext plus wrapped keys it cannot
                  open. Encrypted threads refuse plaintext writes outright.
                  What this does not hide, said plainly: who talks to whom and
                  when, thread subjects, collab-request notes, and messages
                  from before encryption existed, which stay readable and are
                  labeled in the UI. The guarantee is against the database,
                  not the code path: an operator serving tampered JavaScript
                  could still capture keys in the browser, which is why the
                  code is public and CI builds from the repo you can read.
                  The standing advice stands: negotiate here, move genuinely
                  sensitive specifics, exact figures, samples, contracts,
                  off-platform to channels you control.
                </p>
              </div>
            </div>
          </TSection>

          <TSection
            id="recovery"
            num="04"
            title="No recovery, on purpose"
            lede="Password resets work by sending a secret to something the service stored: an inbox, a phone. We stored neither, so no reset flow exists. This is a consequence, not an oversight."
          >
            <div className="border border-rule bg-panel px-5 py-4">
              <p className="max-w-[62ch] text-[0.875rem] leading-relaxed text-ink-dim">
                Lose the password and the account is gone, full stop. It goes
                further than that, and the signup flow says so before you
                commit: contact_blind_index is UNIQUE, so the contact that
                opened the account cannot open another one. A forgotten
                password does not just burn the handle, it burns that
                contact&apos;s one seat at the table. Password managers exist;
                use one.
              </p>
              <p className="mt-3 max-w-[62ch] text-[0.8125rem] leading-relaxed text-ink-faint">
                We consider this a fair trade. Every recovery flow is a support
                channel that knows how to reach you, which is exactly the list
                we refuse to keep.
              </p>
            </div>
          </TSection>

          <TSection
            id="audit"
            num="05"
            title="Audit it yourself"
            lede="Every claim above is implemented in a specific file. This is the index: claim on the left, the code that makes it true on the right."
          >
            <AuditIndex schemaSha256={schemaSha} />
            <p className="mt-4 text-[0.8125rem] leading-relaxed text-ink-faint">
              Convinced, or at least unconvinced in a specific way?{" "}
              <Link href="/signup" className="text-blue hover:text-amber">
                Request an account
              </Link>{" "}
              or go back to{" "}
              <Link href="/gate" className="text-blue hover:text-amber">
                the gate
              </Link>
              .
            </p>
          </TSection>

          <TSection
            id="log"
            num="06"
            title="The ledger is append-only, and proves it"
            lede="The claims above are about what we store. This one is about what we cannot quietly un-store. Every consequential, non-PII event is a leaf in an append-only Merkle log (RFC 6962, the Certificate Transparency construction), the tree head is signed, and anyone can be handed a proof that a receipt is in the tree and that an older tree is an exact prefix of a newer one."
          >
            <div className="border border-rule bg-panel px-5 py-4">
              <p className="max-w-[64ch] text-[0.875rem] leading-relaxed text-ink-dim">
                The leaves are metadata only: blinded row ids, tiers, and $10k
                dollar buckets, never a handle, a buyer name, or an exact
                figure. A deal receipt now carries the sequence and hash of its
                leaf, so verifying a receipt can go on to prove it sits in the
                public log at a signed size, not merely that our shared-secret
                MAC is intact.
              </p>
              <p className="mt-3 max-w-[64ch] text-[0.8125rem] leading-relaxed text-ink-faint">
                Honest boundary, in full on the log page: the signing key is
                derived from SERVER_PEPPER, so the operator can sign a fork.
                What the design buys is detectability, not impossibility, a
                consistency proof plus two external anchors catch a rewrite of
                history others have pulled: the head is committed to git AND
                stamped into Bitcoin with OpenTimestamps (proofs under
                docs/transparency-log/ots/), so backdating or forking past an
                anchored point is detectable independent of our own git.
                Independent co-signing witnesses and a TEE-held key are the
                remaining upgrade, and are named as future work.
              </p>
              <p className="mt-4 text-[0.8125rem] leading-relaxed text-ink-dim">
                <Link href="/transparency/log" className="text-blue hover:text-amber">
                  Open the transparency log
                </Link>{" "}
                for the signed head, the public key, the checkpoint history, and
                a box that verifies inclusion and append-only-ness in your own
                browser.
              </p>
            </div>
          </TSection>
        </div>

        <aside className="lg:sticky lg:top-24 lg:self-start">
          <LiveStatus
            dbLive={dbLive}
            columns={columns}
            offenders={offenders}
            demoMode={DEMO_MODE}
            devPepper={isUsingDevPepper()}
          />
        </aside>
      </div>
    </div>
  );
}
