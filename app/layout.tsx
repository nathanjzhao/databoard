import type { Metadata } from "next";
import "./globals.css";
import { SiteFooter, SiteNav } from "@/components/site-nav";
import { getSessionUser } from "@/lib/auth";

/**
 * Type is the system Helvetica stack, declared in globals.css
 * (--font-bt-sans / --font-bt-display / --font-bt-mono). No webfonts.
 */

export const metadata: Metadata = {
  title: {
    default: "DataBoard",
    template: "%s / DataBoard",
  },
  description:
    "A pseudonymous board for data asks. No phone numbers, no email addresses, no buyer names stored.",
};

export default async function RootLayout({ children }: LayoutProps<"/">) {
  const user = await getSessionUser();

  return (
    <html lang="en" className="h-full antialiased">
      <body className="flex min-h-full flex-col bg-bg text-ink">
        <SiteNav user={user ? { username: user.username } : null} />
        <main className="flex-1">{children}</main>
        <SiteFooter />
      </body>
    </html>
  );
}
