"use client";

import Link from "next/link";

interface SectionHeaderProps {
  title: string;
  /** Browse/all link — rendered as a quiet "See all" affordance. */
  href?: string;
  /** Small note under the title, e.g. "Last 30 days". */
  note?: string;
  /** Right-side slot when there is no See-all link. */
  children?: React.ReactNode;
  /** Larger treatment for the primary section on a page. */
  emphasis?: boolean;
}

/**
 * One section header for every rail. No red bar everywhere: the title carries
 * the hierarchy, the link stays quiet, and spacing comes from the container.
 */
export default function SectionHeader({ title, href, note, children, emphasis }: SectionHeaderProps) {
  const titleEl = (
    <h2
      className={
        emphasis
          ? "text-2xl font-semibold tracking-tight"
          : "text-lg font-semibold tracking-tight text-foreground/90"
      }
    >
      {title}
    </h2>
  );

  return (
    <div className="mb-2 flex items-end justify-between gap-4">
      <div className="min-w-0">
        {href ? (
          <Link href={href} className="group/title inline-block text-foreground/90 transition-colors hover:text-accent">
            <h2
              className={
                emphasis
                  ? "text-2xl font-semibold tracking-tight"
                  : "text-lg font-semibold tracking-tight"
              }
            >
              {title}
            </h2>
          </Link>
        ) : (
          titleEl
        )}
        {note && <p className="mt-0.5 text-2xs text-text-secondary">{note}</p>}
      </div>
      {!href && children}
    </div>
  );
}
