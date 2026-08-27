/**
 * components/ask/meta.tsx
 *
 * The small display atoms every ask surface shares: the supply meter, the
 * buyer chip, the status mark. Presentational only, no hooks and no server
 * imports, so both server pages and client forms can render them.
 *
 * BuyerChip receives a stored buyer token: "v2:" OPRF tokens the browser
 * minted blind (lib/voprf.ts), or legacy keyed hashes on old rows. Nothing
 * in here ever sees a buyer name.
 */

import { categoryLabel, type AskStatus } from "@/lib/taxonomy";
import { buyerChip } from "@/lib/voprf";

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
 * "Buyer #2cee". Four hex characters of a blinded token: enough to see that
 * two asks point at the same buyer, not enough to say who. Off-list buyers (a
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
          ? "Off-list buyer. The name was blinded in the poster's browser; only this token exists here."
          : "Blinded buyer token. Same four characters on another ask means the same buyer."
      }
    >
      <span
        className={[
          "font-mono text-[0.6875rem] leading-none",
          dim ? "text-ink-ghost" : "text-amber",
        ].join(" ")}
      >
        #{buyerChip(token)}
      </span>
      {isOther ? (
        <span className="font-mono text-[0.5625rem] uppercase tracking-[0.1em] text-ink-ghost">
          off-list
        </span>
      ) : null}
    </span>
  );
}

/* --------------------------------------------------------- mandate mark */

/**
 * A small grayscale mark for board rows whose ask carries a mandate
 * commitment. Deliberately colorless: a committed hash is a pin, not a
 * verification, and the mark must not read as a badge of anything more.
 */
export function MandateMark({ dim = false }: { dim?: boolean }) {
  return (
    <span
      className={[
        "inline-flex items-center border px-1.5 py-0.5 font-mono text-[0.5625rem] uppercase tracking-[0.1em]",
        dim
          ? "border-rule text-ink-ghost"
          : "border-rule-strong text-ink-faint",
      ].join(" ")}
      title="Mandate committed: the poster pinned this ask to one document by its SHA-256. Consistency, not authenticity."
    >
      mandate
    </span>
  );
}

/* ------------------------------------------------------- track record */

/**
 * A small chip on an ask whose poster has confirmed, co-attested recorded
 * volume. The value is bucketed (a floor with a "+", e.g. "$250k+") and never
 * the exact figure; the bucket is computed server-side in lib/matching.ts and
 * only the string reaches here. It is the visible half of the recording
 * incentive: recorded volume both lifts an ask's position and earns this mark.
 */
export function TrackRecordChip({
  chip,
  dim = false,
}: {
  chip: string | null;
  dim?: boolean;
}) {
  if (!chip) return null;
  return (
    <span
      className={[
        "inline-flex items-baseline gap-1 border px-1.5 py-0.5 font-mono text-[0.5625rem] uppercase tracking-[0.1em]",
        dim ? "border-rule text-ink-ghost" : "border-rule-strong text-ink-faint",
      ].join(" ")}
      title="Track record: the poster's confirmed, co-attested recorded deal volume, bucketed and never exact. It lifts where their asks appear."
    >
      <span>rec</span>
      <span className={dim ? "text-ink-ghost" : "text-ink-dim"}>{chip}</span>
    </span>
  );
}

/* ---------------------------------------------------------- status mark */

const STATUS_STYLE: Record<AskStatus, { dot: string; text: string }> = {
  open: { dot: "bg-amber", text: "text-amber" },
  partial: { dot: "bg-green", text: "text-green" },
  closed: { dot: "bg-ink-dim", text: "text-ink-dim" },
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
