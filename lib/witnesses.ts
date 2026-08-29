/**
 * lib/witnesses.ts
 *
 * The witness REGISTRY and the log's active witness key: the server-side
 * configuration half of the witness protocol. lib/witness.ts is the pure,
 * isomorphic protocol (verify + cosign); this module is where the process
 * reads its environment to answer two questions:
 *
 *   1. WHICH witnesses does a client recognize, and how many must cosign a head
 *      before it is trusted (the N-of-M quorum)? -> recognizedWitnesses(),
 *      witnessQuorumN(). Served publicly at /api/translog/witnesses so the
 *      browser verifier and scripts/verify-log.sh use the same list.
 *
 *   2. WHICH key does THIS process cosign with when it runs as a witness
 *      (scripts/witness.ts)? -> activeWitnessSeed(). A real deployment sets
 *      WITNESS_ED25519_SEED (a GitHub Actions secret, separate from the anchor
 *      job's credentials); dev/CI falls back to a checked-in dev key, exactly
 *      like the dev SERVER_PEPPER, so the suites are deterministic.
 *
 * HONEST DEFAULT. With no configuration, the registry recognizes exactly ONE
 * witness: the one whose key is the checked-in dev seed below, marked
 * `operator: true`. That is deliberately NOT independence -- it is a working
 * default whose only fork-resistance is "the operator's own witness would have
 * to double-sign". Real independence means adding EXTERNAL witnesses (people
 * who run scripts/witness.ts with their own secret key on their own infra) via
 * WITNESS_REGISTRY_JSON and raising N so 2N > M. docs/transparency-log/README
 * explains how a third party joins; the code makes it a config change, not a
 * code change.
 */

import { ed25519 } from "@noble/curves/ed25519.js";
import { bytesToHex } from "./merkle.ts";
import { witnessId, witnessSeedFromHex, type RecognizedWitness } from "./witness.ts";

/**
 * Dev-only witness key seed (32 bytes, hex). Real deployments set
 * WITNESS_ED25519_SEED. Checked in on purpose and clearly labelled, so CI and
 * local runs cosign deterministically with a key everyone can recompute -- a
 * cosignature from this key proves nothing about an independent party, exactly
 * like a dev-pepper log head. Not a secret; do not reuse it in production.
 */
const DEV_WITNESS_SEED_HEX =
  "d17e57000000000000000077697402772696746e6573732d6465762d6b657921";

/** Default human label for the log operator's own witness. */
const DEFAULT_OPERATOR_KEY_NAME = "databoard-witness-operator";

/** The dev witness public key hex, derived once from the checked-in seed. */
function devWitnessPublicKeyHex(): string {
  return bytesToHex(ed25519.getPublicKey(witnessSeedFromHex(DEV_WITNESS_SEED_HEX)));
}

/**
 * The seed this process cosigns with when it runs as a witness. Reads
 * WITNESS_ED25519_SEED (64 hex); dev/CI falls back to the checked-in dev seed,
 * and refuses that fallback in production the way lib/crypto refuses the dev
 * pepper. Returns the seed plus the label to stamp on cosignatures.
 */
export function activeWitnessSeed(): { seed: Uint8Array; keyName: string } {
  const env = process.env.WITNESS_ED25519_SEED;
  const keyName = process.env.WITNESS_KEY_NAME?.trim() || DEFAULT_OPERATOR_KEY_NAME;
  if (env && env.trim().length > 0) {
    return { seed: witnessSeedFromHex(env), keyName };
  }
  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "WITNESS_ED25519_SEED is not set. Refusing to run a witness with the checked-in dev key in production.",
    );
  }
  return { seed: witnessSeedFromHex(DEV_WITNESS_SEED_HEX), keyName };
}

/** True when the active witness key is still the checked-in dev seed. */
export function isUsingDevWitnessKey(): boolean {
  const env = process.env.WITNESS_ED25519_SEED;
  return !(env && env.trim().length > 0);
}

/**
 * The witnesses a client recognizes. WITNESS_REGISTRY_JSON, when set, is a JSON
 * array of { keyName, publicKey, operator?, url? }; otherwise the default is the
 * single operator-run dev witness above. Every entry's witnessId is recomputed
 * from its public key here, so the registry cannot lie about which key an id
 * stands for. Malformed entries are dropped, never trusted.
 */
export function recognizedWitnesses(): RecognizedWitness[] {
  const raw = process.env.WITNESS_REGISTRY_JSON?.trim();
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as Array<{
        keyName?: string;
        publicKey?: string;
        operator?: boolean;
        url?: string;
      }>;
      const out: RecognizedWitness[] = [];
      const seen = new Set<string>();
      for (const e of parsed) {
        const pk = (e.publicKey ?? "").trim().toLowerCase();
        if (!/^[0-9a-f]{64}$/.test(pk)) continue;
        const id = witnessId(pk);
        if (seen.has(id)) continue;
        seen.add(id);
        out.push({
          keyName: (e.keyName ?? "").trim() || `witness-${id.slice(0, 8)}`,
          publicKey: pk,
          witnessId: id,
          operator: e.operator === true,
          ...(e.url ? { url: e.url } : {}),
        });
      }
      if (out.length > 0) return out;
    } catch {
      // Fall through to the default rather than serving a broken registry.
    }
  }
  const pk = devWitnessPublicKeyHex();
  return [
    {
      keyName: DEFAULT_OPERATOR_KEY_NAME,
      publicKey: pk,
      witnessId: witnessId(pk),
      operator: true,
    },
  ];
}

/**
 * How many recognized cosignatures a client requires before trusting a head (N
 * in N-of-M). WITNESS_QUORUM_N overrides; default 1. Clamped to [1, M] so the
 * quorum is always reachable and never zero.
 */
export function witnessQuorumN(): number {
  const m = recognizedWitnesses().length;
  const env = Number(process.env.WITNESS_QUORUM_N);
  const n = Number.isInteger(env) && env > 0 ? env : 1;
  return Math.max(1, Math.min(n, Math.max(1, m)));
}
