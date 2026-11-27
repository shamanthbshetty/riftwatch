"use client";

import { useRef, useSyncExternalStore } from "react";
import { useRouter } from "next/navigation";
import { exportData, importData, getEpCache, refreshStore, subscribeStore, setAutoplayPref, setSkipPref, setResumePref } from "@/lib/storage";
import { useWatchlistItems, useAutoplayPref, useSkipPref, useResumePref } from "@/lib/useWatchlists";
import { useToast } from "@/lib/toast";

function PlaybackRow({
  title,
  description,
  checked,
  onChange,
}: {
  title: string;
  description: string;
  checked: boolean;
  onChange: (on: boolean) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-4">
      <div className="min-w-0">
        <p className="text-sm font-medium">{title}</p>
        <p className="text-xs text-text-secondary">{description}</p>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={title}
        onClick={() => onChange(!checked)}
        className={`relative h-6 w-11 shrink-0 rounded-chip transition-colors ${checked ? "bg-accent" : "bg-surface-hover border border-border"}`}
      >
        <span
          className={`absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform ${checked ? "translate-x-[20px]" : "translate-x-0"}`}
        />
      </button>
    </div>
  );
}

export default function SettingsPage() {
  const { toast } = useToast();
  const router = useRouter();
  const fileRef = useRef<HTMLInputElement>(null);
  // useSyncExternalStore renders the server snapshot during hydration and swaps
  // to localStorage afterwards, so no "mounted" flag is needed here.
  const watchlist = useWatchlistItems();
  const autoplay = useAutoplayPref();
  const autoSkip = useSkipPref();
  const resumePref = useResumePref();
  // "Tracking notifications" = ep-cache entries for shows still on the
  // watchlist. Going through the external store keeps the server snapshot (0)
  // and client snapshot aligned — reading getEpCache() directly in render gave
  // the server 0 and the client N (hydration mismatch).
  const trackingCount = useSyncExternalStore(
    subscribeStore,
    () => Object.keys(getEpCache()).filter((id) => watchlist.some((w) => w.id === id)).length,
    () => 0
  );

  function handleExport() {
    const blob = new Blob([exportData()], { type: "application/json" });
    const a = document.createElement("a");
    const href = URL.createObjectURL(blob);
    a.href = href;
    a.download = `riftwatch-backup-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    // Revoking synchronously can cancel the download in some browsers — wait
    // until the navigation to the blob URL has had time to start.
    setTimeout(() => URL.revokeObjectURL(href), 1000);
    toast("Exported!", "success");
  }

  function handleImport(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const result = importData(reader.result as string);
      toast(result.ok ? "Imported!" : (result.error ?? "Import failed"), result.ok ? "success" : "error");
    };
    reader.readAsText(file);
    if (fileRef.current) fileRef.current.value = "";
  }

  function handleClearHistory() {
    if (!confirm("Clear all watch history?")) return;
    localStorage.removeItem("history");
    localStorage.removeItem("movie-history");
    // Out-of-band write: refreshStore drops cached snapshots so continue-watching
    // and history views re-render empty instead of showing stale rows.
    refreshStore();
    toast("History cleared", "success");
  }

  function handleClearAll() {
    if (!confirm("Clear all data? This cannot be undone.")) return;
    localStorage.clear();
    refreshStore();
    toast("All data cleared", "success");
  }

  const watchCount = watchlist.length;

  return (
    <div className="max-w-2xl mx-auto page-top px-4 pb-10 space-y-8">
      {/* Header with back */}
      <div className="flex items-center gap-3">
        <button onClick={() => router.back()} className="text-text-muted hover:text-foreground transition-colors btn-tap">
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" /></svg>
        </button>
        <h1 className="text-xl font-semibold">Settings</h1>
      </div>

      {/* Data Management */}
      <section className="space-y-3">
        <h2 className="text-xs font-semibold text-text-muted uppercase tracking-wider flex items-center gap-2">
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 7v10c0 2.21 3.582 4 8 4s8-1.79 8-4V7M4 7c0 2.21 3.582 4 8 4s8-1.79 8-4M4 7c0-2.21 3.582-4 8-4s8 1.79 8 4" /></svg>
          Data Management
        </h2>
        <p className="text-xs text-text-secondary -mt-1">
          Your data lives in this app&apos;s local storage. To bring over history or watchlists
          from the old web app or a previous desktop install, export them there first, then
          import the JSON file here.
        </p>
        <div className="bg-surface rounded-xl p-4 space-y-4 border border-border/50">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-lg bg-accent/10 flex items-center justify-center shrink-0">
                <svg className="w-5 h-5 text-accent" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" /></svg>
              </div>
              <div>
                <p className="text-sm font-medium">Export Data</p>
                <p className="text-xs text-text-secondary">Download your watchlist, history & notifications</p>
              </div>
            </div>
            <button onClick={handleExport} className="px-4 py-2 rounded-lg text-xs font-medium bg-accent hover:bg-accent-hover text-white transition-colors btn-tap">
              Export
            </button>
          </div>
          <div className="border-t border-border/50" />
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-lg bg-surface-hover flex items-center justify-center shrink-0">
                <svg className="w-5 h-5 text-text-muted" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" /></svg>
              </div>
              <div>
                <p className="text-sm font-medium">Import Data</p>
                <p className="text-xs text-text-secondary">Restore from a previously exported JSON file</p>
              </div>
            </div>
            <button onClick={() => fileRef.current?.click()} className="px-4 py-2 rounded-lg text-xs font-medium bg-surface-hover hover:bg-border text-text-muted border border-border transition-colors btn-tap">
              Import
            </button>
            <input ref={fileRef} type="file" accept=".json" onChange={handleImport} className="hidden" />
          </div>
        </div>
      </section>

      {/* Playback */}
      <section className="space-y-3">
        <h2 className="text-xs font-semibold text-text-muted uppercase tracking-wider flex items-center gap-2">
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 3l14 9-14 9V3z" /></svg>
          Playback
        </h2>
        <div className="bg-surface rounded-xl p-4 space-y-4 border border-border/50">
          <PlaybackRow
            title="Autoplay next episode"
            description="Start the next episode automatically when one ends"
            checked={autoplay}
            onChange={setAutoplayPref}
          />
          <div className="border-t border-border/50" />
          <PlaybackRow
            title="Auto-skip openings & endings"
            description="Jump past OP/ED when the source provides timestamps"
            checked={autoSkip}
            onChange={setSkipPref}
          />
          <div className="border-t border-border/50" />
          <PlaybackRow
            title="Resume where I left off"
            description="Reopen episodes at the saved position instead of the start"
            checked={resumePref}
            onChange={setResumePref}
          />
        </div>
      </section>

      {/* Stats */}
      <section className="space-y-3">
        <h2 className="text-xs font-semibold text-text-muted uppercase tracking-wider flex items-center gap-2">
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" /></svg>
          Statistics
        </h2>
        <div className="bg-surface rounded-xl p-4 grid grid-cols-2 gap-4 border border-border/50">
          <div className="text-center p-3 rounded-lg bg-accent/5">
            <p className="text-2xl font-bold text-accent">{watchCount}</p>
            <p className="text-xs text-text-secondary mt-1">Watchlist items</p>
          </div>
          <div className="text-center p-3 rounded-lg bg-accent/5">
            <p className="text-2xl font-bold text-accent">{trackingCount}</p>
            <p className="text-xs text-text-secondary mt-1">Tracking notifications</p>
          </div>
        </div>
      </section>

      {/* Danger Zone */}
      <section className="space-y-3">
        <h2 className="text-xs font-semibold text-red-500 uppercase tracking-wider flex items-center gap-2">
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L4.082 16.5c-.77.833.192 2.5 1.732 2.5z" /></svg>
          Danger Zone
        </h2>
        <div className="bg-surface rounded-xl p-4 space-y-4 border border-red-600/10">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-lg bg-red-600/10 flex items-center justify-center shrink-0">
                <svg className="w-5 h-5 text-red-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>
              </div>
              <div>
                <p className="text-sm font-medium">Clear History</p>
                <p className="text-xs text-text-secondary">Remove all watch history and continue watching data</p>
              </div>
            </div>
            <button onClick={handleClearHistory} className="px-4 py-2 rounded-lg text-xs font-medium bg-red-600/10 hover:bg-red-600/20 text-red-500 border border-red-600/20 transition-colors btn-tap">
              Clear
            </button>
          </div>
          <div className="border-t border-red-600/10" />
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-lg bg-red-600/10 flex items-center justify-center shrink-0">
                <svg className="w-5 h-5 text-red-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" /></svg>
              </div>
              <div>
                <p className="text-sm font-medium">Clear All Data</p>
                <p className="text-xs text-text-secondary">Delete everything: watchlist, history, notifications, caches</p>
              </div>
            </div>
            <button onClick={handleClearAll} className="px-4 py-2 rounded-lg text-xs font-medium bg-red-600 hover:bg-red-700 text-white transition-colors btn-tap">
              Delete All
            </button>
          </div>
        </div>
      </section>

      {/* Keyboard shortcuts */}
      <section className="space-y-3">
        <h2 className="text-xs font-semibold text-text-muted uppercase tracking-wider flex items-center gap-2">
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" /></svg>
          Keyboard Shortcuts
        </h2>
        <div className="bg-surface rounded-xl p-4 border border-border/50 space-y-2">
          <div className="flex items-center justify-between text-sm">
            <span className="text-text-secondary">Open search</span>
            <kbd className="px-2 py-0.5 bg-surface-hover border border-border rounded text-xs font-mono text-text-muted">Ctrl K</kbd>
          </div>
          <div className="flex items-center justify-between text-sm">
            <span className="text-text-secondary">Close overlay</span>
            <kbd className="px-2 py-0.5 bg-surface-hover border border-border rounded text-xs font-mono text-text-muted">ESC</kbd>
          </div>
        </div>
      </section>
    </div>
  );
}
