/**
 * components/admin/signals-panel.tsx
 *
 * The /admin graph-analytics panel. Server component: /admin has already done
 * the operator check before rendering this, so it reads the signals directly
 * through lib/graph-signals.ts and renders the same ranked lists
 * /api/admin/signals serves. Every figure is a count or a nearest-$10k bucket;
 * no exact dollars, no buyer names, no PII beyond the handles the board shows.
 *
 * These are RISK SIGNALS FOR REVIEW, not automated penalties. The panel says
 * so, once, at the top, because a list of flagged accounts reads as an
 * accusation unless it is told not to.
 */

import { computeGraphSignals } from "@/lib/graph-signals";

export async function SignalsPanel() {
  const { feeSink, sock, remainderOutlier } = await computeGraphSignals();

  return (
    <div className="border border-rule bg-panel">
      <div className="border-b border-rule px-5 py-3">
        <span className="bt-label">Graph signals</span>
        <p className="mt-1.5 max-w-[62ch] text-[0.75rem] leading-relaxed text-ink-faint">
          Shapes worth a look, computed from the invite graph and the deals
          ledger. Counts and nearest-$10k buckets only. These are signals for a
          human to read, not automatic penalties: nothing here hides an ask,
          gates a poster, or docks reputation.
        </p>
      </div>

      <div className="divide-y divide-rule">
        {/* --------------------------------------------------- fee-sink */}
        <Section
          title="Fee-sink"
          count={feeSink.length}
          blurb="Named on many confirmed deals with large recorded volume while sitting at or near the invite root, where a whole downline's fees also flow up."
          empty="No account is pooling volume near the root."
        >
          {feeSink.map((r) => (
            <Row key={r.username} label={`@${r.username}`}>
              <Stat value={String(r.dealsNamedOn)} unit="deals" />
              <Stat value={r.recordedShareBucket} unit="recorded" />
              <Stat
                value={r.isRoot ? "root" : `depth ${r.ancestorDepth}`}
                unit="in tree"
                warn={r.ancestorDepth <= 1}
              />
            </Row>
          ))}
        </Section>

        {/* ------------------------------------------------------- sock */}
        <Section
          title="Sock"
          count={sock.length}
          blurb="Fresh accounts whose only footprint is confirming one reporter's deals: no deals of their own, no asks, every confirmation on the same reporter."
          empty="No fresh single-reporter confirmers."
        >
          {sock.map((r) => (
            <Row key={r.username} label={`@${r.username}`}>
              <Stat value={`${r.ageDays}d`} unit="old" warn={r.ageDays <= 2} />
              <Stat value={String(r.confirmations)} unit="confirms" />
              <Stat value={`@${r.soleReporterUsername}`} unit="sole reporter" />
              {r.sybilRelatedToReporter ? (
                <span className="bg-amber-wash px-1.5 py-0.5 font-mono text-[0.625rem] text-amber">
                  in reporter&apos;s tree
                </span>
              ) : null}
            </Row>
          ))}
        </Section>

        {/* ------------------------------------------- remainder outlier */}
        <Section
          title="Remainder outlier"
          count={remainderOutlier.length}
          blurb="Reporters whose deals leak value away from anyone the board can charge, or whose splits land on the total exactly a suspicious number of times."
          empty="No reporter's splits stand out."
        >
          {remainderOutlier.map((r) => (
            <Row key={r.username} label={`@${r.username}`}>
              <Stat value={String(r.reportedDeals)} unit="reported" />
              <Stat
                value={`${Math.round(r.unallocatedRatioBps / 100)}%`}
                unit="unallocated"
                warn={r.unallocatedRatioBps >= 5000}
              />
              <Stat
                value={String(r.exactSplitDeals)}
                unit="exact splits"
                warn={r.exactSplitDeals >= 2}
              />
            </Row>
          ))}
        </Section>
      </div>
    </div>
  );
}

function Section({
  title,
  count,
  blurb,
  empty,
  children,
}: {
  title: string;
  count: number;
  blurb: string;
  empty: string;
  children: React.ReactNode;
}) {
  return (
    <div className="px-5 py-4">
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-[0.8125rem] font-medium text-ink">{title}</span>
        <span className="font-mono text-[0.6875rem] text-amber">{count}</span>
      </div>
      <p className="mt-1 max-w-[62ch] text-[0.75rem] leading-relaxed text-ink-faint">
        {blurb}
      </p>
      {count === 0 ? (
        <p className="mt-2 text-[0.75rem] text-ink-ghost">{empty}</p>
      ) : (
        <ul className="mt-3 divide-y divide-rule border border-rule bg-void">{children}</ul>
      )}
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <li className="flex flex-wrap items-baseline gap-x-4 gap-y-1 px-3 py-2">
      <span className="font-mono text-[0.8125rem] text-ink">{label}</span>
      {children}
    </li>
  );
}

function Stat({
  value,
  unit,
  warn,
}: {
  value: string;
  unit: string;
  warn?: boolean;
}) {
  return (
    <span className="text-[0.75rem]">
      <span
        className={[
          "font-mono tabular-nums",
          warn ? "text-amber" : "text-ink-dim",
        ].join(" ")}
      >
        {value}
      </span>{" "}
      <span className="text-ink-ghost">{unit}</span>
    </span>
  );
}
