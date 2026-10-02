export const ADMIN_ACCOUNT_EMAIL = "abbas.billel1985@gmail.com";

type AdminIdentity = {
  email?: string | null;
  app_metadata?: Record<string, unknown> | null;
  user_metadata?: Record<string, unknown> | null;
};

/** Authorization uses server-owned app_metadata and an explicit email allowlist. */
export function hasAdminAccess(
  user: AdminIdentity | null | undefined,
): boolean {
  return (
    user?.email?.toLowerCase() === ADMIN_ACCOUNT_EMAIL &&
    user.app_metadata?.app_role === "admin"
  );
}
