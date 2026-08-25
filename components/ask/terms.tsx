/**
 * components/ask/terms.tsx
 *
 * The exclusivity chip: the one stated term an ask carries (ask_terms,
 * lib/terms.ts). TermsChip is presentational and takes the value, so board
 * rows can join it in bulk; AskTerms fetches for a single ask page.
 *
 * Three states, all honest: exclusive, non-exclusive, and "terms
 * unspecified" for asks posted before terms existed. Unspecified is not a
 * default; it is the absence of an answer, and it renders as one.
 */

import { getAskTerms, type Exclusivity } from "@/lib/terms";

const COPY: Record<Exclusivity, { text: string; title: string }> = {
  exclusive: {
    text: "exclusive",
    title: "Exclusive: supply sold into this ask cannot be resold elsewhere.",
  },
  nonexclusive: {
    text: "non-exclusive",
    title: "Non-exclusive: suppliers may reuse this supply elsewhere.",
  },
};

export function TermsChip({
  exclusivity,
  dim = false,
}: {
  exclusivity: Exclusivity | null;
  dim?: boolean;
}) {
  if (exclusivity === null) {
    return (
      <span
        className="font-mono text-[0.5625rem] uppercase tracking-[0.1em] text-ink-ghost"
        title="Posted before terms were stated on this board. Ask the poster."
      >
        terms unspecified
      </span>
    );
  }
  const c = COPY[exclusivity];
  return (
    <span
      className={[
        "inline-flex items-center border px-1.5 py-0.5 font-mono text-[0.5625rem] uppercase tracking-[0.1em]",
        dim
          ? "border-rule text-ink-ghost"
          : exclusivity === "exclusive"
            ? "border-ink-ghost text-ink-dim"
            : "border-rule-strong text-ink-faint",
      ].join(" ")}
      title={c.title}
    >
      {c.text}
    </span>
  );
}

/** The chip for one ask, fetched. Server component; drop it anywhere. */
export async function AskTerms({
  askId,
  dim = false,
}: {
  askId: string;
  dim?: boolean;
}) {
  const exclusivity = await getAskTerms(askId);
  return <TermsChip exclusivity={exclusivity} dim={dim} />;
}
