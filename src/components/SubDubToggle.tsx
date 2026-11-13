"use client";

interface SubDubToggleProps {
  mode: "sub" | "dub";
  onChange: (mode: "sub" | "dub") => void;
  subCount: number;
  dubCount: number;
}

export default function SubDubToggle({ mode, onChange, subCount, dubCount }: SubDubToggleProps) {
  return (
    <div className="inline-flex gap-0.5 bg-surface rounded-lg p-0.5">
      <button
        onClick={() => onChange("sub")}
        disabled={subCount === 0}
        className={`px-4 py-1.5 rounded-md text-xs font-bold tracking-wide transition-colors ${
          mode === "sub"
            ? "bg-badge-sub text-white shadow-sm"
            : subCount === 0
              ? "text-text-secondary/40 cursor-not-allowed"
              : "text-text-muted hover:text-foreground"
        }`}
      >
        SUB {subCount > 0 && `(${subCount})`}
      </button>
      <button
        onClick={() => onChange("dub")}
        disabled={dubCount === 0}
        className={`px-4 py-1.5 rounded-md text-xs font-bold tracking-wide transition-colors ${
          mode === "dub"
            ? "bg-badge-dub text-black shadow-sm"
            : dubCount === 0
              ? "text-text-secondary/40 cursor-not-allowed"
              : "text-text-muted hover:text-foreground"
        }`}
      >
        DUB {dubCount > 0 && `(${dubCount})`}
      </button>
    </div>
  );
}
