/**
 * components/exchange/types.ts
 *
 * The wire shape of a session as the API returns it and the client renders it.
 * Kept in a pure module (no server imports) so both the server store and the
 * browser stepper can share one definition without dragging database code into
 * the client bundle.
 */

import type { ExchangeRole, ExchangeState, StoredEvent } from "@/lib/exchange";

/** What GET /api/exchange/[id] returns: the session, its chain, the viewer's role. */
export type SessionView = {
  id: string;
  dealId: string;
  state: ExchangeState;
  seller: string;
  buyer: string;
  sellerSigningPubkey: string;
  buyerSigningPubkey: string | null;
  yourRole: ExchangeRole;
  chunkCount: number;
  chunkSize: number;
  sizeBucket: string;
  plaintextRoot: string;
  ciphertextRoot: string;
  dekCommit: string;
  headSeq: number;
  headHash: string;
  hasDemoBlob: boolean;
  demoBlobLen: number;
  events: StoredEvent[];
  createdAt: number;
  updatedAt: number;
};
