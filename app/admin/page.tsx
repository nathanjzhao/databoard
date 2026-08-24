/**
 * /admin
 *
 * The operator's desk. Only reachable with the operator flag; anyone else
 * who guesses the path gets the same 404 a wrong URL gets, so the page's
 * existence is not an answer to a probe. Today it holds the hidden-asks
 * ledger and the mount point for the ops error panel.
 */

import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { DbNotConfiguredNotice, PageStub } from "@/components/page-stub";
import { HiddenList } from "@/components/admin/hidden-list";
import { OpsErrorsSlot } from "@/components/admin/ops-errors-slot";
import { getSessionUser } from "@/lib/auth";
import { isDbConfigured } from "@/lib/db";
import { isOperator, listHidden } from "@/lib/moderation";

export const metadata: Metadata = { title: "Admin" };
export const dynamic = "force-dynamic";

export default async function AdminPage() {
  if (!isDbConfigured()) {
    return (
      <PageStub eyebrow="Admin" title="The operator's desk." blurb="">
        <DbNotConfiguredNotice />
      </PageStub>
    );
  }

  const user = await getSessionUser();
  if (!user) redirect("/gate");
  if (!(await isOperator(user.id))) notFound();

  const hidden = await listHidden();

  return (
    <div className="mx-auto w-full max-w-[880px] px-5 py-12">
      <div className="bt-label">Admin</div>
      <h1 className="bt-display mt-3 text-[2.25rem] leading-[1.08] text-ink">
        The operator&apos;s desk.
      </h1>
      <p className="mt-4 max-w-[58ch] text-[0.9375rem] leading-relaxed text-ink-dim">
        Hiding takes an ask off the board, out of matching and away from other
        members. The poster keeps their page, with your reason on it, verbatim.
        Write reasons accordingly: name the problem, never a person or a
        contact.
      </p>

      <div className="mt-10 space-y-6">
        <HiddenList rows={hidden} />
        <OpsErrorsSlot />
      </div>
    </div>
  );
}
