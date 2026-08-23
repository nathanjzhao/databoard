/**
 * components/messages/format.ts
 *
 * Timestamp formatting for the messaging UI. Hand-rolled instead of
 * Intl/toLocale* so the server-rendered HTML and the hydrated client agree
 * character for character (timezone aside, which the callers suppress).
 */

const MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
] as const;

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/** Coarse relative time for list rows: "just now", "4m", "2h", "3d", "Jun 5". */
export function relTime(ms: number, nowMs: number = Date.now()): string {
  const delta = nowMs - ms;
  if (delta < 60_000) return "just now";
  const mins = Math.floor(delta / 60_000);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 14) return `${days}d`;
  const d = new Date(ms);
  return `${MONTHS[d.getMonth()]} ${d.getDate()}`;
}

/** Full stamp for message rows: "Aug 23 14:02". */
export function stamp(ms: number): string {
  const d = new Date(ms);
  return `${MONTHS[d.getMonth()]} ${d.getDate()} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/* ----------------------------------------------------- participants line */

/** How many usernames a list row spells out before collapsing to "+N". */
const MAX_NAMES_SHOWN = 3;

/**
 * "@a, @b, @c +2" for thread rows. Short lists are spelled out in full,
 * because a fourth name costs about what "+1" would; past that the tail
 * collapses. Deal rooms are where this earns its keep.
 */
export function participantsLine(others: string[]): string {
  if (others.length === 0) return "counterparty departed";
  if (others.length <= MAX_NAMES_SHOWN + 1) {
    return others.map((u) => `@${u}`).join(", ");
  }
  const shown = others
    .slice(0, MAX_NAMES_SHOWN)
    .map((u) => `@${u}`)
    .join(", ");
  return `${shown} +${others.length - MAX_NAMES_SHOWN}`;
}

/* --------------------------------------------------------- sender colors */

/**
 * Text color classes for the other people in a thread, assigned by position
 * in the server-sorted participant list so every render, and every reader,
 * agrees on who is which color. Amber is reserved for the viewer; red is
 * reserved for warnings and never labels a person. Complete class names,
 * spelled out so Tailwind can see them.
 */
const SENDER_COLORS = ["text-blue", "text-green", "text-ink-dim"] as const;

export function senderColorClass(sender: string, others: string[]): string {
  const i = others.indexOf(sender);
  if (i < 0) return "text-ink-faint"; // sender has since left the thread
  return SENDER_COLORS[i % SENDER_COLORS.length];
}
