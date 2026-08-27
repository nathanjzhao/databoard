/**
 * components/exchange/steps.ts
 *
 * The five rungs of a commit-encrypt-pay-reveal exchange, as presentation data:
 * the label, who signs, and - the whole point of the honest UI - exactly what
 * that party's signature commits them to. The stepper reads this; it holds no
 * crypto and no state.
 */

import type { ExchangeRole, ExchangeState } from "@/lib/exchange";

export type Rung = {
  /** The state a session is IN once this rung is reached. */
  state: ExchangeState;
  label: string;
  /** Which party signs to reach this rung. */
  by: ExchangeRole;
  /** One line, in the actor's voice, of what the signature attests. */
  commits: string;
};

/** The ladder, in order. `aborted` is a terminal off-ladder state, not a rung. */
export const RUNGS: readonly Rung[] = [
  {
    state: "committed",
    label: "Committed",
    by: "seller",
    commits:
      "These exact plaintext and ciphertext manifests, and a hash of the key. I cannot swap the data later without breaking the roots.",
  },
  {
    state: "ciphertext_ack",
    label: "Ciphertext verified",
    by: "buyer",
    commits:
      "The sealed chunks I received hash to the committed ciphertext root. I am holding data I cannot open yet.",
  },
  {
    state: "payment_signaled",
    label: "Payment signaled",
    by: "buyer",
    commits:
      "I paid off-platform. Here is a reference commitment, a hash, with no amount and no raw reference in it.",
  },
  {
    state: "dek_revealed",
    label: "Key revealed",
    by: "seller",
    commits:
      "I released the key matching the committed hash to the buyer. The server still never sees it.",
  },
  {
    state: "completed",
    label: "Verified and complete",
    by: "buyer",
    commits:
      "I decrypted the chunks and the plaintext hashes to the committed plaintext root. This is the data that was promised.",
  },
] as const;

/** The rung index a session is currently at, or -1 for aborted. */
export function rungIndex(state: ExchangeState): number {
  if (state === "aborted") return -1;
  return RUNGS.findIndex((r) => r.state === state);
}

/** Human label for a state, for chips and headers. */
export function stateLabel(state: ExchangeState): string {
  if (state === "aborted") return "Aborted";
  const r = RUNGS.find((x) => x.state === state);
  return r ? r.label : state;
}
