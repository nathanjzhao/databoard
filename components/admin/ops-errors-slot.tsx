/**
 * components/admin/ops-errors-slot.tsx
 *
 * The /admin server-errors panel. Server component: /admin has already done
 * the operator check before rendering this, so it reads ops_errors directly
 * through lib/ops.ts and renders the same sanitized rows /api/admin/errors
 * serves. Rows are pathname-only routes and scrubbed, capped text by
 * construction (the write site in lib/ops.ts is the single place that
 * enforces it); this panel adds nothing and filters nothing.
 */

import { timeAgo } from "@/components/ask/format";
import { listRecentErrors } from "@/lib/ops";

const PANEL_LIMIT = 50;

export async function OpsErrorsSlot() {
  const errors = await listRecentErrors(PANEL_LIMIT);
  const nowMs = Date.now();

  return (
    <div className="border border-rule bg-panel">
      <div className="flex items-baseline justify-between border-b border-rule px-5 py-3">
        <span className="bt-label">Server errors</span>
        <span className="font-mono text-[0.6875rem] text-amber">{errors.length}</span>
      </div>

      {errors.length === 0 ? (
        <p className="px-5 py-4 text-[0.8125rem] leading-relaxed text-ink-faint">
          Nothing captured in the last 30 days. Rows appear here when a
          render, route or action throws; each is sampled per digest and holds
          no request bodies, headers or user attribution.
        </p>
      ) : (
        <ul className="divide-y divide-rule">
          {errors.map((e) => (
            <li key={e.id} className="px-5 py-3.5">
              <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <span className="font-mono text-[0.8125rem] text-ink">{e.route}</span>
                <span className="font-mono text-[0.6875rem] text-ink-ghost">
                  {e.kind} · {e.digest.slice(0, 12)} · {timeAgo(e.at, nowMs)}
                </span>
              </div>
              <p className="mt-1 break-words font-mono text-[0.75rem] leading-relaxed text-ink-dim">
                {e.message}
              </p>
              {e.stack ? (
                <details className="mt-1.5">
                  <summary className="cursor-pointer text-[0.6875rem] text-ink-faint hover:text-ink">
                    stack
                  </summary>
                  <pre className="mt-1.5 overflow-x-auto border border-rule bg-void px-3 py-2 font-mono text-[0.6875rem] leading-relaxed text-ink-faint">
                    {e.stack}
                  </pre>
                </details>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
