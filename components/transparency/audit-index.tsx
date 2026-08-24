/**
 * "Audit it yourself": each load-bearing claim on this page, mapped to the
 * file where it is implemented, plus the raw endpoint for checking the schema
 * from a terminal. Paths are repo paths; the point is that every claim is a
 * grep away, not a policy PDF away.
 */

const CLAIMS: ReadonlyArray<{
  claim: string;
  files: ReadonlyArray<string>;
}> = [
  {
    claim: "The published schema is the running schema",
    files: [
      "db/schema.sql",
      "scripts/gen-schema-module.mjs",
      "lib/db.ts (getDb applies SCHEMA_SQL)",
    ],
  },
  {
    claim: "Verification stores nothing between request and echo",
    files: [
      "lib/verify.ts (issueChallenge, verifyChallenge)",
      "app/api/auth/request-code/route.ts",
      "app/api/auth/verify-and-signup/route.ts",
    ],
  },
  {
    claim: "Signup persists exactly four fields",
    files: ["lib/auth.ts (createUser)", "db/schema.sql (users)"],
  },
  {
    claim: "Contacts survive only as a keyed blind index",
    files: ["lib/crypto.ts (normalizeContact, contactBlindIndex)"],
  },
  {
    claim: "Buyer names are blinded in the browser, never sent",
    files: [
      "lib/voprf.ts (mintBuyerTokenV2)",
      "app/api/voprf/server.ts (evaluateBlindedBuyer)",
      "lib/buyers.ts",
    ],
  },
  {
    claim: "Sessions store a hash of the token, not the token",
    files: ["lib/auth.ts (createSession)", "db/schema.sql (sessions)"],
  },
  {
    claim: "The board is gated; this page is not",
    files: ["middleware.ts", "lib/gate.ts (isPublicPath)"],
  },
  {
    claim: "This page renders the same bytes the database applies",
    files: [
      "app/transparency/page.tsx",
      "app/api/transparency/schema/route.ts",
    ],
  },
];

export function AuditIndex({ schemaSha256 }: { schemaSha256: string }) {
  return (
    <div className="space-y-6">
      <div className="border border-rule bg-panel">
        <div className="grid grid-cols-1 border-b border-rule px-4 py-2.5 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
          <span className="bt-label">Claim</span>
          <span className="bt-label hidden sm:block">Where it lives</span>
        </div>
        <ul className="divide-y divide-rule">
          {CLAIMS.map((c) => (
            <li
              key={c.claim}
              className="grid grid-cols-1 gap-x-6 gap-y-1.5 px-4 py-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]"
            >
              <span className="text-[0.8438rem] leading-snug text-ink">
                {c.claim}
              </span>
              <span className="font-mono text-[0.6875rem] leading-relaxed text-ink-faint">
                {c.files.map((f) => (
                  <span key={f} className="block">
                    {f}
                  </span>
                ))}
              </span>
            </li>
          ))}
        </ul>
      </div>

      <div className="border border-rule bg-panel">
        <div className="border-b border-rule px-4 py-2.5">
          <span className="bt-label">From a terminal</span>
        </div>
        <div className="overflow-x-auto px-4 py-4 font-mono text-[0.75rem] leading-[1.9]">
          <div className="text-ink-dim">
            <span className="text-ink-ghost">$ </span>curl -s
            https://&lt;this-host&gt;/api/transparency/schema | shasum -a 256
          </div>
          <div className="break-all text-amber">{schemaSha256} &nbsp;-</div>
        </div>
        <div className="border-t border-rule px-4 py-3 text-[0.8125rem] leading-relaxed text-ink-faint">
          The endpoint returns db/schema.sql as text/plain, no session
          required. The hash above was computed server-side over the exact
          bytes rendered on this page, so the two should agree; if they ever
          do not, that is the finding.
        </div>
      </div>
    </div>
  );
}
