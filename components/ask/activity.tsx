/**
 * components/ask/activity.tsx
 *
 * The autoclose clock, as viewers see it (the owner's countdown and the
 * "Still ongoing" button live in owner-controls.tsx):
 *
 *   AutoCloseNotice  on an ask the cron closed, says so in plain words.
 *                    Renders nothing everywhere else, including asks the
 *                    owner closed themselves.
 *   LastUpdate       the poster's most recent "Still ongoing" note, with
 *                    its timestamp. Renders nothing when no note was ever
 *                    written.
 *
 * Both are self-contained async server components: they take an ask id and
 * fetch their own rows (lib/autoclose.ts), so the ask page composes them
 * without carrying their data plumbing.
 */

import { getAskActivity, getAskClosure } from "@/lib/autoclose";
import { timeAgo } from "@/components/ask/format";

export async function AutoCloseNotice({ askId }: { askId: string }) {
  const closure = await getAskClosure(askId);
  if (!closure || closure.reason !== "auto_stale") return null;
  return (
    <div className="mt-6 border-l-2 border-ink-ghost bg-panel px-4 py-3">
      <p className="text-[0.8125rem] leading-relaxed text-ink-dim">
        Closed automatically after 7 days without an update
        <span className="font-mono text-[0.6875rem] text-ink-ghost">
          {" "}
          · {timeAgo(closure.closedAt)}
        </span>
        . The poster stopped affirming it; the record stays, and the poster
        is still reachable through it.
      </p>
    </div>
  );
}

export async function LastUpdate({ askId }: { askId: string }) {
  const activity = await getAskActivity(askId);
  if (!activity || activity.note.length === 0) return null;
  return (
    <div className="mt-8">
      <div className="bt-label">
        Last update{" "}
        <span className="font-mono normal-case tracking-normal text-ink-ghost">
          · {timeAgo(activity.affirmedAt)}
        </span>
      </div>
      <p className="mt-3 max-w-[68ch] whitespace-pre-line border-l-2 border-rule pl-3 text-[0.875rem] leading-relaxed text-ink-dim">
        {activity.note}
      </p>
    </div>
  );
}
