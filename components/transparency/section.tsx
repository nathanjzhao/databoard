/**
 * Numbered section shell for /transparency. Server component: layout only.
 */

import type { ReactNode } from "react";

export function TSection({
  id,
  num,
  title,
  lede,
  children,
}: {
  id: string;
  num: string;
  title: string;
  lede?: string;
  children: ReactNode;
}) {
  return (
    <section id={id} className="scroll-mt-24 border-t border-rule-strong pt-7">
      <div className="flex items-baseline gap-4">
        <span className="bt-token text-[0.8125rem]">{num}</span>
        <h2 className="bt-display text-[1.65rem] leading-[1.1] text-ink">
          {title}
        </h2>
      </div>
      {lede ? (
        <p className="mt-3 max-w-[64ch] text-[0.9375rem] leading-relaxed text-ink-dim">
          {lede}
        </p>
      ) : null}
      <div className="mt-6">{children}</div>
    </section>
  );
}
