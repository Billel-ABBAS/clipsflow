const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

function invalidOrigin(): never {
  throw new Error("trusted_app_url:invalid");
}

/** Return the one configured application origin used for redirects. */
export function getTrustedAppUrl(): URL {
  const raw = process.env.NEXT_PUBLIC_APP_URL?.trim();
  const production = process.env.NODE_ENV === "production";
  if (!raw) {
    if (production) throw new Error("trusted_app_url:missing");
    return new URL("http://localhost:3000");
  }

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return invalidOrigin();
  }

  if (
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    return invalidOrigin();
  }

  if (url.protocol !== "https:") {
    const localDevelopment =
      !production && url.protocol === "http:" && LOCAL_HOSTS.has(url.hostname);
    if (!localDevelopment) return invalidOrigin();
  }

  return new URL(url.origin);
}

function isSafeRelativePath(value: string): boolean {
  return (
    value.startsWith("/") &&
    !value.startsWith("//") &&
    !/[\\\u0000-\u001f\u007f]/.test(value) &&
    !/%(?:2f|5c)/i.test(value)
  );
}

/** Accept a single-origin path or fall back to a known internal path. */
export function safeRelativePath(
  raw: string | null | undefined,
  fallback: string,
): string {
  if (!isSafeRelativePath(fallback)) {
    throw new Error("trusted_app_url:invalid_fallback");
  }
  if (!raw || !isSafeRelativePath(raw)) return fallback;
  return raw;
}
