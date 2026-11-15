"use client";

import Link from "next/link";
import Image from "next/image";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useState, useEffect, useRef } from "react";
import {
  markAllRead, markNotificationRead, removeNotification,
  markAllMovieRead, markMovieNotificationRead, removeMovieNotification,
  refreshStore,
  storeSignature,
  type AppNotification,
} from "@/lib/storage";
import { useNotifications, useTheme, useContinueWatching, useContinueWatchingMovies } from "@/lib/useWatchlists";
import type { SearchResult } from "@/lib/allanime";
import type { MovieResult } from "@/lib/movies";

export default function Nav() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const router = useRouter();
  const tab = searchParams.get("tab") ?? (pathname.startsWith("/movies") ? "movies" : "anime");
  const isMovies = tab === "movies";

  // Notification state (read straight from the store, so it stays in sync)
  const { notifs, unread } = useNotifications(isMovies);
  const [notifOpen, setNotifOpen] = useState(false);
  const notifRef = useRef<HTMLDivElement>(null);

  // Recent searches (max 3) — persisted, so read from the store too.
  const [recentSearches, setRecentSearches] = useState<{ q: string; tab: string; thumb?: string }[]>(() => {
    if (typeof window === "undefined") return [];
    try { return JSON.parse(localStorage.getItem("recentSearches") || "[]"); } catch { return []; }
  });

  function saveRecentSearch(query: string, thumb?: string) {
    if (!query.trim()) return;
    const entry = { q: query.trim(), tab, thumb: thumb || "" };
    const next = [entry, ...recentSearches.filter((r) => r.q !== entry.q)].slice(0, 3);
    setRecentSearches(next);
    localStorage.setItem("recentSearches", JSON.stringify(next));
  }

  function removeRecentSearch(idx: number) {
    const next = recentSearches.filter((_, i) => i !== idx);
    setRecentSearches(next);
    localStorage.setItem("recentSearches", JSON.stringify(next));
  }

  function clearRecentSearches() {
    setRecentSearches([]);
    localStorage.removeItem("recentSearches");
  }

  // Random pick: fetch the destination and push it, so each shuffle is one
  // history entry and Back lands on the previous pick (a server redirect in
  // the stack would re-roll instead). Movies tab shuffles movie/TV titles.
  function shuffleRandom() {
    fetch(isMovies ? "/api/random?type=movie" : "/api/random")
      .then((r) => r.json())
      .then((j) => { if (j?.url) router.push(j.url); })
      .catch(() => {});
  }

  // Search overlay state
  const [searchOpen, setSearchOpen] = useState(false);  const [q, setQ] = useState("");
  const [animeSuggestions, setAnimeSuggestions] = useState<SearchResult[]>([]);
  const [movieSuggestions, setMovieSuggestions] = useState<MovieResult[]>([]);
  const [suggestionsOpen, setSuggestionsOpen] = useState(false);
  const [activeIdx, setActiveIdx] = useState(-1);
  const [loading, setLoading] = useState(false);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const searchWrapRef = useRef<HTMLDivElement>(null);
  const searchListRef = useRef<HTMLDivElement>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout>>(null);
  // Latest suggestions fetch — aborted when a newer keystroke debounce fires
  // or the tab flips, so a slow response can never overwrite fresher results.
  const searchAbortRef = useRef<AbortController | null>(null);

  // Theme state
  const { theme, toggleTheme } = useTheme();

  // Command palette actions (Ctrl+K overlay, shown under an empty query).
  const continueAnime = useContinueWatching();
  const continueMovies = useContinueWatchingMovies();

  type Command = { id: string; label: string; hint?: string; run: () => void };

  const resumeTarget = (() => {
    if (isMovies) {
      const m = continueMovies[0];
      if (!m) return null;
      return {
        label: `EP ${m.episode ?? 1}`,
        href: `/movies/${m.id}/watch?type=${m.type}${m.season ? `&season=${m.season}&episode=${m.episode}` : ""}`,
      };
    }
    const a = continueAnime[0];
    if (!a) return null;
    return {
      label: `EP ${a.ep} · ${a.mode.toUpperCase()}`,
      href: `/watch/${a.id}?ep=${a.ep}&mode=${a.mode}${a.title ? `&title=${encodeURIComponent(a.title)}` : ""}`,
    };
  })();

  const close = () => setSearchOpen(false);

  const commands: Command[] = [
    ...(resumeTarget
      ? [{
          id: "resume",
          label: "Resume watching",
          hint: resumeTarget.label,
          run: () => { close(); router.push(resumeTarget.href); },
        }]
      : []),
    {
      id: "random",
      label: isMovies ? "Random movie or show" : "Random anime",
      hint: "Shuffle",
      run: () => { close(); shuffleRandom(); },
    },
    { id: "watchlist", label: "My watchlist", run: () => { close(); router.push(`/watchlist?tab=${tab}`); } },
    { id: "history", label: "Watch history", run: () => { close(); router.push("/history"); } },
    {
      id: "theme",
      label: theme === "dark" ? "Switch to light mode" : "Switch to dark mode",
      hint: "Theme",
      run: () => { close(); toggleTheme(); },
    },
    { id: "settings", label: "Settings", run: () => { close(); router.push("/settings"); } },
  ];

  // Notifications are polled for changes; refreshing the store re-renders
  // subscribers without any setState inside the effect body. Gated on the
  // raw-store signature: if nothing actually changed, subscribers don't get a
  // pointless re-render every 60s.
  useEffect(() => {
    // startsWith, not includes: "/watchlist" must NOT count as a watch page
    // (that bug stopped the notification pollers entirely).
    if (pathname.startsWith("/watch/")) return;
    let lastSeenSig = storeSignature();
    const t = setInterval(() => {
      const sig = storeSignature();
      if (sig === lastSeenSig) return;
      lastSeenSig = sig;
      refreshStore();
    }, 60_000);
    return () => clearInterval(t);
  }, [pathname]);

  useEffect(() => {
    if (!notifOpen) return;
    function onClick(e: MouseEvent) {
      if (notifRef.current && !notifRef.current.contains(e.target as Node)) setNotifOpen(false);
    }
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [notifOpen]);

  function handleMarkAllRead() {
    if (isMovies) markAllMovieRead();
    else markAllRead();
  }

  function handleRemoveNotif(id: string, e: React.MouseEvent) {
    e.stopPropagation();
    if (isMovies) removeMovieNotification(id);
    else removeNotification(id);
  }

  function handleNotifClick(n: AppNotification) {
    if (isMovies) markMovieNotificationRead(n.id);
    else markNotificationRead(n.id);
    setNotifOpen(false);
    router.push(n.href);
  }

  // Search helpers
  const suggestions = isMovies
    ? movieSuggestions.map((m) => ({ id: m.id, label: m.title || m.name || "", sub: "", dub: "", img: m.poster_path }))
    : animeSuggestions.map((a) => ({ id: a._id, label: a.englishName || a.name, sub: String(a.availableEpisodes?.sub ?? 0), dub: String(a.availableEpisodes?.dub ?? 0), img: a.thumbnail }));

  function fetchSuggestions(query: string) {
    if (!query.trim()) { setAnimeSuggestions([]); setMovieSuggestions([]); setSuggestionsOpen(false); return; }
    setLoading(true);
    searchAbortRef.current?.abort();
    const ctrl = new AbortController();
    searchAbortRef.current = ctrl;
    const url = isMovies
      ? `/api/movies/search?q=${encodeURIComponent(query.trim())}`
      : `/api/search?q=${encodeURIComponent(query.trim())}`;
    fetch(url, { signal: ctrl.signal })
      .then((r) => r.json())
      .then((data) => {
        if (searchAbortRef.current !== ctrl) return;
        if (isMovies) { if (data.results) { setMovieSuggestions(data.results.slice(0, 8)); setSuggestionsOpen(true); } }
        else { if (Array.isArray(data)) { setAnimeSuggestions(data.slice(0, 8)); setSuggestionsOpen(true); } }
      })
      .catch(() => {
        if (searchAbortRef.current !== ctrl) return;
        setAnimeSuggestions([]); setMovieSuggestions([]); setSuggestionsOpen(false);
      })
      .finally(() => {
        if (searchAbortRef.current === ctrl) setLoading(false);
      });
  }

  function onSearchChange(val: string) {
    setQ(val);
    setActiveIdx(-1);
    clearTimeout(timerRef.current!);
    timerRef.current = setTimeout(() => fetchSuggestions(val), 300);
  }

  // Clear the pending debounce on unmount — otherwise it fires setState after
  // the Nav is gone (search overlay closes → remount cycle). Abort any
  // in-flight suggestions fetch too, and when the tab flips (its endpoint
  // changed under the response).
  useEffect(() => {
    searchAbortRef.current?.abort();
  }, [isMovies]);
  useEffect(() => () => {
    clearTimeout(timerRef.current!);
    searchAbortRef.current?.abort();
  }, []);

  function selectItem(idx: number) {
    setSuggestionsOpen(false);
    setQ("");
    setSearchOpen(false);
    if (isMovies) {
      const m = movieSuggestions[idx];
      if (m) { saveRecentSearch(m.title || m.name || "", m.poster_path || ""); router.push(`/movies/${m.id}?type=${m.media_type === "tv" ? "tv" : "movie"}`); }
    } else {
      const a = animeSuggestions[idx];
      if (a) { saveRecentSearch(a.englishName || a.name, a.thumbnail || ""); router.push(`/anime/${a._id}`); }
    }
  }

  function onSearchSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!q.trim()) {
      // Index space: commands, then recent searches.
      if (activeIdx >= 0 && activeIdx < commands.length) {
        commands[activeIdx].run();
        return;
      }
      const ri = activeIdx - commands.length;
      if (ri >= 0 && ri < recentSearches.length) {
        const r = recentSearches[ri];
        setSearchOpen(false);
        setActiveIdx(-1);
        router.push(`/?tab=${r.tab}&q=${encodeURIComponent(r.q)}`);
      }
      return;
    }
    if (activeIdx >= 0 && activeIdx < suggestions.length) { selectItem(activeIdx); return; }
    if (q.trim()) {
      setSuggestionsOpen(false);
      setSearchOpen(false);
      saveRecentSearch(q);
      router.push(`/?tab=${tab}&q=${encodeURIComponent(q.trim())}`);
    }
  }

  // Empty query: quick actions first, then recent searches. Both are keyboard
  // navigable with the same index so ArrowDown/Enter work across the two.
  const actionList = !q.trim() && !suggestionsOpen
    ? [...commands.map((c) => ({ id: c.id, label: c.label })), ...recentSearches.map((r) => ({ id: r.q, label: r.q }))]
    : [];

  function onSearchKeyDown(e: React.KeyboardEvent) {
    const list = suggestionsOpen && suggestions.length > 0 ? suggestions : actionList;
    if (list.length === 0) return;
    if (e.key === "ArrowDown") { e.preventDefault(); setActiveIdx((i) => (i + 1) % list.length); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActiveIdx((i) => (i - 1 + list.length) % list.length); }
    else if (e.key === "Escape") { setSuggestionsOpen(false); }
  }

  // Scroll active suggestion into view
  useEffect(() => {
    if (activeIdx < 0 || !searchListRef.current) return;
    const el = searchListRef.current.children[activeIdx] as HTMLElement | undefined;
    el?.scrollIntoView({ block: "nearest" });
  }, [activeIdx]);

  // Focus input when overlay opens
  useEffect(() => {
    if (!searchOpen) return;
    const t = setTimeout(() => searchInputRef.current?.focus(), 50);
    return () => clearTimeout(t);
  }, [searchOpen]);

  // Reset the query when the overlay closes. Deriving from the open state avoids
  // clearing on the render that opens it, and needs no setState in the effect.
  const wasSearchOpen = useRef(false);
  useEffect(() => {
    if (wasSearchOpen.current && !searchOpen) {
      setQ("");
      setSuggestionsOpen(false);
      setAnimeSuggestions([]);
      setMovieSuggestions([]);
      setActiveIdx(-1);
    }
    wasSearchOpen.current = searchOpen;
  }, [searchOpen]);

  // Close search on Escape
  useEffect(() => {
    if (!searchOpen) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setSearchOpen(false);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [searchOpen]);

  // Click outside search suggestions to close
  useEffect(() => {
    if (!searchOpen) return;
    function onClick(e: MouseEvent) {
      if (searchWrapRef.current && !searchWrapRef.current.contains(e.target as Node)) setSuggestionsOpen(false);
    }
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [searchOpen]);

  // Cmd/Ctrl+K to open search
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        setSearchOpen(true);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <>
      {/* Pill Nav */}
      <nav className="fixed top-4 left-1/2 -translate-x-1/2 z-50 w-[calc(100%-2rem)] max-w-3xl">
        <div className="bg-surface/80 backdrop-blur-xl border border-border rounded-full px-2 py-1.5 flex items-center gap-1 shadow-lg shadow-black/20">
          {/* Logo */}
          <Link href={`/?tab=${tab}`} className="flex items-center gap-2 shrink-0 pl-2 pr-3 group">
            <svg className="w-7 h-7" viewBox="0 0 32 32" fill="none">
              <circle cx="16" cy="16" r="13" stroke="currentColor" className="text-accent" strokeWidth="2" fill="none" />
              <path d="M16 3L14 14L17 16L13 29" stroke="currentColor" className="text-accent" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" fill="none" />
            </svg>
            <span className="text-base font-bold tracking-tight hidden sm:block">
              <span className="text-accent">Rift</span>
              <span className="text-foreground">Watch</span>
            </span>
          </Link>

           {/* Tab links */}
          <Link href={`/?tab=anime`} className={`px-3 py-1.5 rounded-full text-sm transition-colors ${tab === "anime" ? "bg-surface-hover text-foreground" : "text-text-muted hover:text-foreground hover:bg-surface-hover"}`}>
            Anime
          </Link>
          <Link href={`/?tab=movies`} className={`px-3 py-1.5 rounded-full text-sm transition-colors ${tab === "movies" ? "bg-surface-hover text-foreground" : "text-text-muted hover:text-foreground hover:bg-surface-hover"}`}>
            Movies
          </Link>
          <Link href={`/watchlist?tab=${tab}`} className={`px-3 py-1.5 rounded-full text-sm transition-colors ${pathname === "/watchlist" ? "bg-surface-hover text-foreground" : "text-text-muted hover:text-foreground hover:bg-surface-hover"}`}>
            Watchlist
          </Link>

          {/* Right side icons */}
          <div className="flex items-center gap-0.5 ml-auto">
            {/* Search icon */}
            <button onClick={() => setSearchOpen(true)} className="p-2 rounded-full text-text-muted hover:text-foreground hover:bg-surface-hover transition-colors btn-tap" title="Search (Ctrl+K)">
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
              </svg>
            </button>

            {/* Bell */}
            <div className="relative" ref={notifRef}>
              <button onClick={() => setNotifOpen(!notifOpen)} className="relative p-2 rounded-full text-text-muted hover:text-foreground hover:bg-surface-hover transition-colors btn-tap">
                <svg className={`w-4 h-4 ${unread > 0 ? "text-accent" : ""}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9" />
                </svg>
                {unread > 0 && (
                  <span className="absolute -top-0.5 -right-0.5 bg-accent text-white text-[8px] font-bold w-3.5 h-3.5 flex items-center justify-center rounded-full animate-pulse-glow">
                    {unread > 9 ? "9+" : unread}
                  </span>
                )}
              </button>

              {notifOpen && (
                <div className="absolute right-0 top-full mt-2 w-80 bg-surface border border-border rounded-2xl shadow-xl shadow-black/40 overflow-hidden z-50 animate-menu-in origin-top-right">
                  <div className="flex items-center justify-between px-4 py-2.5 border-b border-border">
                    <span className="text-xs font-semibold text-text-muted uppercase tracking-wide">Notifications</span>
                    {unread > 0 && (
                      <button onClick={handleMarkAllRead} className="text-[10px] text-accent hover:text-accent-hover font-medium transition-colors">
                        Mark all read
                      </button>
                    )}
                  </div>
                  {notifs.length === 0 ? (
                    <div className="px-4 py-6 text-center text-text-secondary text-sm">No notifications yet</div>
                  ) : (
                    <div className="max-h-80 overflow-y-auto divide-y divide-border">
                      {notifs.map((n) => (
                        <div
                          key={n.id}
                          className={`group px-4 py-2.5 hover:bg-surface-hover transition-colors ${!n.read ? "bg-accent/5" : ""}`}
                        >
                          <div className="flex items-start gap-3">
                            <div
                              role="button"
                              tabIndex={0}
                              onClick={() => handleNotifClick(n)}
                              onKeyDown={(e) => {
                                if (e.key === "Enter" || e.key === " ") {
                                  e.preventDefault();
                                  handleNotifClick(n);
                                }
                              }}
                              className="flex items-start gap-3 flex-1 min-w-0 cursor-pointer rounded focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
                            >
                              <div className="relative w-10 h-14 rounded-lg overflow-hidden shrink-0 bg-surface">
                                {n.thumbnail ? <Image src={n.thumbnail} alt="" fill className="object-cover" unoptimized /> : <div className="w-full h-full flex items-center justify-center text-text-muted text-[8px]">N/A</div>}
                              </div>
                              <div className="flex-1 min-w-0">
                                <p className="text-xs font-semibold text-foreground truncate">{n.title}</p>
                                <p className="text-[11px] text-text-muted mt-0.5">{n.body}</p>
                              </div>
                              {!n.read && <span className="w-2 h-2 rounded-full bg-accent shrink-0 mt-1" />}
                            </div>
                            <button
                              type="button"
                              onClick={(e) => handleRemoveNotif(n.id, e)}
                              aria-label="Remove notification"
                              className="shrink-0 mt-0.5 w-5 h-5 flex items-center justify-center rounded-full text-text-muted hover:text-red-500 hover:bg-red-500/10 opacity-0 group-hover:opacity-100 transition-[opacity,color,background-color] z-10"
                            >
                              <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M6 18L18 6M6 6l12 12" /></svg>
                            </button>
                          </div>
                          {(n.hrefSub || n.hrefDub) && (
                            <div className="flex gap-1.5 mt-1.5 ml-[52px]">
                              {n.hrefSub && (
                                <button
                                  onClick={(e) => { e.stopPropagation(); markNotificationRead(n.id); setNotifOpen(false); router.push(n.hrefSub!); }}
                                  className="flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-bold bg-badge-sub/20 text-badge-sub hover:bg-badge-sub/30 transition-colors"
                                >
                                  SUB {n.hrefSub!.match(/ep=(\d+)/)?.[1] ?? ""}
                                </button>
                              )}
                              {n.hrefDub && (
                                <button
                                  onClick={(e) => { e.stopPropagation(); markNotificationRead(n.id); setNotifOpen(false); router.push(n.hrefDub!); }}
                                  className="flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-bold bg-badge-dub/20 text-badge-dub hover:bg-badge-dub/30 transition-colors"
                                >
                                  DUB {n.hrefDub!.match(/ep=(\d+)/)?.[1] ?? ""}
                                </button>
                              )}
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* Theme toggle */}
            <button onClick={toggleTheme} className="p-2 rounded-full text-text-muted hover:text-foreground hover:bg-surface-hover transition-colors btn-tap" title={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}>
              {theme === "dark" ? (
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 3v1m0 16v1m9-9h-1M4 12H3m15.364 6.364l-.707-.707M6.343 6.343l-.707-.707m12.728 0l-.707.707M6.343 17.657l-.707.707M16 12a4 4 0 11-8 0 4 4 0 018 0z" /></svg>
              ) : (
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20.354 15.354A9 9 0 018.646 3.646 9.003 9.003 0 0012 21a9.003 9.003 0 008.354-5.646z" /></svg>
              )}
            </button>

            {/* Random pick (anime: 7+ incl. hidden gems; movies: rated pool) */}
            <button onClick={shuffleRandom} className="p-2 rounded-full text-text-muted hover:text-foreground hover:bg-surface-hover transition-colors btn-tap" title={isMovies ? "Random movie or show" : "Random anime"} aria-label={isMovies ? "Random movie" : "Random anime"}>
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M16 3h5v5M4 20L21 3M21 16v5h-5M15 15l6 6M4 4l5 5" /></svg>
            </button>

            {/* Settings */}
            <Link href="/settings" className={`p-2 rounded-full transition-colors ${pathname === "/settings" ? "bg-surface-hover text-foreground" : "text-text-muted hover:text-foreground hover:bg-surface-hover"}`} title="Settings">
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" /><circle cx="12" cy="12" r="3" strokeWidth={2} /></svg>
            </Link>
          </div>
        </div>
      </nav>

      {/* Search Overlay */}
      {searchOpen && (
        <div className="fixed inset-0 z-[60] bg-background/80 backdrop-blur-xl flex items-start justify-center pt-[18vh] animate-fade-in">
          <div ref={searchWrapRef} className="w-full max-w-2xl px-4">
            <form onSubmit={onSearchSubmit} className="relative">
              <input
                ref={searchInputRef}
                type="text"
                value={q}
                onChange={(e) => onSearchChange(e.target.value)}
                onKeyDown={onSearchKeyDown}
                onFocus={() => { if (suggestions.length > 0) setSuggestionsOpen(true); setActiveIdx(-1); }}
                placeholder={isMovies ? "Search movies & TV shows..." : "Search anime..."}
                className="w-full bg-surface border border-border rounded-2xl px-6 py-4 pr-14 text-foreground text-lg placeholder:text-text-secondary focus:outline-none focus:border-accent focus:ring-2 focus:ring-accent/20 transition-[border-color,box-shadow] shadow-2xl shadow-black/30"
              />
              <button
                type="submit"
                className="absolute right-4 top-1/2 -translate-y-1/2 bg-accent hover:bg-accent-hover text-white p-2.5 rounded-xl transition-colors"
              >
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                </svg>
              </button>

              {suggestionsOpen && suggestions.length > 0 && (
                <div ref={searchListRef} className="absolute top-full left-0 right-0 mt-2 bg-surface border border-border rounded-2xl overflow-hidden shadow-2xl shadow-black/40 max-h-96 overflow-y-auto z-50 animate-menu-in origin-top">
                  {suggestions.map((item, i) => (
                    <button
                      key={String(item.id)}
                      type="button"
                      onMouseDown={() => selectItem(i)}
                      onMouseEnter={() => setActiveIdx(i)}
                      className={`w-full flex items-center gap-3 px-4 py-3 text-left transition-colors ${i === activeIdx ? "bg-surface-hover" : "hover:bg-surface-hover"}`}
                    >
                      <div className="relative w-10 h-14 rounded-lg overflow-hidden bg-background flex-shrink-0">
                        {item.img ? (
                          <Image
                            src={isMovies ? `https://image.tmdb.org/t/p/w185${item.img}` : item.img}
                            alt="" fill className="object-cover" unoptimized
                          />
                        ) : (
                          <div className="w-full h-full flex items-center justify-center text-text-muted text-[9px]">N/A</div>
                        )}
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium truncate">{item.label}</p>
                        {!isMovies && (
                          <div className="flex items-center gap-1.5 mt-0.5">
                            {Number(item.sub) > 0 && (
                              <span className="text-[10px] font-bold bg-badge-sub/90 text-white px-1.5 py-0.5 rounded-full">SUB {item.sub}</span>
                            )}
                            {Number(item.dub) > 0 && (
                              <span className="text-[10px] font-bold bg-badge-dub/90 text-black px-1.5 py-0.5 rounded-full">DUB {item.dub}</span>
                            )}
                          </div>
                        )}
                      </div>
                      <svg className="w-4 h-4 text-text-secondary flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                      </svg>
                    </button>
                  ))}
                </div>
              )}

              {suggestionsOpen && loading && (
                <div className="absolute top-full left-0 right-0 mt-2 bg-surface border border-border rounded-2xl p-4 text-center text-text-muted text-sm shadow-2xl z-50 animate-menu-in origin-top">
                  Searching...
                </div>
              )}

              {!suggestionsOpen && !q.trim() && (commands.length > 0 || recentSearches.length > 0) && (
                <div className="absolute top-full left-0 right-0 mt-2 bg-surface border border-border rounded-2xl overflow-hidden shadow-2xl shadow-black/40 z-50 animate-menu-in origin-top">
                  {commands.length > 0 && (
                    <div className="p-2">
                      <p className="px-2 pb-1 text-[11px] font-medium text-text-secondary uppercase tracking-wide">Actions</p>
                      {commands.map((c, i) => (
                        <button
                          key={c.id}
                          type="button"
                          onMouseDown={c.run}
                          onMouseEnter={() => setActiveIdx(i)}
                          className={`w-full flex items-center justify-between gap-3 px-3 py-2 rounded-lg text-left text-sm transition-colors ${i === activeIdx ? "bg-surface-hover text-foreground" : "text-text-muted hover:bg-surface-hover hover:text-foreground"}`}
                        >
                          <span className="truncate">{c.label}</span>
                          {c.hint && <span className="shrink-0 text-[10px] text-text-secondary">{c.hint}</span>}
                        </button>
                      ))}
                    </div>
                  )}
                  {recentSearches.length > 0 && (
                    <div className={`p-2 ${commands.length > 0 ? "border-t border-border" : ""}`}>
                      <div className="flex items-center justify-between px-2 pb-1">
                        <span className="text-[11px] font-medium text-text-secondary uppercase tracking-wide">Recent</span>
                        <button type="button" onClick={clearRecentSearches} className="text-[11px] text-text-secondary hover:text-accent transition-colors">Clear</button>
                      </div>
                      {recentSearches.map((r, i) => {
                        const idx = commands.length + i;
                        return (
                        <div
                          key={`${r.tab}-${r.q}-${i}`}
                          onMouseEnter={() => setActiveIdx(idx)}
                          className={`w-full flex items-center gap-3 px-2 py-1.5 rounded-lg transition-colors ${idx === activeIdx ? "bg-surface-hover" : "hover:bg-surface-hover"}`}
                        >
                          <button
                            type="button"
                            onMouseDown={() => { setSearchOpen(false); router.push(`/?tab=${r.tab}&q=${encodeURIComponent(r.q)}`); }}
                            className="flex items-center gap-3 flex-1 min-w-0 text-left"
                          >
                            {r.thumb ? (
                              <div className="relative w-8 h-11 rounded-md overflow-hidden bg-background flex-shrink-0">
                                <Image
                                  src={r.tab === "movies" ? `https://image.tmdb.org/t/p/w92${r.thumb}` : r.thumb}
                                  alt="" fill className="object-cover" unoptimized
                                />
                              </div>
                            ) : (
                              <svg className="w-4 h-4 text-text-secondary flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                              </svg>
                            )}
                            <span className="text-sm text-foreground truncate">{r.q}</span>
                            <span className="text-[10px] text-text-secondary bg-background px-1.5 py-0.5 rounded-full flex-shrink-0">{r.tab}</span>
                          </button>
                          <button
                            type="button"
                            onMouseDown={(e) => { e.stopPropagation(); removeRecentSearch(i); }}
                            className="p-1 rounded-md text-text-secondary hover:text-accent hover:bg-surface transition-colors flex-shrink-0"
                          >
                            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                            </svg>
                          </button>
                        </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              )}
            </form>

            <p className="text-center text-text-secondary text-xs mt-4">
              <kbd className="px-1.5 py-0.5 bg-surface border border-border rounded text-[10px] font-mono">ESC</kbd> to close
              <span className="mx-2 text-border">|</span>
              <kbd className="px-1.5 py-0.5 bg-surface border border-border rounded text-[10px] font-mono">Ctrl K</kbd> to search
              <span className="mx-2 text-border">|</span>
              <kbd className="px-1.5 py-0.5 bg-surface border border-border rounded text-[10px] font-mono">↑ ↓</kbd>
              <span className="mx-1">to move</span>
              <kbd className="px-1.5 py-0.5 bg-surface border border-border rounded text-[10px] font-mono">↵</kbd>
              <span className="ml-1">to run</span>
            </p>
          </div>
        </div>
      )}
    </>
  );
}
