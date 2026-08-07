"use client";

// ============================================================================
// ReclipMenu — re-render / duplicate actions on completed clip cards.
// Ported from VidiaFlow src/components/clipflow/ReclipMenu.tsx.
// Adaptations : i18n namespace → clips.reclip ; the "no quota debit within
// 24h" hint is dropped (ClipsFlow P1 always debits quota — keeping the hint
// would be a lie) ; route param stays `/clips/new?dup=<clipId>` — the
// studio reads the param and pre-fills from the original `clips` row.
//
//   • Re-render in another style → /clips/new?dup=<clipId>
//   • Duplicate as 1:1            → /clips/new?dup=<clipId>&aspect=1:1
//   • Duplicate as 9:16           → /clips/new?dup=<clipId>&aspect=9:16
// ============================================================================

import { useEffect, useRef, useState } from "react";
import { MoreVertical } from "lucide-react";
import { useTranslations } from "next-intl";

import { useRouter } from "@/i18n/navigation";

interface ReclipMenuProps {
  clipId: string;
  /** Current aspect ratio of the source clip — used to hide redundant
   *  "duplicate as same ratio" entries. */
  currentAspect: string | null;
}

export function ReclipMenu({ clipId, currentAspect }: ReclipMenuProps) {
  const t = useTranslations("clips.reclip");
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onEsc);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onEsc);
    };
  }, [open]);

  const go = (params: string) => {
    router.push(`/clips/new?dup=${clipId}${params ? `&${params}` : ""}`);
  };

  return (
    <div
      ref={ref}
      className="relative inline-flex"
      data-testid="clips-reclip-menu"
    >
      <button
        type="button"
        aria-label={t("menu_aria")}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((p) => !p)}
        data-testid="clips-reclip-trigger"
        className="border-border bg-background text-foreground hover:bg-muted inline-flex h-8 w-8 items-center justify-center rounded-md border"
      >
        <MoreVertical className="h-4 w-4" />
      </button>
      {open && (
        <div
          role="menu"
          className="border-border bg-card absolute top-full right-0 z-10 mt-1.5 min-w-[240px] rounded-md border p-1 shadow-lg"
        >
          <MenuItem onClick={() => go("")}>{t("rerender_style")}</MenuItem>
          {currentAspect !== "1:1" && (
            <MenuItem onClick={() => go("aspect=1:1")}>
              {t("duplicate_square")}
            </MenuItem>
          )}
          {currentAspect !== "9:16" && (
            <MenuItem onClick={() => go("aspect=9:16")}>
              {t("duplicate_portrait")}
            </MenuItem>
          )}
        </div>
      )}
    </div>
  );
}

function MenuItem({
  onClick,
  children,
}: {
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      className="text-foreground hover:bg-muted block w-full rounded px-3 py-2 text-left text-xs"
    >
      {children}
    </button>
  );
}
