"use client";

export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div className="flex flex-col items-center justify-center py-32 gap-4 px-6 text-center">
      <p className="text-5xl font-bold font-display text-accent">!</p>
      <h1 className="text-xl font-semibold">Something went wrong</h1>
      <p className="text-sm text-text-muted max-w-md">
        {error.message || "An unexpected error occurred while loading this page."}
      </p>
      <button
        onClick={reset}
        className="px-5 py-2.5 rounded-lg text-sm font-medium bg-accent hover:bg-accent-hover text-white transition-colors btn-tap mt-2"
      >
        Try again
      </button>
    </div>
  );
}
