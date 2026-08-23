/**
 * The right-rail audit instruments: a live column scan of the running
 * database, the live table list, and the deployment's honesty flags (demo
 * codes, dev pepper, database presence). All data is computed server-side in
 * app/transparency/page.tsx and passed down, so this stays a dumb renderer.
 */

export type TableColumns = { table: string; columns: string[] };

export function LiveStatus({
  dbLive,
  columns,
  offenders,
  demoMode,
  devPepper,
}: {
  dbLive: boolean;
  columns: TableColumns[];
  offenders: string[];
  demoMode: boolean;
  devPepper: boolean;
}) {
  return (
    <div className="space-y-8">
      <div>
        <h2 className="bt-label border-b border-rule-strong pb-2 text-ink-dim">
          Live column scan
        </h2>
        {dbLive ? (
          <div
            className={[
              "mt-3 border-l-2 px-3 py-2.5 text-[0.8125rem] leading-relaxed",
              offenders.length
                ? "border-red bg-red-wash text-ink"
                : "border-green bg-green-wash text-ink",
            ].join(" ")}
          >
            {offenders.length
              ? `Columns that look like contact data: ${offenders.join(", ")}`
              : "No column in the running database is named for a phone number, an email address, a real name, an org, or a buyer."}
          </div>
        ) : (
          <div className="mt-3 border-l-2 border-amber bg-amber-wash px-3 py-2.5 text-[0.8125rem] leading-relaxed text-ink">
            Database not configured on this deployment, so there is nothing
            live to scan. The schema on the left is still exactly what would
            run.
          </div>
        )}
        <p className="mt-2 text-[0.6875rem] leading-relaxed text-ink-faint">
          The scan greps live column names for phone, email, mail, real_name,
          org_name, buyer_name and lab_name. A name check cannot catch a
          maliciously mislabeled column; reading the schema can, which is why
          it is printed in full.
        </p>
      </div>

      {dbLive ? (
        <div>
          <h2 className="bt-label border-b border-rule-strong pb-2 text-ink-dim">
            Tables in the live database
          </h2>
          <ul className="mt-3 space-y-3">
            {columns.map((t) => (
              <li key={t.table}>
                <div className="font-mono text-[0.8125rem] text-amber">
                  {t.table}
                </div>
                <div className="mt-1 font-mono text-[0.6875rem] leading-relaxed text-ink-faint">
                  {t.columns.join(", ")}
                </div>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <div>
        <h2 className="bt-label border-b border-rule-strong pb-2 text-ink-dim">
          Deployment state
        </h2>
        <dl className="mt-3 space-y-2 text-[0.8125rem]">
          <Row
            k="Verification codes"
            v={demoMode ? "demo mode, shown on screen" : "sent out of band"}
            warn={demoMode}
          />
          <Row
            k="Server pepper"
            v={devPepper ? "checked-in dev value" : "set from the environment"}
            warn={devPepper}
          />
          <Row
            k="Database"
            v={dbLive ? "connected" : "not configured"}
            warn={!dbLive}
          />
        </dl>
        <p className="mt-2 text-[0.6875rem] leading-relaxed text-ink-faint">
          Amber rows are demo-deployment states, flagged here rather than
          hidden. A production deployment should show none.
        </p>
      </div>
    </div>
  );
}

function Row({ k, v, warn }: { k: string; v: string; warn?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-b border-rule pb-2">
      <dt className="text-ink-faint">{k}</dt>
      <dd className={warn ? "text-right text-amber" : "text-right text-ink-dim"}>
        {v}
      </dd>
    </div>
  );
}
