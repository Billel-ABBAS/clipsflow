"use client";

import {
  CreditCard,
  Film,
  Gauge,
  Library,
  ShieldCheck,
  Sparkles,
} from "lucide-react";

import { Link, usePathname } from "@/i18n/navigation";
import { isDashboardNavigationActive } from "@/lib/dashboard-navigation";
import { cn } from "@/lib/utils";

export type DashboardNavigationLabels = {
  mainNavigation: string;
  workspaceSection: string;
  creationSection: string;
  accountSection: string;
  dashboard: string;
  library: string;
  createClip: string;
  shorts: string;
  pricing: string;
  admin: string;
};

type DashboardNavigationProps = {
  labels: DashboardNavigationLabels;
  isShortsEnabled: boolean;
  isAdmin: boolean;
};

type NavigationItemProps = {
  href:
    | "/dashboard"
    | "/clips"
    | "/clips/new"
    | "/shorts"
    | "/pricing"
    | "/admin";
  label: string;
  pathname: string;
  icon: React.ReactNode;
  variant: "sidebar" | "topbar";
};

function NavigationItem({
  href,
  label,
  pathname,
  icon,
  variant,
}: NavigationItemProps) {
  const active = isDashboardNavigationActive(pathname, href);

  return (
    <Link
      href={href}
      aria-label={label}
      aria-current={active ? "page" : undefined}
      className={cn(
        "group focus-visible:ring-ring focus-visible:ring-offset-background relative inline-flex shrink-0 items-center gap-2.5 rounded-md border border-transparent font-medium transition-colors focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none",
        variant === "sidebar"
          ? "min-h-10 w-full px-3 py-2 text-sm"
          : "min-h-9 px-2.5 py-2 text-xs whitespace-nowrap sm:text-sm",
        active
          ? "border-primary/30 bg-primary/10 text-foreground before:bg-primary before:absolute before:inset-y-2 before:left-0 before:w-0.5 before:rounded-full"
          : "text-muted-foreground hover:bg-accent/70 hover:text-foreground",
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          "inline-flex shrink-0 items-center justify-center",
          variant === "sidebar" ? "size-4" : "size-4",
          active
            ? "text-primary"
            : "text-muted-foreground group-hover:text-foreground",
        )}
      >
        {icon}
      </span>
      <span
        className={variant === "topbar" ? "sr-only sm:not-sr-only" : undefined}
      >
        {label}
      </span>
    </Link>
  );
}

export function DashboardTopNavigation({
  labels,
  isShortsEnabled,
  isAdmin,
}: DashboardNavigationProps) {
  const pathname = usePathname();

  return (
    <nav
      aria-label={labels.mainNavigation}
      className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto xl:hidden"
    >
      <NavigationItem
        href="/dashboard"
        label={labels.dashboard}
        pathname={pathname}
        icon={<Gauge className="size-4" />}
        variant="topbar"
      />
      <NavigationItem
        href="/clips"
        label={labels.library}
        pathname={pathname}
        icon={<Library className="size-4" />}
        variant="topbar"
      />
      <NavigationItem
        href="/clips/new"
        label={labels.createClip}
        pathname={pathname}
        icon={<Film className="size-4" />}
        variant="topbar"
      />
      {isShortsEnabled ? (
        <NavigationItem
          href="/shorts"
          label={labels.shorts}
          pathname={pathname}
          icon={<Sparkles className="size-4" />}
          variant="topbar"
        />
      ) : null}
      <NavigationItem
        href="/pricing"
        label={labels.pricing}
        pathname={pathname}
        icon={<CreditCard className="size-4" />}
        variant="topbar"
      />
      {isAdmin ? (
        <NavigationItem
          href="/admin"
          label={labels.admin}
          pathname={pathname}
          icon={<ShieldCheck className="size-4" />}
          variant="topbar"
        />
      ) : null}
    </nav>
  );
}

export function DashboardSidebar({
  labels,
  isShortsEnabled,
  isAdmin,
}: DashboardNavigationProps) {
  const pathname = usePathname();

  return (
    <aside className="border-border/80 bg-card/45 hidden w-60 shrink-0 border-r xl:flex xl:flex-col">
      <div className="sticky top-16 flex h-[calc(100vh-4rem)] flex-col gap-7 overflow-y-auto px-4 py-6">
        <nav aria-label={labels.mainNavigation} className="space-y-2">
          <p className="text-muted-foreground px-3 text-[10px] font-semibold tracking-[0.18em] uppercase">
            {labels.workspaceSection}
          </p>
          <div className="space-y-1">
            <NavigationItem
              href="/dashboard"
              label={labels.dashboard}
              pathname={pathname}
              icon={<Gauge className="size-4" />}
              variant="sidebar"
            />
            <NavigationItem
              href="/clips"
              label={labels.library}
              pathname={pathname}
              icon={<Library className="size-4" />}
              variant="sidebar"
            />
          </div>
        </nav>

        <nav aria-label={labels.creationSection} className="space-y-2">
          <p className="text-muted-foreground px-3 text-[10px] font-semibold tracking-[0.18em] uppercase">
            {labels.creationSection}
          </p>
          <div className="space-y-1">
            <NavigationItem
              href="/clips/new"
              label={labels.createClip}
              pathname={pathname}
              icon={<Film className="size-4" />}
              variant="sidebar"
            />
            {isShortsEnabled ? (
              <NavigationItem
                href="/shorts"
                label={labels.shorts}
                pathname={pathname}
                icon={<Sparkles className="size-4" />}
                variant="sidebar"
              />
            ) : null}
          </div>
        </nav>

        <nav aria-label={labels.accountSection} className="space-y-2">
          <p className="text-muted-foreground px-3 text-[10px] font-semibold tracking-[0.18em] uppercase">
            {labels.accountSection}
          </p>
          <div className="space-y-1">
            <NavigationItem
              href="/pricing"
              label={labels.pricing}
              pathname={pathname}
              icon={<CreditCard className="size-4" />}
              variant="sidebar"
            />
            {isAdmin ? (
              <NavigationItem
                href="/admin"
                label={labels.admin}
                pathname={pathname}
                icon={<ShieldCheck className="size-4" />}
                variant="sidebar"
              />
            ) : null}
          </div>
        </nav>
      </div>
    </aside>
  );
}
