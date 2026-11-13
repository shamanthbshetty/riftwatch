/**
 * Shimmer placeholder for a horizontally scrolling rail — mirrors the real
 * rail's layout (heading + card row) so the page doesn't pop when data lands.
 */
export default function RailSkeleton() {
  return (
    <section aria-hidden>
      <div className="mb-4 pl-10 pr-4 md:pl-10 md:pr-8">
        <div className="skeleton h-6 w-44 rounded" />
      </div>
      <div className="carousel-scroll">
        {Array.from({ length: 7 }).map((_, i) => (
          <div key={i} className="flex-shrink-0 w-[180px] aspect-[3/4] rounded-md skeleton" />
        ))}
      </div>
    </section>
  );
}
