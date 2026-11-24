import { Skeleton } from "./Skeleton";

/**
 * Shimmer placeholder for a horizontally scrolling rail — mirrors the real
 * rail's layout (heading + card row) so the page doesn't pop when data lands.
 */
export default function RailSkeleton() {
  return (
    <section aria-hidden>
      <div className="mb-2">
        <Skeleton className="h-5 w-40" />
      </div>
      <div className="carousel-scroll">
        {Array.from({ length: 7 }).map((_, i) => (
          <Skeleton key={i} className="aspect-[3/4] rail-card" />
        ))}
      </div>
    </section>
  );
}
