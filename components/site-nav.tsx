"use client";

/**
 * The global chrome. Rendered by app/layout.tsx on every page.
 * Client-side only so the active link can be highlighted from the pathname.
 */

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";

export type NavUser = { username: string } | null;

const MEMBER_LINKS = [
  { href: "/", label: "Board" },
  { href: "/new", label: "Post an ask" },
  { href: "/matches", label: "Matches" },
  { href: "/messages", label: "Messages" },
  { href: "/deals", label: "Deals" },
  { href: "/leaderboard", label: "Leaderboard" },
  { href: "/invites", label: "Invites" },
  { href: "/transparency", label: "Transparency" },
] as const;

/** Signed out, the nav admits only what the middleware serves anyway. */
const VISITOR_LINKS = [{ href: "/transparency", label: "Transparency" }] as const;

function isActive(pathname: string, href: string): boolean {
  if (href === "/") return pathname === "/";
  return pathname === href || pathname.startsWith(href + "/");
}

export function SiteNav({ user }: { user: NavUser }) {
  const pathname = usePathname() ?? "/";
  const [signingOut, setSigningOut] = useState(false);
  const matchesBadge = useNavBadge("/api/matches/badge", Boolean(user), pathname);
  const dealsBadge = useNavBadge("/api/deals/badge", Boolean(user), pathname);
  // /gate is a bare hero with its own doors in; no chrome on top of it.
  // (After the hooks: the hook count must not change between routes.)
  if (pathname === "/gate") return null;
  const badges: Record<string, number> = {
    "/matches": matchesBadge,
    "/deals": dealsBadge,
  };
  const links = user ? MEMBER_LINKS : VISITOR_LINKS;

  async function signOut() {
    setSigningOut(true);
    await fetch("/api/auth/logout", { method: "POST" });
    // Hard navigation across the session boundary; see login-form.tsx.
    window.location.assign("/gate");
  }

  return (
    <header className="sticky top-0 z-40 border-b border-rule-strong bg-void/95 backdrop-blur-sm">
      <div className="mx-auto flex max-w-[1180px] items-center gap-6 px-5 py-3">
        <Link href="/" className="group flex shrink-0 items-baseline gap-2.5">
          <span className="bt-display text-[1.35rem] leading-none tracking-tight text-ink">
            DataBoard
          </span>
          <span className="hidden bt-label text-ink-ghost sm:inline">
            data asks, pseudonymous
          </span>
        </Link>

        <nav className="ml-auto hidden items-center gap-1 lg:flex">
          {links.map((l) => {
            const active = isActive(pathname, l.href);
            return (
              <Link
                key={l.href}
                href={l.href}
                className={[
                  "relative px-2.5 py-1.5 text-[0.8125rem] transition-colors",
                  active ? "text-amber" : "text-ink-dim hover:text-ink",
                ].join(" ")}
              >
                {l.label}
                {(badges[l.href] ?? 0) > 0 ? (
                  <span className="ml-1.5 inline-block min-w-[1.1rem] rounded-sm bg-amber px-1 text-center font-mono text-[0.625rem] leading-[1.15rem] text-void">
                    {badges[l.href]! > 99 ? "99+" : badges[l.href]}
                  </span>
                ) : null}
                {active ? (
                  <span className="absolute inset-x-2.5 -bottom-[13px] h-px bg-amber" />
                ) : null}
              </Link>
            );
          })}
        </nav>

        <div className="ml-auto flex items-center gap-3 lg:ml-4">
          {user ? (
            <>
              <span className="hidden font-mono text-[0.75rem] text-ink-dim sm:inline">
                @{user.username}
              </span>
              <button
                type="button"
                onClick={signOut}
                disabled={signingOut}
                className="bt-btn px-2.5 py-1 text-[0.75rem]"
              >
                {signingOut ? "..." : "Sign out"}
              </button>
            </>
          ) : (
            <>
              <Link
                href="/login"
                className="text-[0.8125rem] text-ink-dim transition-colors hover:text-ink"
              >
                Sign in
              </Link>
              <Link href="/signup" className="bt-btn bt-btn-primary px-3 py-1.5 text-[0.75rem]">
                Get an account
              </Link>
            </>
          )}
        </div>
      </div>

      {/* mobile nav strip */}
      <nav className="flex gap-4 overflow-x-auto border-t border-rule px-5 py-2 lg:hidden">
        {links.map((l) => (
          <Link
            key={l.href}
            href={l.href}
            className={[
              "whitespace-nowrap text-[0.75rem]",
              isActive(pathname, l.href) ? "text-amber" : "text-ink-dim",
            ].join(" ")}
          >
            {l.label}
            {(badges[l.href] ?? 0) > 0 ? (
              <span className="ml-1 inline-block min-w-[1rem] rounded-sm bg-amber px-1 text-center font-mono text-[0.5625rem] leading-[1rem] text-void">
                {badges[l.href]! > 99 ? "99+" : badges[l.href]}
              </span>
            ) : null}
          </Link>
        ))}
      </nav>
    </header>
  );
}

/**
 * One nav badge count from a badge endpoint ({ badge: number }); /matches
 * counts pending collab requests, /deals counts splits waiting on the
 * viewer's own confirm-or-decline. Re-fetched on navigation, on tab refocus,
 * and every 60s while visible; silent on any failure because a nav badge is
 * never worth an error state.
 */
function useNavBadge(url: string, signedIn: boolean, pathname: string): number {
  const [badge, setBadge] = useState(0);

  useEffect(() => {
    if (!signedIn) {
      setBadge(0);
      return;
    }
    let cancelled = false;

    async function load() {
      if (document.visibilityState === "hidden") return;
      try {
        const res = await fetch(url, { cache: "no-store" });
        if (!res.ok) return;
        const data = (await res.json()) as { badge?: number };
        if (!cancelled && typeof data.badge === "number") setBadge(data.badge);
      } catch {
        /* keep the last value */
      }
    }

    load();
    const interval = setInterval(load, 60_000);
    const onVisible = () => {
      if (document.visibilityState === "visible") load();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [url, signedIn, pathname]);

  return badge;
}

/**
 * commitSha is threaded in from app/layout.tsx (a server component), because
 * VERCEL_GIT_COMMIT_SHA is a server-side env var and this file is client
 * code. The stamp links the running deployment to the exact tree it was
 * built from; /transparency explains what that does and does not prove.
 */
export function SiteFooter({ commitSha }: { commitSha: string | null }) {
  const pathname = usePathname() ?? "/";
  if (pathname === "/gate") return null;
  const commitHref = commitSha
    ? `https://github.com/nathanjzhao/databoard/tree/${commitSha}`
    : "https://github.com/nathanjzhao/databoard";
  return (
    <footer className="mt-auto border-t border-rule">
      <div className="mx-auto flex max-w-[1180px] flex-wrap items-center gap-x-6 gap-y-2 px-5 py-6 text-[0.75rem] text-ink-faint">
        <span className="bt-label">DataBoard</span>
        <span>
          No phone numbers, no email addresses, no buyer names in the database.
        </span>
        <Link href="/transparency" className="text-blue hover:text-amber">
          Read the schema
        </Link>
        <Link href="/terms" className="transition-colors hover:text-ink">
          Terms
        </Link>
        <Link href="/privacy" className="transition-colors hover:text-ink">
          Privacy
        </Link>
        <a
          href={commitHref}
          target="_blank"
          rel="noreferrer"
          className="ml-auto font-mono text-[0.6875rem] text-ink-faint transition-colors hover:text-amber"
          title="The commit this deployment was built from"
        >
          running {commitSha ? commitSha.slice(0, 7) : "dev"}
        </a>
      </div>
    </footer>
  );
}
