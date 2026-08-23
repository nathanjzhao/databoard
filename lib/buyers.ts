/**
 * lib/buyers.ts
 *
 * The known-buyer list. This is a CLIENT-side constant: it populates the
 * dropdown on the compose form so most posters pick from a fixed set and their
 * buyer tokens collide with everyone else's.
 *
 * The server never stores anything from this file. It receives a name, calls
 * buyerToken() on it, and forgets the name. The list exists to make the token
 * space small and shared, which is the whole reason "Buyer #a4f1" is useful:
 * two asks pointing at the same four hex characters really are the same buyer.
 *
 * A name typed into "Other" gets tokenized the same way and flagged with
 * buyer_is_other so the board can be honest that it is off-list.
 */

export const KNOWN_BUYERS = [
  "OpenAI",
  "Anthropic",
  "Google DeepMind",
  "Meta AI",
  "xAI",
  "Mistral",
  "Amazon AGI",
  "Microsoft AI",
  "Nvidia",
  "Scale AI",
  "Surge AI",
  "Mercor",
  "Together AI",
  "Cohere",
] as const;

export type KnownBuyer = (typeof KNOWN_BUYERS)[number];

/** The sentinel the dropdown uses to reveal the free-text field. */
export const OTHER_BUYER = "Other";

/** Everything the <select> should render, in order. */
export const BUYER_OPTIONS: readonly string[] = [...KNOWN_BUYERS, OTHER_BUYER];

export function isKnownBuyer(name: string): boolean {
  const n = (name ?? "").trim().toLowerCase();
  return KNOWN_BUYERS.some((b) => b.toLowerCase() === n);
}
