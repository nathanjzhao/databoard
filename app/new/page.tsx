/**
 * /new
 *
 * The compose page. The form itself is a client component; this wrapper does
 * the real session check and the database-not-configured fallback, and sets
 * the frame around the docket.
 */

import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { DbNotConfiguredNotice, PageStub } from "@/components/page-stub";
import { AskForm } from "@/components/ask/ask-form";
import { getSessionUser } from "@/lib/auth";
import { isDbConfigured } from "@/lib/db";

export const metadata: Metadata = { title: "Post an ask" };
export const dynamic = "force-dynamic";

export default async function NewAskPage() {
  if (!isDbConfigured()) {
    return (
      <PageStub
        eyebrow="Compose"
        title="Post an ask."
        blurb="Describe what you need, who it is for, and how much of it you already have."
      >
        <DbNotConfiguredNotice />
      </PageStub>
    );
  }

  const user = await getSessionUser();
  if (!user) redirect("/gate");

  return (
    <div className="mx-auto w-full max-w-[1180px] px-5 py-12">
      <div className="max-w-[62ch]">
        <div className="bt-label">Compose</div>
        <h1 className="bt-display mt-3 text-[2.5rem] leading-[1.05] text-ink">
          Post an ask.
        </h1>
        <p className="mt-4 text-[0.9375rem] leading-relaxed text-ink-dim">
          What you need, what shape it takes, and who it is for.
        </p>
      </div>

      <div className="mt-10">
        <AskForm />
      </div>
    </div>
  );
}
