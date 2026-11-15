import type { ReactNode } from "react";

/** The single loading primitive — uses the shimmer defined in globals.css. */
export function Skeleton({ className }: { className?: string }) {
  return <div className={`skeleton rounded-surface ${className ?? ""}`} />;
}

/** Poster grid placeholder used by search, browse and watchlist. */
export function CardGridSkeleton({ count = 10, className }: { count?: number; className?: string }) {
  return (
    <div className={className ?? "grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5"}>
      {Array.from({ length: count }).map((_, i) => (
        <Skeleton key={i} className="aspect-[3/4]" />
      ))}
    </div>
  );
}

interface EmptyStateProps {
  icon?: ReactNode;
  title: string;
  description?: string;
  action?: ReactNode;
  className?: string;
}

/** The single empty/error panel: icon, one sentence, optional action. */
export default function EmptyState({ icon, title, description, action, className }: EmptyStateProps) {
  return (
    <div className={`flex flex-col items-center justify-center gap-3 py-16 text-center ${className ?? ""}`}>
      {icon && <div className="text-text-secondary/60">{icon}</div>}
      <div className="space-y-1">
        <p className="text-sm font-medium text-foreground/90">{title}</p>
        {description && <p className="mx-auto max-w-sm text-xs leading-relaxed text-text-secondary">{description}</p>}
      </div>
      {action}
    </div>
  );
}
