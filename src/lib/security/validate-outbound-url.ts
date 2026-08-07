// ============================================================================
// validateOutboundUrl — SSRF guard for user-supplied URLs
// ============================================================================
// Defense against Server-Side Request Forgery attacks where an attacker
// tricks our server into fetching internal resources :
//   - cloud metadata endpoints (169.254.169.254 etc.)
//   - localhost / loopback (127.0.0.0/8)
//   - link-local (169.254.0.0/16)
//   - private RFC1918 ranges (10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16)
//   - non-HTTPS schemes (file://, gopher://, ftp://)
//
// Ported from VidiaFlow src/lib/utils/validate-outbound-url.ts (unchanged
// logic). The `defaultClipflowAllowedHosts` function is renamed to
// `defaultClipsAllowedHosts` for ClipsFlow naming consistency.
// ============================================================================

export class OutboundUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OutboundUrlError";
  }
}

const BLOCKED_HOSTNAMES = new Set([
  "localhost",
  "0.0.0.0",
  "169.254.169.254", // AWS / GCP / Azure metadata
  "metadata.google.internal",
  "metadata", // some k8s clusters expose plain "metadata"
]);

const BLOCKED_TLD_SUFFIXES = [".internal", ".local", ".localhost"];

/**
 * Returns true if hostname is a private/internal IP or domain.
 * Blocks IPv4 RFC1918 + loopback + link-local + IPv6 ULA + reserved.
 */
function isBlockedHost(hostname: string): boolean {
  const stripped =
    hostname.startsWith("[") && hostname.endsWith("]")
      ? hostname.slice(1, -1)
      : hostname;
  const lower = stripped.toLowerCase();

  if (BLOCKED_HOSTNAMES.has(lower)) return true;
  if (BLOCKED_TLD_SUFFIXES.some((s) => lower.endsWith(s))) return true;

  // IPv4 check
  const ipv4 = lower.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4) {
    const oct1 = parseInt(ipv4[1]!, 10);
    const oct2 = parseInt(ipv4[2]!, 10);

    if (oct1 === 127) return true; // 127.0.0.0/8 loopback
    if (oct1 === 10) return true; // 10.0.0.0/8 RFC1918
    if (oct1 === 172 && oct2 >= 16 && oct2 <= 31) return true; // 172.16/12
    if (oct1 === 192 && oct2 === 168) return true; // 192.168/16
    if (oct1 === 169 && oct2 === 254) return true; // link-local
    if (oct1 === 0) return true; // reserved
    if (oct1 === 100 && oct2 >= 64 && oct2 <= 127) return true; // CGNAT
    if (oct1 >= 224 && oct1 <= 239) return true; // multicast
    if (oct1 >= 240) return true; // reserved

    return false;
  }

  // IPv6 — block loopback, ULA, link-local
  if (lower === "::1" || lower === "::") return true;
  if (lower.startsWith("fc") || lower.startsWith("fd")) return true;
  if (
    lower.startsWith("fe8") ||
    lower.startsWith("fe9") ||
    lower.startsWith("fea") ||
    lower.startsWith("feb")
  ) {
    return true;
  }
  // IPv4-mapped IPv6 (::ffff:127.0.0.1 etc.)
  if (lower.startsWith("::ffff:") || lower.startsWith("::ffff.")) {
    const tail = lower.slice(7);
    if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(tail)) {
      return isBlockedHost(tail);
    }
    return true;
  }

  return false;
}

export interface ValidateOutboundUrlOptions {
  /**
   * If provided, the hostname MUST match one of these (or a subdomain
   * thereof). When omitted, any public hostname is allowed.
   */
  allowedHosts?: string[];
}

/**
 * Validates an outbound URL. Throws OutboundUrlError if blocked.
 * Returns the parsed URL on success.
 *
 * Pre-checks (always enforced) :
 *   - Must parse as a URL.
 *   - Protocol must be https:.
 *   - Hostname must NOT be in the private/loopback/link-local block list.
 */
export function validateOutboundUrl(
  raw: string,
  options: ValidateOutboundUrlOptions = {},
): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new OutboundUrlError(`Invalid URL : ${raw.slice(0, 100)}`);
  }

  if (url.protocol !== "https:") {
    throw new OutboundUrlError(
      `Non-HTTPS URL blocked : ${url.protocol}//${url.hostname}`,
    );
  }

  if (isBlockedHost(url.hostname)) {
    throw new OutboundUrlError(`Blocked hostname : ${url.hostname}`);
  }

  if (options.allowedHosts && options.allowedHosts.length > 0) {
    const host = url.hostname.toLowerCase();
    const ok = options.allowedHosts.some((entry) => {
      const e = entry.toLowerCase();
      return host === e || host.endsWith(`.${e}`);
    });
    if (!ok) {
      throw new OutboundUrlError(
        `Hostname ${url.hostname} not in allowlist : ${options.allowedHosts.join(", ")}`,
      );
    }
  }

  return url;
}

/**
 * Returns the list of host suffixes considered "Supabase Storage" for
 * the purposes of the ClipsFlow clips source-video guard. Includes the
 * project's own Supabase URL hostname when the env var is set, plus
 * generic Supabase host suffixes used by signed-URL downloads.
 */
export function defaultClipsAllowedHosts(): string[] {
  const hosts: string[] = ["supabase.co", "supabase.in"];

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (supabaseUrl) {
    try {
      const u = new URL(supabaseUrl);
      if (u.hostname && !hosts.includes(u.hostname)) {
        hosts.push(u.hostname);
      }
    } catch {
      // Env var malformed — fall back to generic suffixes.
    }
  }

  return hosts;
}
