/**
 * components/ask/meta.tsx
 *
 * The small display atoms every ask surface shares: the supply meter, the
 * buyer chip, the status mark. Presentational only, no hooks and no server
 * imports, so both server pages and client forms can render them.
 *
 * BuyerChip receives a token that was minted server-side by lib/crypto.ts.
 * Nothing in here ever sees a buyer name.
 */

import { categoryLabel, type AskStatus } from "@/lib/taxonomy";

/* ---------------------------------------------------------- supply meter */

const SEGMENTS = 10;

/**
 * Ten cells, like a tape gauge. Filled cells go green; the number sits
 * beside it in mono. `dim` is for closed rows where the meter is history,
 * not signal.
 */
export function SupplyMeter({
  pct,
  dim = false,
}: {
  pct: number;
  dim?: boolean;
}) {
  const filled = Math.round((Math.min(100, Math.max(0, pct)) / 100) * SEGMENTS);
  return (
    <span
      className="inline-flex items-center gap-2"
      title={`${pct}% of the asked-for supply already filled`}
    >
      <span className="flex gap-[2px]" aria-hidden>
        {Array.from({ length: SEGMENTS }, (_, i) => (
          <span
            key={i}
            className={[
              "h-[10px] w-[4px]",
              i < filled
                ? dim
                  ? "bg-ink-ghost"
                  : "bg-green"
                : "bg-panel-3",
            ].join(" ")}
          />
        ))}
      </span>
      <span
        className={[
          "font-mono text-[0.6875rem] tabular-nums",
          dim ? "text-ink-ghost" : pct >= 100 ? "text-green" : "text-ink-faint",
        ].join(" ")}
      >
        {pct}%
      </span>
    </span>
  );
}

/* ------------------------------------------------------------ buyer chip */

/**
 * "Buyer #2cee". Four hex characters of a keyed hash: enough to see that two
 * asks point at the same buyer, not enough to say who. Off-list buyers (a
 * name typed into "Other") carry a small mark so the board is honest that
 * the token came from outside the shared dropdown.
 */
export function BuyerChip({
  token,
  isOther,
  dim = false,
}: {
  token: string;
  isOther: boolean;
  dim?: boolean;
}) {
  return (
    <span
      className={[
        "inline-flex items-baseline gap-1.5 border px-1.5 py-0.5",
        dim
          ? "border-rule bg-panel text-ink-ghost"
          : "border-amber-soft/40 bg-amber-wash",
      ].join(" ")}
      title={
        isOther
          ? "Off-list buyer. The name was typed, keyed and discarded; only this token remains."
          : "Keyed buyer token. Same four characters on another ask means the same buyer."
      }
    >
      <span
        className={[
          "font-mono text-[0.6875rem] leading-none",
          dim ? "text-ink-ghost" : "text-amber",
        ].join(" ")}
      >
        #{token.slice(0, 4)}
      </span>
      {isOther ? (
        <span className="font-mono text-[0.5625rem] uppercase tracking-[0.1em] text-ink-ghost">
          off-list
        </span>
      ) : null}
    </span>
  );
}

/* ---------------------------------------------------------- status mark */

const STATUS_STYLE: Record<AskStatus, { dot: string; text: string }> = {
  open: { dot: "bg-amber", text: "text-amber" },
  partial: { dot: "bg-green", text: "text-green" },
  closed: { dot: "bg-red/70", text: "text-ink-ghost" },
};

export function StatusMark({ status }: { status: AskStatus }) {
  const s = STATUS_STYLE[status];
  return (
    <span className="inline-flex items-center gap-1.5">
      <span
        className={["h-[5px] w-[5px] rounded-full", s.dot].join(" ")}
        aria-hidden
      />
      <span
        className={[
          "font-mono text-[0.625rem] uppercase tracking-[0.12em]",
          s.text,
        ].join(" ")}
      >
        {status}
      </span>
    </span>
  );
}

/* ------------------------------------------------------------- tag chips */

export function ModalityTags({ tags, dim = false }: { tags: string[]; dim?: boolean }) {
  if (tags.length === 0) return null;
  return (
    <span
      className={[
        "font-mono text-[0.6875rem]",
        dim ? "text-ink-ghost" : "text-ink-faint",
      ].join(" ")}
    >
      {tags.join(" · ")}
    </span>
  );
}

export function CategoryTag({ slug, dim = false }: { slug: string; dim?: boolean }) {
  return (
    <span
      className={[
        "text-[0.6875rem] uppercase tracking-[0.08em]",
        dim ? "text-ink-ghost" : "text-ink-dim",
      ].join(" ")}
    >
      {categoryLabel(slug)}
    </span>
  );
}
