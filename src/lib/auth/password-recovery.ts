const supportedLocales = new Set(["en", "fr"]);

export function getPasswordRecoveryRedirectUrl(
  appOrigin: string,
  locale: string,
): string {
  if (!supportedLocales.has(locale)) {
    throw new Error("unsupported_recovery_locale");
  }

  const callbackUrl = new URL("/api/auth/callback", appOrigin);
  callbackUrl.searchParams.set("next", `/${locale}/reset-password`);
  return callbackUrl.toString();
}

export function validateRecoveryPassword(
  password: string,
  confirmation: string,
): "too_short" | "mismatch" | null {
  if (password.length < 8) return "too_short";
  if (password !== confirmation) return "mismatch";
  return null;
}
