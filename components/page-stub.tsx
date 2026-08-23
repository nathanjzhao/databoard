/**
 * Placeholder shell for the routes other agents are filling in.
 * Keeps the chrome and the type of the page honest while the body is empty.
 */

export function PageStub({
  eyebrow,
  title,
  blurb,
  children,
}: {
  eyebrow: string;
  title: string;
  blurb: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="mx-auto w-full max-w-[1180px] px-5 py-14">
      <div className="bt-label">{eyebrow}</div>
      <h1 className="bt-display mt-3 text-[2.5rem] leading-[1.05] text-ink">
        {title}
      </h1>
      <p className="mt-4 max-w-[62ch] text-[0.9375rem] leading-relaxed text-ink-dim">
        {blurb}
      </p>
      <div className="mt-10">{children}</div>
    </div>
  );
}

/**
 * Shown in place of database-backed content when the deployment has no
 * TURSO_DATABASE_URL. A configuration problem, stated as one, instead of a 500.
 */
export function DbNotConfiguredNotice() {
  return (
    <div className="border-l-2 border-amber bg-amber-wash px-5 py-4">
      <div className="bt-label text-amber">Database not configured</div>
      <p className="mt-2 max-w-[60ch] text-[0.875rem] leading-relaxed text-ink-dim">
        This deployment has no database behind it. Set TURSO_DATABASE_URL and
        TURSO_AUTH_TOKEN in the environment, redeploy, and this page will come
        back with content. Locally, running the dev server creates
        data/app.db on its own.
      </p>
    </div>
  );
}

export function ComingSoon({ note }: { note: string }) {
  return (
    <div className="relative overflow-hidden border border-rule bg-panel px-6 py-14 text-center">
      <div className="bt-hatch pointer-events-none absolute inset-0 opacity-40" />
      <div className="relative">
        <div className="bt-label text-ink-ghost">Not wired up yet</div>
        <p className="mx-auto mt-3 max-w-[46ch] text-[0.875rem] leading-relaxed text-ink-faint">
          {note}
        </p>
      </div>
    </div>
  );
}
