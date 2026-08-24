/**
 * lib/voprf.ts
 *
 * Blinded buyer tokens, version 2: RFC 9497 VOPRF over ristretto255-SHA512.
 *
 * v1 tokens were HMAC(SERVER_PEPPER, normalized name), which meant the buyer
 * name crossed the wire in the clear and the server promised to forget it.
 * v2 removes the promise: the browser BLINDS the normalized name into a
 * random-looking curve point, the server multiplies that point by its secret
 * VOPRF key without ever seeing the name, and the browser unblinds the result
 * into the final token. The server's reply carries a DLEQ proof against its
 * published public key, so the client can VERIFY that the same key produced
 * this evaluation as every other one. Same name, same key, same token, and a
 * server that answers with a different key gets caught by the proof check.
 *
 * What this does NOT fix, stated plainly: the operator still holds the OPRF
 * key and can evaluate the small dictionary of plausible lab names offline,
 * then read the board. That is the RFC 9497 small-input-space caveat and no
 * OPRF removes it. What it removes is the wire: no request anywhere in this
 * app carries a buyer name any more, blinded or otherwise, except as the
 * blinded point the server cannot invert.
 *
 * This module is isomorphic. The pure helpers at the top run anywhere; the
 * minting function below runs in the browser and loads @cloudflare/voprf-ts
 * lazily so display-only importers do not pay for the crypto bundle. The
 * server-side key and evaluation live in app/api/voprf/server.ts, which this
 * file never imports.
 */

import type { SuiteID } from "@cloudflare/voprf-ts";

/* ------------------------------------------------------ protocol constants */

/** RFC 9497 ciphersuite: prime-order ristretto255 group, SHA-512. */
export const VOPRF_SUITE: SuiteID = "ristretto255-SHA512";

/** HKDF info label the server key is derived under. Printed on /transparency. */
export const VOPRF_HKDF_LABEL = "databoard-voprf-v1";

/** Storage prefix for OPRF-minted tokens; v1 HMAC rows have no prefix. */
export const BUYER_TOKEN_V2_PREFIX = "v2:";

/**
 * App-level domain separator prepended to the OPRF input, mirroring the
 * `domain + "\x1f" + value` shape lib/crypto.ts uses for HMACs, so a buyer
 * token can never collide with any other OPRF use this app might grow.
 */
export const VOPRF_INPUT_DOMAIN = "databoard-buyer-v2";

/** Exact shape of a stored v2 token: prefix + hex of the 64-byte output. */
const TOKEN_V2_RE = /^v2:[0-9a-f]{128}$/;

export function isBuyerTokenV2(token: string): boolean {
  return TOKEN_V2_RE.test(token ?? "");
}

/* ---------------------------------------------------------- pure helpers */

/**
 * Casefold, collapse whitespace, drop punctuation, so "Open AI" == "OpenAI".
 * Canonical home of the rule; lib/crypto.ts re-exports it for the server.
 * It must be byte-identical on both sides or equal names stop matching.
 */
export function normalizeBuyer(raw: string): string {
  return (raw ?? "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "")
    .trim();
}

/** The OPRF input bytes for a normalized buyer name. */
export function oprfBuyerInput(normalized: string): Uint8Array {
  return new TextEncoder().encode(VOPRF_INPUT_DOMAIN + "\x1f" + normalized);
}

/** A finalized OPRF output becomes the stored token: "v2:" + hex. */
export function outputToBuyerToken(output: Uint8Array): string {
  return BUYER_TOKEN_V2_PREFIX + bytesToHex(output);
}

/**
 * The four hex characters every surface shows as "Buyer #xxxx". Works for
 * both generations: v1 tokens are bare hex, v2 tokens carry the prefix,
 * and the chip is always the first four hex characters after it.
 */
export function buyerChip(token: string): string {
  const t = token ?? "";
  return (t.startsWith(BUYER_TOKEN_V2_PREFIX)
    ? t.slice(BUYER_TOKEN_V2_PREFIX.length)
    : t
  ).slice(0, 4);
}

export function bytesToHex(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += b.toString(16).padStart(2, "0");
  return s;
}

export function hexToBytes(hex: string): Uint8Array {
  if (typeof hex !== "string" || hex.length % 2 !== 0 || !/^[0-9a-f]*$/.test(hex)) {
    throw new Error("Expected lowercase hex.");
  }
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/* ------------------------------------------------------ client-side mint */

type PubkeyReply = {
  suite?: string;
  publicKey?: string;
};

/**
 * One fetch of the server's published VOPRF public key per page load,
 * shared across mints. Reset on failure so a flaky request can retry.
 */
let pubkeyPromise: Promise<{ suite: string; publicKeyHex: string }> | null = null;

async function fetchServerPubkey(): Promise<{ suite: string; publicKeyHex: string }> {
  if (!pubkeyPromise) {
    pubkeyPromise = (async () => {
      const res = await fetch("/api/voprf/pubkey", { cache: "no-store" });
      if (!res.ok) throw new Error("Could not load the blinding public key.");
      const data = (await res.json()) as PubkeyReply;
      const publicKeyHex = data.publicKey ?? "";
      if (data.suite !== VOPRF_SUITE || !/^[0-9a-f]{64}$/.test(publicKeyHex)) {
        throw new Error("The blinding public key looks malformed. Refusing to send.");
      }
      return { suite: data.suite, publicKeyHex };
    })().catch((err) => {
      pubkeyPromise = null;
      throw err;
    });
  }
  return pubkeyPromise;
}

/**
 * The whole client side of the protocol, in order:
 *
 *   1. normalize the name locally (same rule the v1 server used),
 *   2. blind it: input -> curve point, multiplied by a random scalar
 *      that never leaves this tab,
 *   3. POST only the blinded point to /api/voprf/evaluate,
 *   4. VERIFY the DLEQ proof in the reply against the published public
 *      key; a reply signed with any other key throws here,
 *   5. unblind and hash to the final token, "v2:" + 128 hex chars.
 *
 * The name is never an argument to fetch(). If any step fails, the caller
 * gets an error and nothing was submitted; there is no plaintext fallback.
 */
export async function mintBuyerTokenV2(rawName: string): Promise<string> {
  const normalized = normalizeBuyer(rawName);
  if (!normalized) throw new Error("Buyer name is empty once normalized.");

  // Loaded on first use so the board and forms do not carry the crypto
  // library until someone actually submits.
  const [{ VOPRFClient, Evaluation }, { CryptoNoble }] = await Promise.all([
    import("@cloudflare/voprf-ts"),
    import("@cloudflare/voprf-ts/crypto-noble"),
  ]);

  const { publicKeyHex } = await fetchServerPubkey();
  const client = new VOPRFClient(VOPRF_SUITE, hexToBytes(publicKeyHex), CryptoNoble);

  const [finData, evalReq] = await client.blind([oprfBuyerInput(normalized)]);

  const res = await fetch("/api/voprf/evaluate", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ evalReq: bytesToHex(evalReq.serialize()) }),
  });
  const data = (await res.json().catch(() => ({}))) as {
    evaluation?: string;
    publicKey?: string;
    error?: string;
  };
  if (!res.ok || !data.evaluation) {
    throw new Error(data.error ?? "Blinded evaluation failed. Nothing was sent in the clear.");
  }
  if (data.publicKey && data.publicKey !== publicKeyHex) {
    // The evaluate endpoint claims a different key than the one it
    // published a moment ago. Do not even bother checking the proof.
    throw new Error("The server changed its blinding key mid-flight. Refusing the token.");
  }

  const evaluation = Evaluation.deserialize(
    VOPRF_SUITE,
    hexToBytes(data.evaluation),
    CryptoNoble,
  );

  let outputs: Uint8Array[];
  try {
    // finalize() verifies the DLEQ proof against publicKeyHex before
    // unblinding. This is the "same key for everyone" guarantee: a server
    // that evaluates you under a per-user key cannot produce this proof.
    outputs = await client.finalize(finData, evaluation);
  } catch {
    throw new Error(
      "The server's evaluation failed its consistency proof. Token refused; nothing was submitted.",
    );
  }
  return outputToBuyerToken(outputs[0]);
}
