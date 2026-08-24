/**
 * scripts/migrate-buyer-tokens.ts
 *
 * Rewrite v1 buyer tokens (HMAC(SERVER_PEPPER, name), minted back when the
 * name crossed the wire) to v2 OPRF tokens ("v2:" + RFC 9497 output), so old
 * rows keep matching the tokens browsers now mint blind.
 *
 * How it can work at all: the server never stored a buyer name, so the only
 * names available are the PUBLIC known-buyer dropdown list (lib/buyers.ts).
 * For each of those names this script computes both generations of token,
 * entirely server-side, and rewrites rows whose stored token equals the v1
 * value. Rows minted from the "Other" free-text field cannot be migrated:
 * their names were never stored anywhere, which is the design working as
 * intended. They keep their v1 tokens and still match each other exactly,
 * they just never collide with a v2 token (the formats are disjoint).
 *
 * Idempotent: a second run finds zero v1 rows for the known list and
 * rewrites nothing.
 *
 * Local:  npm run migrate:buyer-tokens
 * Prod:   npm run gen:schema
 *         SERVER_PEPPER=... TURSO_DATABASE_URL=libsql://... TURSO_AUTH_TOKEN=... \
 *           node scripts/migrate-buyer-tokens.ts
 *
 * Both token generations derive from SERVER_PEPPER, so the pepper MUST be
 * the target environment's pepper or the script would quietly rewrite rows
 * to tokens no browser will ever reproduce. Two guards against that:
 * a remote database with no SERVER_PEPPER set refuses to run, and setting
 * VOPRF_PUBKEY_URL (e.g. https://<deployment>/api/voprf/pubkey) makes the
 * script fetch the deployment's published key and abort on any mismatch
 * with the key it derived locally.
 */

import { closeDb, getDb } from "../lib/db.ts";
import { buyerToken, isUsingDevPepper } from "../lib/crypto.ts";
import { KNOWN_BUYERS } from "../lib/buyers.ts";
import { buyerChip } from "../lib/voprf.ts";
import {
  getVoprfPublicKeyHex,
  serverMintBuyerTokenV2,
} from "../app/api/voprf/server.ts";

async function main() {
  const remote = Boolean(process.env.TURSO_DATABASE_URL);
  if (remote && !process.env.SERVER_PEPPER) {
    console.error(
      "Refusing: TURSO_DATABASE_URL is set but SERVER_PEPPER is not. " +
        "Migrating a remote database with the dev pepper would write garbage tokens.",
    );
    process.exit(1);
  }
  if (isUsingDevPepper()) {
    console.warn("note: running with the dev pepper (local database mode)");
  }

  const localPubkey = await getVoprfPublicKeyHex();
  console.log(`voprf public key (derived here): ${localPubkey}`);

  const pubkeyUrl = process.env.VOPRF_PUBKEY_URL;
  if (pubkeyUrl) {
    const res = await fetch(pubkeyUrl);
    if (!res.ok) {
      console.error(`Refusing: ${pubkeyUrl} answered ${res.status}.`);
      process.exit(1);
    }
    const remoteKey = ((await res.json()) as { publicKey?: string }).publicKey;
    if (remoteKey !== localPubkey) {
      console.error(
        "Refusing: the deployment's published VOPRF key does not match the " +
          "one derived from this SERVER_PEPPER. Wrong pepper for this target.",
      );
      process.exit(1);
    }
    console.log("voprf public key matches the deployment. Proceeding.");
  }

  const db = await getDb();
  let askTotal = 0;
  let dealTotal = 0;

  for (const name of KNOWN_BUYERS) {
    const v1 = buyerToken(name); // legacy HMAC, computable only server-side
    const v2 = await serverMintBuyerTokenV2(name);

    const asks = await db.execute({
      sql: `UPDATE asks SET buyer_token = ? WHERE buyer_token = ?`,
      args: [v2, v1],
    });
    const deals = await db.execute({
      sql: `UPDATE deals SET buyer_token = ? WHERE buyer_token = ?`,
      args: [v2, v1],
    });
    askTotal += asks.rowsAffected;
    dealTotal += deals.rowsAffected;
    // Chips only in the log. The name -> token pairing is exactly what this
    // console must not become a durable record of, so: chips.
    console.log(
      `#${buyerChip(v1)} -> #${buyerChip(v2)}  asks ${asks.rowsAffected}, deals ${deals.rowsAffected}`,
    );
  }

  const leftoverAsks = await db.execute(
    `SELECT COUNT(*) AS n FROM asks WHERE buyer_token NOT LIKE 'v2:%'`,
  );
  const leftoverDeals = await db.execute(
    `SELECT COUNT(*) AS n FROM deals WHERE buyer_token NOT LIKE 'v2:%'`,
  );

  console.log(`rewritten: ${askTotal} asks, ${dealTotal} deals`);
  console.log(
    `left as v1 (off-list names, never stored, still match each other): ` +
      `${leftoverAsks.rows[0]?.n} asks, ${leftoverDeals.rows[0]?.n} deals`,
  );
  closeDb();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
