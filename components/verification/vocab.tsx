/**
 * components/verification/vocab.tsx
 *
 * The evidence-state vocabulary, one row per word the product is allowed to
 * use about a deal, with its shipped/planned status. The last row is the word
 * we are reserving. If a tier name on any page ever disagrees with this
 * table, the page is wrong.
 */

type WordState = "live" | "planned" | "reserved";

const WORDS: ReadonlyArray<{
  word: string;
  state: WordState;
  means: string;
}> = [
  {
    word: "claimed",
    state: "live",
    means:
      "one account says so; never public beyond the reporter's own claimed-tier self value",
  },
  {
    word: "co-attested",
    state: "live",
    means:
      "every non-declined named participant confirmed their own share from their own account; agreement between pseudonyms, not verification",
  },
  {
    word: "evidence committed",
    state: "live",
    means:
      "co-attested, plus SHA-256 commitments from the reporter and every confirmed participant; not yet independently verified",
  },
  {
    word: "payment received",
    state: "planned",
    means:
      "a provider re-fetch showed posted or released funds matching the deal nonce, amount and window, with a one-use transaction id",
  },
  {
    word: "payer-bound",
    state: "planned",
    means:
      "a structured originator matched the buyer token inside an attested verifier, without the platform learning the name",
  },
  {
    word: "escrow-settled",
    state: "planned",
    means: "funded and released through a licensed escrow agent",
  },
  {
    word: "verified",
    state: "reserved",
    means:
      "all of: payment received, payer-bound, a buyer-signed dataset commitment, and no reversal after the window; never used as a status today, only inside the negation 'not yet independently verified'",
  },
];

function WordChip({ state }: { state: WordState }) {
  const style =
    state === "live"
      ? "border-amber-soft/50 bg-amber-wash text-amber"
      : state === "planned"
        ? "border-rule-strong bg-panel-2 text-ink-faint"
        : "border-red/50 bg-red-wash text-red";
  return (
    <span
      className={[
        "inline-block border px-1.5 py-0.5 font-mono text-[0.5625rem] uppercase tracking-[0.12em]",
        style,
      ].join(" ")}
    >
      {state}
    </span>
  );
}

export function VocabTable() {
  return (
    <div className="border border-rule bg-panel">
      <div className="grid grid-cols-[minmax(0,11rem)_auto] items-center gap-x-4 border-b border-rule px-4 py-2.5 sm:grid-cols-[minmax(0,11rem)_5rem_minmax(0,1fr)]">
        <span className="bt-label">Word</span>
        <span className="bt-label">Status</span>
        <span className="bt-label hidden sm:block">What it commits us to</span>
      </div>
      <ul className="divide-y divide-rule">
        {WORDS.map((w) => (
          <li
            key={w.word}
            className="grid grid-cols-[minmax(0,11rem)_auto] items-baseline gap-x-4 gap-y-1 px-4 py-3 sm:grid-cols-[minmax(0,11rem)_5rem_minmax(0,1fr)]"
          >
            <span className="font-mono text-[0.75rem] text-ink">{w.word}</span>
            <span>
              <WordChip state={w.state} />
            </span>
            <span className="col-span-2 text-[0.8125rem] leading-relaxed text-ink-dim sm:col-span-1">
              {w.means}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
