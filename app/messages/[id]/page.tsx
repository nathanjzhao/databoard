/**
 * /messages/[id]
 *
 * One thread. The server hands the client component a fully loaded thread
 * (which also marks it read); the client polls for the rest. A thread the
 * viewer is not in 404s, indistinguishable from one that does not exist.
 */

import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { DbNotConfiguredNotice, PageStub } from "@/components/page-stub";
import { ThreadView } from "@/components/messages/thread-view";
import { getSessionUser } from "@/lib/auth";
import { isDbConfigured } from "@/lib/db";
import { loadThread } from "@/app/api/threads/store";

export const metadata: Metadata = { title: "Thread" };
export const dynamic = "force-dynamic";

export default async function ThreadPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  if (!isDbConfigured()) {
    return (
      <PageStub
        eyebrow="Messages"
        title="Talk without swapping contact details."
        blurb="Threads live on the board; nothing here ties a username to a phone number or an inbox."
      >
        <DbNotConfiguredNotice />
      </PageStub>
    );
  }

  const user = await getSessionUser();
  if (!user) redirect("/gate");

  const { id } = await params;
  const thread = await loadThread(id, user.id, 0);
  if (!thread) notFound();

  return (
    <div className="mx-auto w-full max-w-[860px] px-5 py-10">
      <ThreadView initial={thread} viewer={user.username} />
    </div>
  );
}
