/**
 * components/deals/record-deal-link.tsx
 *
 * The "record a deal" entry points. Plain links, no hooks, so any surface
 * (server or client) can drop one in. The thread variant carries the thread
 * id as a query param; /deals/new resolves the thread's other members
 * server-side (membership checked) and prefills them as participant rows.
 */

import Link from "next/link";

export function RecordDealButton({ className }: { className?: string }) {
  return (
    <Link href="/deals/new" className={className ?? "bt-btn bt-btn-primary px-4 py-2 text-[0.8125rem]"}>
      Record a deal
    </Link>
  );
}

/** Drop-in for a message thread header: prefills everyone in the thread. */
export function RecordDealFromThread({
  threadId,
  className,
}: {
  threadId: string;
  className?: string;
}) {
  return (
    <Link
      href={`/deals/new?thread=${encodeURIComponent(threadId)}`}
      className={className ?? "bt-btn px-3 py-1 text-[0.75rem]"}
      title="Record a deal with the people in this thread prefilled as participants"
    >
      Record a deal
    </Link>
  );
}
