function normalizePathname(pathname: string): string {
  if (pathname === "/") return pathname;
  return pathname.replace(/\/+$/, "");
}

export function isDashboardNavigationActive(
  pathname: string,
  href: string,
): boolean {
  return normalizePathname(pathname) === normalizePathname(href);
}
