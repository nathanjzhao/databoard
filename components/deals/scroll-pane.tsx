"use client";

/**
 * components/deals/scroll-pane.tsx
 *
 * Horizontal scroll container with edge fades as the scroll affordance.
 * A fade sits over whichever edge still has columns offscreen and
 * disappears once the pane is scrolled to that end, so narrow viewports
 * see at a glance that a table continues instead of a hard mid-glyph cut.
 */

import { useEffect, useRef, useState } from "react";

export function ScrollPane({
  className,
  children,
}: {
  /** Applied to the outer wrapper (borders, backgrounds). */
  className?: string;
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [moreRight, setMoreRight] = useState(false);
  const [moreLeft, setMoreLeft] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => {
      const overflow = el.scrollWidth - el.clientWidth;
      setMoreLeft(overflow > 1 && el.scrollLeft > 1);
      setMoreRight(overflow > 1 && el.scrollLeft < overflow - 1);
    };
    update();
    el.addEventListener("scroll", update, { passive: true });
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => {
      el.removeEventListener("scroll", update);
      ro.disconnect();
    };
  }, []);

  return (
    <div className={["relative", className ?? ""].join(" ")}>
      <div ref={ref} className="overflow-x-auto">
        {children}
      </div>
      {moreLeft ? (
        <div
          aria-hidden
          className="pointer-events-none absolute inset-y-0 left-0 w-10"
          style={{
            background:
              "linear-gradient(to right, var(--bt-panel), transparent)",
          }}
        />
      ) : null}
      {moreRight ? (
        <div
          aria-hidden
          className="pointer-events-none absolute inset-y-0 right-0 w-10"
          style={{
            background:
              "linear-gradient(to left, var(--bt-panel), transparent)",
          }}
        />
      ) : null}
    </div>
  );
}
