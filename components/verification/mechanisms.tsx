/**
 * components/verification/mechanisms.tsx
 *
 * The planned evidence mechanisms, one card each, with the three fields that
 * keep this page honest: what the mechanism would prove, what it would not,
 * and the catch. Every maturity chip is the state of the tooling as of
 * mid-2026, engineering time only, excluding vendor approval, security
 * audits, and legal review. Nothing in this file is shipped.
 */

export type Mechanism = {
  name: string;
  /** Maturity, verbatim honest: "planned" plus the real state of the tooling. */
  tag: string;
  proves: string;
  not: string;
  catchNote: string;
};

export const PAYMENT_MECHANISMS: readonly Mechanism[] = [
  {
    name: "Channel-bound invoices (Stripe bank transfers)",
    tag: "planned · weeks of work",
    proves:
      "Funds reached a customer-specific virtual account and were reconciled to a specific invoice. A random 128-bit deal nonce printed on the invoice and wire reference ties the payment to the deal. Acceptance would mean live mode, a re-fetched posted state, a one-use provider transaction id, and reversal checks near 7 and 30 days.",
    not:
      "Who the payer legally is. Wire descriptors arrive truncated, DBA'd, routed through treasury subsidiaries and AP processors; a name string in a memo is not an identity. And nothing about the dataset: quality, rights, legality.",
    catchNote:
      "An invoice PDF, a scheduled transfer, a pending transaction, or a paid-manually flag is not payment evidence and would be rejected. Wash payments followed by refunds are exactly why the reversal window exists. Memo preservation across banks is not guaranteed.",
  },
  {
    name: "Bank-side records (Plaid, Mercury, Ramp)",
    tag: "planned · vendor approval required",
    proves:
      "A posted credit with amount, currency, date and transaction id exists in a linked seller account (Plaid, Mercury), or a completed vendor payment with invoice and trace ids exists in a buyer's AP system (Ramp).",
    not:
      "Payer identity, usually. No payment metadata field is guaranteed, so the honest output states are receipt_verified versus payer_unavailable, never a guess parsed out of free text.",
    catchNote:
      "Linking a bank account exposes a window of transaction history, not one selected row, which is a real privacy cost to the seller. Posted records can later be modified or removed, so evidence would be re-queried, not cached and trusted.",
  },
  {
    name: "Licensed escrow (Escrow.com)",
    tag: "planned · strongest, most invasive",
    proves:
      "Funded and released states reported by a licensed escrow agent that verified both incoming and disbursement names under KYB. The strongest payment rung on this page.",
    not:
      "Dataset rights, quality, or that the trade made commercial sense. Completion proves the money conditionally moved and the conditions cleared, nothing more.",
    catchNote:
      "The escrow agent learns both legal identities. That is the point, and the price: the platform stays blind only if the integration passes it nothing but states and tokens.",
  },
];

export const PROOF_MECHANISMS: readonly Mechanism[] = [
  {
    name: "zkTLS web proofs (Reclaim, TLSNotary, zkPass, Opacity)",
    tag: "planned · alpha to pilot-grade",
    proves:
      "A bank's authenticated HTTPS transaction API returned an incoming posted wire of $X on date D, with every other field redacted, and without the platform seeing the session. Reclaim is the most integration-ready (provider templates, attestor trust); TLSNotary is the strongest open substrate and its own repository says alpha, not production-ready; zkPass and Opacity are pilot-grade with validator or notary allowlists to trust.",
    not:
      "The payer's name, whenever the bank's own record says WIRE CREDIT plus an editable memo. A proof over free text faithfully proves the free text. Only banks exposing a stable, structured originator field are worth proving against, and this must authenticate API JSON, not a rendered PDF statement.",
    catchNote:
      "Provider template drift and bank bot defenses are permanent operational costs, and replay protection, freshness, and version pinning are the application's job, not the protocol's.",
  },
  {
    name: "ZK Email DKIM proofs (zk.email)",
    tag: "planned · corroboration only",
    proves:
      "Someone holds a raw email whose DKIM signature verifies for a named signing domain, whose body matches a constrained template ('payment of $X sent'), revealing only the chosen fields, with a nullifier so one email cannot back two deals.",
    not:
      "Settlement. DKIM (RFC 6376) authenticates a domain's responsibility for the bytes of a message, not an employee's authority to send it and not that a bank moved money. A payment-notice email is corroboration of a payment, never the payment evidence itself.",
    catchNote:
      "DKIM keys rotate and old selector keys vanish from DNS, so old emails stop verifying; the public key archive that mitigates this is itself one more thing to trust. Corporate mail is often signed by subdomains or mail vendors, so the template work is real.",
  },
];

export function MechanismList({ items }: { items: readonly Mechanism[] }) {
  return (
    <div className="border border-rule bg-panel">
      <ul className="divide-y divide-rule">
        {items.map((m) => (
          <li key={m.name} className="px-5 py-4">
            <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
              <span className="text-[0.875rem] font-medium text-ink">
                {m.name}
              </span>
              <span className="inline-block border border-rule-strong bg-panel-2 px-1.5 py-0.5 font-mono text-[0.5625rem] uppercase tracking-[0.12em] text-ink-faint">
                {m.tag}
              </span>
            </div>
            <dl className="mt-3 space-y-2.5">
              {(
                [
                  ["would prove", m.proves, "text-green"],
                  ["would not", m.not, "text-red"],
                  ["the catch", m.catchNote, "text-amber"],
                ] as const
              ).map(([label, body, tone]) => (
                <div
                  key={label}
                  className="grid gap-x-4 gap-y-0.5 sm:grid-cols-[6.5rem_minmax(0,1fr)]"
                >
                  <dt className={["bt-label pt-0.5", tone].join(" ")}>
                    {label}
                  </dt>
                  <dd className="text-[0.8125rem] leading-relaxed text-ink-dim">
                    {body}
                  </dd>
                </div>
              ))}
            </dl>
          </li>
        ))}
      </ul>
    </div>
  );
}
