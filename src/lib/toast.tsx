"use client";

import { createContext, useContext, useState, useCallback, useEffect, useRef } from "react";

interface Toast {
  id: number;
  message: string;
  type: "success" | "error" | "info";
}

interface ToastCtx {
  toast: (message: string, type?: Toast["type"]) => void;
}

const Ctx = createContext<ToastCtx>({ toast: () => {} });
export const useToast = () => useContext(Ctx);

let nextId = 0;

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  // A toast marked "exiting" plays its leave animation before unmounting,
  // so removal doesn't teleport it off-screen mid-frame.
  const [exiting, setExiting] = useState<Set<number>>(new Set());
  const timers = useRef<Map<number, ReturnType<typeof setTimeout>>>(new Map());

  const dismiss = useCallback((id: number) => {
    setExiting((prev) => new Set(prev).add(id));
    setTimeout(() => {
      setToasts((prev) => prev.filter((x) => x.id !== id));
      setExiting((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }, 200);
  }, []);

  const toast = useCallback((message: string, type: Toast["type"] = "info") => {
    const id = ++nextId;
    setToasts((prev) => [...prev, { id, message, type }]);
    const t = setTimeout(() => {
      dismiss(id);
      timers.current.delete(id);
    }, 3000);
    timers.current.set(id, t);
  }, [dismiss]);

  useEffect(() => {
    // Copy the map so cleanup uses the timers that existed when it ran.
    const pending = timers.current;
    return () => { pending.forEach(clearTimeout); };
  }, []);

  return (
    <Ctx.Provider value={{ toast }}>
      {children}
      <div className="fixed bottom-6 right-6 z-[100] flex flex-col gap-2 pointer-events-none">
        {toasts.map((t) => (
          <div
            key={t.id}
            className={`pointer-events-auto flex items-center gap-2.5 px-4 py-3 rounded-xl text-sm font-medium shadow-2xl shadow-black/40 border ${
              exiting.has(t.id) ? "animate-toast-out" : "animate-toast-in"
            } ${
              t.type === "success" ? "bg-accent/95 border-accent/50 text-white" :
              t.type === "error" ? "bg-red-600/90 border-red-500/30 text-white" :
              "bg-surface/95 border-border text-foreground backdrop-blur-xl"
            }`}
          >
            {t.type === "success" && (
              <svg className="w-4 h-4 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
              </svg>
            )}
            {t.type === "error" && (
              <svg className="w-4 h-4 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M12 9v4m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
              </svg>
            )}
            {t.message}
          </div>
        ))}
      </div>
    </Ctx.Provider>
  );
}
