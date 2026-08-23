/**
 * /messages
 *
 * The inbox. Server-renders the real thread list, then the client component
 * polls to stay current. Middleware already bounced cookie-less visitors;
 * getSessionUser() is the check that counts.
 */

import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { DbNotConfiguredNotice, PageStub } from "@/components/page-stub";
import { ThreadList } from "@/components/messages/thread-list";
import { getSessionUser } from "@/lib/auth";
import { isDbConfigured } from "@/lib/db";
import { listThreadsFor } from "@/app/api/threads/store";

export const metadata: Metadata = { title: "Messages" };
export const dynamic = "force-dynamic";

const EYEBROW = "Messages";
const TITLE = "Talk without swapping contact details.";
const BLURB =
  "Threads open when a collab request is accepted or a deal room forms; " +
  "nothing here ties anyone to a phone number or an inbox.";

export default async function MessagesPage({
  searchParams,
}: {
  searchParams: Promise<{ thread?: string | string[] }>;
}) {
  // Older links used /messages?thread=<id>; the thread page is /messages/<id>.
  const sp = await searchParams;
  const threadParam = Array.isArray(sp.thread) ? sp.thread[0] : sp.thread;
  if (threadParam) redirect(`/messages/${encodeURIComponent(threadParam)}`);

  if (!isDbConfigured()) {
    return (
      <PageStub eyebrow={EYEBROW} title={TITLE} blurb={BLURB}>
        <DbNotConfiguredNotice />
      </PageStub>
    );
  }

  const user = await getSessionUser();
  if (!user) redirect("/gate");

  const threads = await listThreadsFor(user.id);

  return (
    <PageStub eyebrow={EYEBROW} title={TITLE} blurb={BLURB}>
      <ThreadList initial={threads} />
    </PageStub>
  );
}
