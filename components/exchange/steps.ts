/**
 * components/exchange/steps.ts
 *
 * The five rungs of a commit-encrypt-pay-reveal exchange, as presentation data:
 * the label, who signs, and - the whole point of the honest UI - exactly what
 * that party's signature commits them to. The stepper reads this; it holds no
 * crypto and no state.
 */

import type { ExchangeRole, ExchangeState, WireStatus } from "@/lib/exchange";

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
    label: "Payment sent",
    by: "buyer",
    commits:
      "I wired the payment off-platform with this deal's reference (N15). Here is a salted hash of my wire confirmation, the amount bucket and the reference: no amount, no receipt, no raw reference.",
  },
  {
    state: "dek_revealed",
    label: "Key revealed",
    by: "seller",
    commits:
      "The wire credit was mutually observed, so I released the key matching the committed hash to the buyer. The server still never sees it.",
  },
  {
    state: "completed",
    label: "Verified and complete",
    by: "buyer",
    commits:
      "I decrypted the chunks and the plaintext hashes to the committed plaintext root. This is the data that was promised.",
  },
] as const;

/**
 * The WireCreditClaim sub-steps that run inside the payment phase (between
 * "Payment sent" and "Key revealed"). This is a three-party mutual attestation;
 * the honest terminal is "credit observed", NOT "final".
 */
export type WireRung = {
  /** The wire sub-state reached once this step is signed. */
  status: Exclude<WireStatus, "pending">;
  label: string;
  by: ExchangeRole;
  commits: string;
};

export const WIRE_RUNGS: readonly WireRung[] = [
  {
    status: "claimed",
    label: "Wire credit claimed",
    by: "seller",
    commits:
      "I observed an inbound wire credit carrying this deal's reference, for this amount bucket, at this terminal bank status. Here is a salted commitment to my receiving-bank record and an account nullifier: no bank name, no account number.",
  },
  {
    status: "observed",
    label: "Wire credit observed",
    by: "buyer",
    commits:
      "I countersign the seller's wire-credit claim. We mutually attest a payment with this reference was sent and observed. This is not proof a bank irrevocably credited it, and it can still be reversed.",
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

/** Human label for the wire sub-status. */
export function wireStatusLabel(status: WireStatus): string {
  switch (status) {
    case "pending":
      return "Awaiting the seller's wire-credit claim";
    case "claimed":
      return "Wire credit claimed, awaiting the buyer's countersign";
    case "observed":
      return "Wire credit observed (countersigned)";
    case "reversed":
      return "Wire credit reversed";
  }
}
