/**
 * /deals/new
 *
 * The record-a-deal form. Two prefill doors, both via query params:
 *
 *   ?thread=<id>            everyone else in that thread becomes a
 *                           participant row (membership checked server-side;
 *                           a thread the viewer is not in prefills nothing)
 *   ?participants=a,b       explicit usernames, e.g. from a future surface
 *   ?ask=<id>               preselects the linked ask
 *
 * The buyer name entered here is keyed and discarded by POST /api/deals; the
 * dollar figures are stored exactly, which the form says in as many words.
 */

import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { DbNotConfiguredNotice, PageStub } from "@/components/page-stub";
import { DealForm } from "@/components/deals/deal-form";
import { getSessionUser } from "@/lib/auth";
import { isDbConfigured } from "@/lib/db";
import { listLinkableAsks, threadCoParticipants } from "@/lib/deals";

export const metadata: Metadata = { title: "Record a deal" };
export const dynamic = "force-dynamic";

const EYEBROW = "Record a deal";
const TITLE = "Say what closed, and who was in it.";
const BLURB =
  "Name the buyer (keyed and discarded, like everywhere else), the total, " +
  "and the split. Everyone you name answers for their own share from their " +
  "own account, and the deal counts for nothing publicly until they do.";

function firstParam(v: string | string[] | undefined): string | null {
  if (Array.isArray(v)) return v[0] ?? null;
  return v ?? null;
}

export default async function NewDealPage({
  searchParams,
}: {
  searchParams: Promise<{
    thread?: string | string[];
    participants?: string | string[];
    ask?: string | string[];
  }>;
}) {
  if (!isDbConfigured()) {
    return (
      <PageStub eyebrow={EYEBROW} title={TITLE} blurb={BLURB}>
        <DbNotConfiguredNotice />
      </PageStub>
    );
  }

  const user = await getSessionUser();
  if (!user) redirect("/gate");

  const sp = await searchParams;
  const threadId = firstParam(sp.thread);
  const explicit = firstParam(sp.participants);
  const prefillAskId = firstParam(sp.ask);

  let prefill: string[] = [];
  if (threadId) {
    prefill = await threadCoParticipants(threadId, user.id);
  } else if (explicit) {
    prefill = explicit
      .split(",")
      .map((u) => u.trim().toLowerCase())
      .filter((u) => u.length > 0 && u !== user.username);
  }

  const linkableAsks = await listLinkableAsks(100);

  return (
    <PageStub eyebrow={EYEBROW} title={TITLE} blurb={BLURB}>
      <DealForm
        linkableAsks={linkableAsks}
        prefillParticipants={prefill}
        prefillAskId={prefillAskId}
      />
    </PageStub>
  );
}
