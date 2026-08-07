import { createNavigation } from "next-intl/navigation";

import { routing } from "./routing";

// Wrappers typés locale-aware — toujours importer Link/useRouter d'ici,
// jamais de next/link ou next/navigation directement dans les pages localisées.
export const { Link, redirect, usePathname, useRouter, getPathname } =
  createNavigation(routing);
