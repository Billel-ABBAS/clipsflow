import type { ClipStatus } from "./types";

const STATUS_CLASS_NAMES: Record<ClipStatus, string> = {
  pending: "border-border/80 bg-secondary/60 text-muted-foreground",
  processing: "border-cyan-400/30 bg-cyan-400/10 text-cyan-200",
  completing: "border-primary/35 bg-primary/10 text-[#b5a7ff]",
  completed: "border-[#36f0cf]/25 bg-[#36f0cf]/10 text-[#36f0cf]",
  failed: "border-destructive/30 bg-destructive/10 text-destructive",
};

export function getGalleryStatusClassName(status: ClipStatus): string {
  return STATUS_CLASS_NAMES[status];
}

export function getGalleryScoreClassName(score: number): string {
  if (score >= 80) return "bg-[#36f0cf]/10 text-[#36f0cf]";
  if (score >= 50) return "bg-amber-300/10 text-amber-200";
  return "bg-destructive/10 text-destructive";
}

export function getGalleryCardSelectionClassName(selected: boolean): string {
  return selected
    ? "border-primary/60 bg-primary/[0.035] ring-primary/30 ring-1"
    : "";
}
