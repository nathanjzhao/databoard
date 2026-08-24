/**
 * app/api/voprf/server.ts
 *
 * The server half of the blinded buyer-token protocol (RFC 9497 VOPRF,
 * ristretto255-SHA512). Everything that touches the secret evaluation key
 * lives in this one file. The isomorphic half (normalization, input and
 * token encoding, the browser's blind/verify/unblind) is lib/voprf.ts.
 *
 * The key is not stored anywhere: it is re-derived on every cold start from
 * SERVER_PEPPER via HKDF (lib/crypto.ts voprfKeySeed) and RFC 9497
 * DeriveKeyPair, so it is a pure function of the one secret the deployment
 * already holds, and every instance of an environment agrees on it.
 *
 * Honesty note, same as everywhere: whoever holds this key can evaluate the
 * short list of plausible lab names offline and recognize their tokens on
 * the board. The protocol guarantees the server never RECEIVES a name, and
 * that clients can PROVE the same key answered everyone (DLEQ). It cannot
 * guarantee the operator amnesia about a fourteen-entry dictionary.
 *
 * Imports use relative .ts paths, not "@/", so plain node scripts
 * (scripts/seed.ts, scripts/migrate-buyer-tokens.ts) can load this module
 * with type stripping, exactly like lib/*.
 */

import {
  Oprf,
  VOPRFServer,
  EvaluationRequest,
  deriveKeyPair,
} from "@cloudflare/voprf-ts";
import { CryptoNoble } from "@cloudflare/voprf-ts/crypto-noble";
import { voprfKeySeed } from "../../../lib/crypto.ts";
import {
  VOPRF_SUITE,
  VOPRF_HKDF_LABEL,
  bytesToHex,
  hexToBytes,
  normalizeBuyer,
  oprfBuyerInput,
  outputToBuyerToken,
} from "../../../lib/voprf.ts";

type VoprfState = { server: VOPRFServer; publicKeyHex: string };

/**
 * Derive once per process; dev reloads and serverless container reuse both
 * land on the cached promise. A failed derivation clears itself so the next
 * request retries instead of caching a poisoned promise (same pattern as
 * lib/db.ts).
 *
 * Only INERT bytes are cached on globalThis. Next compiles the RSC page
 * layer (/transparency imports this module) and the route-handler layer as
 * separate module registries with their OWN copies of @noble/curves, so a
 * VOPRFServer instance built in one layer fails `instanceof RistrettoPoint`
 * checks in the other ("RistrettoPoint expected"). The server object is
 * therefore cached per module registry and rebuilt from the shared key
 * bytes; DeriveKeyPair is deterministic, so every registry holds the same
 * key either way.
 */
type VoprfKeys = { privateKeyHex: string; publicKeyHex: string };

const globalForVoprf = globalThis as unknown as {
  __dataBoardVoprfKeys?: Promise<VoprfKeys>;
};

function getVoprfKeys(): Promise<VoprfKeys> {
  if (!globalForVoprf.__dataBoardVoprfKeys) {
    globalForVoprf.__dataBoardVoprfKeys = (async () => {
      const seed = voprfKeySeed();
      const info = new TextEncoder().encode(VOPRF_HKDF_LABEL);
      const { privateKey, publicKey } = await deriveKeyPair(
        Oprf.Mode.VOPRF,
        VOPRF_SUITE,
        seed,
        info,
        CryptoNoble,
      );
      return {
        privateKeyHex: bytesToHex(privateKey),
        publicKeyHex: bytesToHex(publicKey),
      };
    })().catch((err) => {
      globalForVoprf.__dataBoardVoprfKeys = undefined;
      throw err;
    });
  }
  return globalForVoprf.__dataBoardVoprfKeys;
}

/** Per-module-registry server instance; see the cache note above. */
let voprfStateHere: Promise<VoprfState> | null = null;

function getVoprf(): Promise<VoprfState> {
  if (!voprfStateHere) {
    voprfStateHere = (async () => {
      const { privateKeyHex, publicKeyHex } = await getVoprfKeys();
      return {
        server: new VOPRFServer(VOPRF_SUITE, hexToBytes(privateKeyHex), CryptoNoble),
        publicKeyHex,
      };
    })().catch((err) => {
      voprfStateHere = null;
      throw err;
    });
  }
  return voprfStateHere;
}

/**
 * The public key clients verify DLEQ proofs against. Published by
 * GET /api/voprf/pubkey and printed on /transparency, so anyone can check
 * that the key answering them is the key everyone else sees.
 */
export async function getVoprfPublicKeyHex(): Promise<string> {
  return (await getVoprf()).publicKeyHex;
}

export class BadEvaluationRequestError extends Error {}

/** Wire caps: one 32-byte element plus a 2-byte count, hex encoded. */
const MAX_EVALREQ_HEX = 128;

/**
 * Evaluate one blinded element and return the serialized evaluation, which
 * carries the DLEQ proof. The input here is a uniformly random-looking curve
 * point: there is nothing to log, store, or recognize, and this function
 * does none of the three.
 */
export async function evaluateBlindedBuyer(
  evalReqHex: string,
): Promise<{ evaluationHex: string; publicKeyHex: string }> {
  if (typeof evalReqHex !== "string" || evalReqHex.length > MAX_EVALREQ_HEX) {
    throw new BadEvaluationRequestError("Blinded request is malformed.");
  }
  let req: EvaluationRequest;
  try {
    req = EvaluationRequest.deserialize(
      VOPRF_SUITE,
      hexToBytes(evalReqHex),
      CryptoNoble,
    );
  } catch {
    throw new BadEvaluationRequestError("Blinded request is malformed.");
  }
  if (req.blinded.length !== 1) {
    // The compose flow needs exactly one. Refusing batches keeps the rate
    // limit meaningful instead of 30 requests times N inputs each.
    throw new BadEvaluationRequestError("One blinded element per request.");
  }
  const { server, publicKeyHex } = await getVoprf();
  const evaluation = await server.blindEvaluate(req);
  return { evaluationHex: bytesToHex(evaluation.serialize()), publicKeyHex };
}

/**
 * Direct (unblinded) evaluation of a buyer NAME into its v2 token. RFC 9497
 * guarantees this equals what a client gets from blind/evaluate/finalize on
 * the same input, which is the whole point of an OPRF being a PRF.
 *
 * This function sees a name, so its callers are restricted to the two
 * trusted server-side paths that iterate the PUBLIC known-buyer list:
 * scripts/seed.ts and scripts/migrate-buyer-tokens.ts. No request handler
 * may call it; the HTTP surface only ever accepts blinded points.
 */
export async function serverMintBuyerTokenV2(rawName: string): Promise<string> {
  const normalized = normalizeBuyer(rawName);
  if (!normalized) throw new Error("Buyer name is empty once normalized.");
  const { server } = await getVoprf();
  const output = await server.evaluate(oprfBuyerInput(normalized));
  return outputToBuyerToken(output);
}
