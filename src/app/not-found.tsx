import Link from "next/link";

export default function NotFound() {
  return (
    <div className="flex flex-col items-center justify-center py-32 gap-4 px-6 text-center">
      <p className="text-6xl font-bold font-display text-accent">404</p>
      <h1 className="text-xl font-semibold">Page not found</h1>
      <p className="text-sm text-text-muted">The page you&rsquo;re looking for doesn&rsquo;t exist or has been moved.</p>
      <div className="flex gap-3 mt-2">
        <Link href="/" className="px-4 py-2 rounded-lg text-sm font-medium bg-accent hover:bg-accent-hover text-white transition-colors">
          Home
        </Link>
        <Link href="/?tab=movies" className="px-4 py-2 rounded-lg text-sm font-medium bg-surface hover:bg-surface-hover border border-border text-text-muted transition-colors">
          Movies
        </Link>
      </div>
    </div>
  );
}
