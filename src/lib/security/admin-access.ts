type AdminIdentity = {
  app_metadata?: Record<string, unknown> | null;
  user_metadata?: Record<string, unknown> | null;
};

/** Only server-owned app_metadata may grant administrative access. */
export function hasAdminAccess(
  user: AdminIdentity | null | undefined,
): boolean {
  return user?.app_metadata?.app_role === "admin";
}
