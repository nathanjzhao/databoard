/**
 * components/messages/deal-room-tag.tsx
 *
 * The small chip a thread wears when it is the deal room for a recorded
 * deal. A plain span, deliberately: the list row is already one big link,
 * so the chip itself never navigates. Styled to match the deals ledger's
 * tier chips, since it points at the same object.
 */

export function DealRoomTag({ className }: { className?: string }) {
  return (
    <span
      className={[
        "inline-block shrink-0 border border-amber-soft/50 bg-amber-wash px-1.5 py-0.5",
        "font-mono text-[0.5625rem] uppercase tracking-[0.12em] text-amber",
        className ?? "",
      ].join(" ")}
      title="This thread is the deal room for a recorded deal"
    >
      deal room
    </span>
  );
}
