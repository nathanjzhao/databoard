/**
 * components/verification/mitigations.tsx
 *
 * Anti-gaming controls for co-attested deals, split honestly into the ones
 * running right now and the ones that are still a reading list. Same
 * two-panel pattern as the visibility table on /transparency: the hatched
 * side is the side we do not have.
 */

const RUNNING: ReadonlyArray<readonly [string, string]> = [
  [
    "Distinct counterparties, not dollars",
    "the default ranking counts confirmed people, an identity-shaped signal, not self-reported volume",
  ],
  [
    "30-day pair cap",
    "a reporter and a counterparty count once per 30 days, no matter how many deals they confirm together",
  ],
  [
    "No unilateral claims in public",
    "an unconfirmed deal surfaces nowhere except the reporter's own self value, labeled claimed-tier",
  ],
  [
    "Rounded public figures",
    "every public dollar figure rounds to the nearest $10k; below that it prints <$10k",
  ],
];

const PLANNED: ReadonlyArray<readonly [string, string]> = [
  [
    "Signed canonical attestations",
    "each side signs a canonical payload (server nonce, contract hash, parties, amount band, dates) with an account key, instead of flipping a database flag",
  ],
  [
    "Double-blind confirmation",
    "hide the first attestation until the second lands or a deadline passes, the way Airbnb reveals reviews",
  ],
  [
    "Probation and reversal windows",
    "new accounts and fresh deals earn leaderboard credit only after a delay long enough for refunds and reversals to surface",
  ],
  [
    "Graph analysis",
    "bipartite screening for dense bicliques, cycles, reciprocal role swaps and bursts (FRAUDAR, SybilRank); risk scoring, not proof, since real labs form hubs too",
  ],
];

function MitList({
  rows,
  dim,
}: {
  rows: ReadonlyArray<readonly [string, string]>;
  dim?: boolean;
}) {
  return (
    <ul className="divide-y divide-rule">
      {rows.map(([thing, note]) => (
        <li key={thing} className="px-4 py-3">
          <span
            className={["text-[0.875rem]", dim ? "text-ink-dim" : "text-ink"].join(
              " ",
            )}
          >
            {thing}
          </span>
          <span className="mt-0.5 block font-mono text-[0.6875rem] leading-relaxed text-ink-faint">
            {note}
          </span>
        </li>
      ))}
    </ul>
  );
}

export function MitigationsTable() {
  return (
    <div className="grid gap-4 md:grid-cols-2">
      <div className="border border-rule bg-panel">
        <div className="border-b border-rule px-4 py-2.5">
          <span className="bt-label text-amber">Running today</span>
        </div>
        <MitList rows={RUNNING} />
      </div>
      <div className="relative border border-rule bg-panel">
        <div className="bt-hatch pointer-events-none absolute inset-0 opacity-30" />
        <div className="relative">
          <div className="border-b border-rule px-4 py-2.5">
            <span className="bt-label text-ink-dim">Planned, not built</span>
          </div>
          <MitList rows={PLANNED} dim />
        </div>
      </div>
    </div>
  );
}
