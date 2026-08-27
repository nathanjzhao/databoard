/**
 * /transparency/log
 *
 * The public face of the append-only Merkle transparency log. Reachable
 * without an account (lib/gate.ts), like the rest of /transparency: a
 * tamper-evident ledger is worth nothing if you need a login to read it.
 *
 * The page shows the latest Signed Tree Head, the log's public key and id,
 * the checkpoint history, and an honest account of what the log does and does
 * not prove. The verifier box below is a client component that fetches proofs
 * and re-checks them in the visitor's own browser, so the trust is in the math
 * and the published key, not in this server's say-so.
 */

import type { Metadata } from "next";
import Link from "next/link";
import { DbNotConfiguredNotice, PageStub } from "@/components/page-stub";
import { isDbConfigured } from "@/lib/db";
import { getSignedHead, listSignedHeads, logPublicKeyHex, logId } from "@/lib/translog";
import { TRANSLOG_HKDF_LABEL } from "@/lib/translog";
import { isUsingDevPepper } from "@/lib/crypto";
import { LogVerifier } from "@/components/transparency/log-verifier";
import type { Sth } from "@/lib/merkle";

export const metadata: Metadata = {
  title: "Transparency log",
  description:
    "The append-only Merkle log of what the board recorded, with its signed tree head, public key, and an in-browser proof checker.",
};
export const dynamic = "force-dynamic";

const GH_ANCHORS =
  "https://github.com/nathanjzhao/databoard/tree/main/docs/transparency-log";

function ts(ms: number): string {
  return new Date(ms).toISOString().replace("T", " ").slice(0, 19) + " UTC";
}

export default async function TransparencyLogPage() {
  if (!isDbConfigured()) {
    return (
      <PageStub
        eyebrow="Transparency log"
        title="An append-only ledger of what closed."
        blurb="Every recorded deal, confirmation, receipt and closure is a leaf in a Merkle tree whose head is signed and externally anchored."
      >
        <DbNotConfiguredNotice />
      </PageStub>
    );
  }

  const pubKey = logPublicKeyHex();
  const id = logId();
  let sth: Sth | null = null;
  let heads: Sth[] = [];
  try {
    sth = await getSignedHead();
    heads = await listSignedHeads(30);
  } catch {
    // Rendered as unavailable below; the API endpoints are the fallback.
  }
  const devPepper = isUsingDevPepper();

  return (
    <div className="mx-auto w-full max-w-[1000px] px-5 py-14">
      <div className="bt-label">
        <Link href="/transparency" className="hover:text-amber">
          Transparency
        </Link>{" "}
        / log
      </div>
      <h1 className="bt-display mt-3 text-[2.5rem] leading-[1.05] text-ink">
        The ledger signs its own history.
      </h1>
      <p className="mt-4 max-w-[68ch] text-[0.9375rem] leading-relaxed text-ink-dim">
        Every consequential thing the board records, a deal, a confirmation, a
        receipt, an ask posted or closed, an invite consumed, a referral
        settled, becomes a leaf in an append-only Merkle tree (RFC 6962, the
        Certificate Transparency construction). The tree head is signed. Anyone
        can be handed a proof that a specific receipt is in the tree, and a
        proof that an older tree is an exact prefix of a newer one, so a rewrite
        is detectable. The leaves hold metadata only: blinded row ids, tiers,
        and $10k dollar buckets. No handles, no buyer names, no exact amounts.
      </p>

      {/* ------------------------------------------------ latest signed head */}
      <section className="mt-10">
        <h2 className="bt-label">Latest signed tree head</h2>
        {sth ? (
          <dl className="mt-3 grid grid-cols-1 gap-x-10 gap-y-3 border border-rule-strong bg-panel px-5 py-4 sm:grid-cols-2">
            <Field label="Tree size">{sth.treeSize.toLocaleString("en-US")} leaves</Field>
            <Field label="Signed at">{ts(sth.timestamp)}</Field>
            <Field label="Root hash" wide>
              {sth.rootHash}
            </Field>
            <Field label="Signature" wide>
              {sth.signature}
            </Field>
          </dl>
        ) : (
          <p className="mt-3 border border-rule bg-panel px-5 py-4 text-[0.8125rem] text-ink-faint">
            The head is unavailable right now. It is served at{" "}
            <a href="/api/translog/sth" className="font-mono text-blue hover:text-amber">
              /api/translog/sth
            </a>
            .
          </p>
        )}
        <div className="mt-4 grid grid-cols-1 gap-x-10 gap-y-3 sm:grid-cols-2">
          <Field label="Log id">{id}</Field>
          <Field label="Signature algorithm">Ed25519</Field>
          <Field label="Public key" wide>
            {pubKey}
          </Field>
        </div>
        <p className="mt-3 text-[0.8125rem] leading-relaxed text-ink-faint">
          The head and the proofs are served at{" "}
          <a href="/api/translog/sth" className="font-mono text-blue hover:text-amber">
            /api/translog/sth
          </a>
          ,{" "}
          <a
            href="/api/translog/proof/inclusion?leaf="
            className="font-mono text-blue hover:text-amber"
          >
            /proof/inclusion
          </a>
          , and{" "}
          <a
            href="/api/translog/proof/consistency?from=1&to=2"
            className="font-mono text-blue hover:text-amber"
          >
            /proof/consistency
          </a>
          . The key is at{" "}
          <a href="/api/translog/pubkey" className="font-mono text-blue hover:text-amber">
            /api/translog/pubkey
          </a>
          , derived HKDF-SHA256(SERVER_PEPPER, &quot;{TRANSLOG_HKDF_LABEL}&quot;).
        </p>
        {devPepper ? (
          <p className="mt-3 border-l-2 border-amber bg-amber-wash px-4 py-2.5 text-[0.75rem] leading-relaxed text-ink-dim">
            This instance is running the checked-in dev pepper, so the log key
            above is the public dev key. A dev-pepper head is genuine only on
            this instance.
          </p>
        ) : null}
      </section>

      {/* ------------------------------------------------------- verifier */}
      <section className="mt-12 scroll-mt-24" id="verify">
        <h2 className="bt-display text-[1.65rem] leading-[1.1] text-ink">
          Verify it yourself, in your browser
        </h2>
        <p className="mt-3 max-w-[68ch] text-[0.9375rem] leading-relaxed text-ink-dim">
          These two checks fetch a proof from the log and then redo the
          arithmetic here, on your machine, against the key above. The server
          serves the proof; it does not get to grade its own answer.
        </p>
        <div className="mt-5">
          <LogVerifier publicKey={pubKey} />
        </div>
      </section>

      {/* ------------------------------------------------- checkpoint history */}
      <section className="mt-12">
        <h2 className="bt-label">Checkpoint history</h2>
        <p className="mt-2 max-w-[68ch] text-[0.8125rem] leading-relaxed text-ink-faint">
          Every tree size the log has signed a head at. These are the sizes you
          can run a consistency check between above. The same heads are
          committed to git under{" "}
          <a href={GH_ANCHORS} className="font-mono text-blue hover:text-amber">
            docs/transparency-log/
          </a>{" "}
          as one external witness, and each is stamped into Bitcoin with
          OpenTimestamps (the <span className="font-mono">.ots</span> proofs sit
          beside them under{" "}
          <a
            href={`${GH_ANCHORS}/ots`}
            className="font-mono text-blue hover:text-amber"
          >
            ots/
          </a>
          ) as a second one the operator does not control. Once a head is in the
          public git history others have pulled, or anchored in Bitcoin, the
          operator cannot quietly rewrite the log without the witnesses
          disagreeing.
        </p>
        {heads.length > 0 ? (
          <div className="mt-3 overflow-x-auto border border-rule">
            <table className="w-full border-collapse text-left text-[0.75rem]">
              <thead>
                <tr className="border-b border-rule bg-panel-2 text-ink-faint">
                  <th className="px-3 py-2 font-medium">Size</th>
                  <th className="px-3 py-2 font-medium">Signed at</th>
                  <th className="px-3 py-2 font-medium">Root hash</th>
                </tr>
              </thead>
              <tbody className="font-mono">
                {heads.map((h) => (
                  <tr key={h.treeSize} className="border-b border-rule last:border-b-0">
                    <td className="px-3 py-2 tabular-nums text-ink">{h.treeSize}</td>
                    <td className="whitespace-nowrap px-3 py-2 text-ink-dim">{ts(h.timestamp)}</td>
                    <td className="px-3 py-2 text-ink-dim">
                      <span className="break-all">{h.rootHash.slice(0, 24)}…</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="mt-3 text-[0.8125rem] text-ink-faint">
            No checkpoints yet. A head is signed the first time the log is read
            at a given size.
          </p>
        )}
      </section>

      {/* -------------------------------------------------------- honesty */}
      <section className="mt-12 border-t border-rule-strong pt-7">
        <h2 className="bt-display text-[1.65rem] leading-[1.1] text-ink">
          What this proves, and what it does not
        </h2>
        <div className="mt-4 space-y-4">
          <div className="border-l-2 border-green bg-green-wash px-4 py-3.5">
            <div className="bt-label text-green">What holds</div>
            <p className="mt-2 max-w-[66ch] text-[0.8438rem] leading-relaxed text-ink-dim">
              Given a signed head, the inclusion and consistency proofs are
              real: you can confirm a receipt is in the tree, and that an
              earlier tree is a prefix of a later one, without trusting us. If
              two people ever hold two heads of the same size with different
              roots, or a later head that is not consistent with an earlier one
              they saved, that is proof of a rewrite, and it is portable.
            </p>
          </div>
          <div className="border-l-2 border-amber bg-amber-wash px-4 py-3.5">
            <div className="bt-label text-amber">The honest gap</div>
            <p className="mt-2 max-w-[66ch] text-[0.8438rem] leading-relaxed text-ink-dim">
              The log signing key is HMAC-derived from SERVER_PEPPER, which the
              operator holds, so the operator CAN sign a fork of the log. What
              the design buys is not impossibility but detectability: a
              consistency proof plus the external anchors means a rewrite of
              history others have already pulled, or a second fork served to
              someone else, is caught after the fact. It is append-only against
              an observer who keeps a head, not append-only by physics.
            </p>
          </div>
          <div className="border-l-2 border-green bg-green-wash px-4 py-3.5">
            <div className="bt-label text-green">
              Anchored in Bitcoin (OpenTimestamps)
            </div>
            <p className="mt-2 max-w-[66ch] text-[0.8438rem] leading-relaxed text-ink-dim">
              Each signed head is stamped into Bitcoin with OpenTimestamps and
              the <span className="font-mono text-[0.75rem]">.ots</span> proofs
              are committed under{" "}
              <a
                href={`${GH_ANCHORS}/ots`}
                className="font-mono text-blue hover:text-amber"
              >
                docs/transparency-log/ots/
              </a>
              . That anchors the head&apos;s hash into a timestamp the operator
              cannot backdate or fork past, independent of our own git. Anyone
              can complete and check a proof with the standard{" "}
              <span className="font-mono text-[0.75rem]">ots</span> client
              (verify against the SHA-256 of the matching{" "}
              <span className="font-mono text-[0.75rem]">sth-&lt;n&gt;.json</span>);
              the stamping script (<span className="font-mono text-[0.75rem]">scripts/ots-anchor.ts</span>)
              speaks the calendar API directly, with no new dependency. Fresh
              stamps are pending Bitcoin confirmation, which takes hours; that is
              the ordinary OpenTimestamps lifecycle, not a half-proof.
            </p>
          </div>
          <div className="border-l-2 border-rule-strong bg-panel px-4 py-3.5">
            <div className="bt-label">The remaining upgrade</div>
            <p className="mt-2 max-w-[66ch] text-[0.8438rem] leading-relaxed text-ink-dim">
              Stated so the gap above is a roadmap, not a shrug: independent
              witnesses that co-sign the tree head (the sigsum / Certificate
              Transparency witness model, so no single party, us included, can
              fork it unnoticed), and a log key held inside measured hardware (a
              TEE) so the running code proves its own identity. With the Bitcoin
              anchor already in place, those move &quot;detectable&quot; toward
              &quot;impossible to attempt.&quot; They are future work.
            </p>
          </div>
        </div>
        <p className="mt-6 text-[0.8125rem] leading-relaxed text-ink-faint">
          Terminal auditing: <span className="font-mono">scripts/verify-log.sh</span>{" "}
          in the repo fetches the head and a proof and verifies them offline.
          Back to{" "}
          <Link href="/transparency" className="text-blue hover:text-amber">
            the transparency overview
          </Link>
          .
        </p>
      </section>
    </div>
  );
}

function Field({
  label,
  children,
  wide,
}: {
  label: string;
  children: React.ReactNode;
  wide?: boolean;
}) {
  return (
    <div className={["flex flex-col gap-0.5", wide ? "sm:col-span-2" : ""].join(" ")}>
      <dt className="bt-label">{label}</dt>
      <dd className="break-all font-mono text-[0.75rem] leading-snug text-ink">{children}</dd>
    </div>
  );
}
