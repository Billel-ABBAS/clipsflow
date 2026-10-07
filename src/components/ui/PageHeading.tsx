import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

type PageHeadingProps = {
  eyebrow?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  variant?: "plain" | "panel";
  alignment?: "split" | "start" | "center";
  titleSize?: "default" | "compact";
  className?: string;
};

export function PageHeading({
  eyebrow,
  title,
  description,
  actions,
  variant = "plain",
  alignment = "split",
  titleSize = "default",
  className,
}: PageHeadingProps) {
  const centered = alignment === "center";

  return (
    <header
      className={cn(
        "flex flex-col gap-5",
        centered
          ? "items-center text-center"
          : alignment === "split" && actions
            ? "md:flex-row md:items-end md:justify-between"
            : "items-start",
        variant === "panel" &&
          "border-border/80 from-card via-card to-primary/10 relative overflow-hidden rounded-2xl border bg-gradient-to-br p-5 sm:p-7 lg:p-8",
        className,
      )}
    >
      <div
        className={cn(
          "min-w-0 space-y-2.5",
          centered && "mx-auto max-w-3xl",
          variant === "panel" && "relative",
        )}
      >
        {eyebrow ? (
          <p className="text-brand-lavender text-[10px] font-semibold tracking-[0.2em] uppercase">
            {eyebrow}
          </p>
        ) : null}
        <h1
          className={cn(
            "font-heading leading-tight font-semibold tracking-tight",
            titleSize === "compact"
              ? "text-2xl sm:text-3xl"
              : "text-3xl sm:text-4xl",
          )}
        >
          {title}
        </h1>
        {description ? (
          <p className="text-muted-foreground max-w-2xl text-sm leading-relaxed sm:text-base">
            {description}
          </p>
        ) : null}
      </div>
      {actions ? (
        <div
          className={cn(
            "flex w-full shrink-0 flex-wrap items-center gap-2 md:w-auto",
            centered ? "justify-center" : "md:justify-end",
          )}
        >
          {actions}
        </div>
      ) : null}
    </header>
  );
}
