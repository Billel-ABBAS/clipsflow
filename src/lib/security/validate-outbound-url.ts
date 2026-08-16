import { lookup as nodeLookup } from "node:dns/promises";
import { isIP } from "node:net";

export class OutboundUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OutboundUrlError";
  }
}

const BLOCKED_HOSTNAMES = new Set([
  "localhost",
  "metadata",
  "metadata.google.internal",
]);
const BLOCKED_TLD_SUFFIXES = [".internal", ".local", ".localhost"];

function canonicalHostname(hostname: string): string {
  const unwrapped =
    hostname.startsWith("[") && hostname.endsWith("]")
      ? hostname.slice(1, -1)
      : hostname;
  return unwrapped.toLowerCase().replace(/\.$/, "");
}

function parseIpv4(address: string): number | null {
  const parts = address.split(".");
  if (parts.length !== 4) return null;
  const octets = parts.map((part) => {
    if (!/^\d{1,3}$/.test(part)) return null;
    const value = Number(part);
    return value >= 0 && value <= 255 ? value : null;
  });
  if (octets.some((value) => value === null)) return null;
  return (octets as number[]).reduce(
    (result, value) => result * 256 + value,
    0,
  );
}

function ipv4InCidr(value: number, base: string, prefix: number): boolean {
  const baseValue = parseIpv4(base);
  if (baseValue === null) return false;
  const shift = 32 - prefix;
  return Math.floor(value / 2 ** shift) === Math.floor(baseValue / 2 ** shift);
}

function isPublicIpv4(address: string): boolean {
  const value = parseIpv4(address);
  if (value === null) return false;
  const blockedCidrs: Array<[string, number]> = [
    ["0.0.0.0", 8],
    ["10.0.0.0", 8],
    ["100.64.0.0", 10],
    ["127.0.0.0", 8],
    ["169.254.0.0", 16],
    ["172.16.0.0", 12],
    ["192.0.0.0", 24],
    ["192.0.2.0", 24],
    ["192.168.0.0", 16],
    ["198.18.0.0", 15],
    ["198.51.100.0", 24],
    ["203.0.113.0", 24],
    ["224.0.0.0", 4],
    ["240.0.0.0", 4],
  ];
  return !blockedCidrs.some(([base, prefix]) =>
    ipv4InCidr(value, base, prefix),
  );
}

function parseIpv6(address: string): number[] | null {
  const withoutZone = address.split("%", 1)[0] ?? address;
  if (withoutZone.includes(".")) return null;
  if ((withoutZone.match(/::/g) ?? []).length > 1) return null;

  const [leftRaw, rightRaw] = withoutZone.split("::");
  const left = leftRaw ? leftRaw.split(":") : [];
  const right = rightRaw ? rightRaw.split(":") : [];
  const hasCompression = withoutZone.includes("::");
  if (
    (!hasCompression && left.length !== 8) ||
    left.length + right.length > 8
  ) {
    return null;
  }
  const missing = hasCompression ? 8 - left.length - right.length : 0;
  if (hasCompression && missing < 1) return null;
  const groups = [...left, ...Array<string>(missing).fill("0"), ...right];
  if (
    groups.length !== 8 ||
    groups.some((group) => !/^[0-9a-f]{1,4}$/i.test(group))
  ) {
    return null;
  }

  return groups.map((group) => Number.parseInt(group, 16));
}

function isPublicIpv6(address: string): boolean {
  const groups = parseIpv6(address);
  if (groups === null) return false;
  // Fail closed: only ordinary global-unicast 2000::/3 is routable here.
  if ((groups[0]! & 0xe000) !== 0x2000) return false;

  if (groups[0] === 0x2001 && groups[1] === 0x0db8) return false;
  // Teredo and 6to4 can tunnel otherwise blocked IPv4 destinations.
  if (groups[0] === 0x2001 && groups[1] === 0) return false;
  if (groups[0] === 0x2002) return false;
  return true;
}

export function isPublicIpAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return isPublicIpv4(address);
  if (family === 6) return isPublicIpv6(address);
  return false;
}

function isBlockedHostname(hostname: string): boolean {
  const host = canonicalHostname(hostname);
  if (BLOCKED_HOSTNAMES.has(host)) return true;
  if (BLOCKED_TLD_SUFFIXES.some((suffix) => host.endsWith(suffix))) return true;
  return isIP(host) !== 0 && !isPublicIpAddress(host);
}

export interface ValidateOutboundUrlOptions {
  /** Exact host or subdomain suffixes accepted for this request. */
  allowedHosts?: string[];
}

export function validateOutboundUrl(
  raw: string,
  options: ValidateOutboundUrlOptions = {},
): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new OutboundUrlError("Invalid outbound URL");
  }

  if (url.protocol !== "https:") {
    throw new OutboundUrlError("Only HTTPS outbound URLs are allowed");
  }
  if (url.username || url.password) {
    throw new OutboundUrlError("URL credentials are forbidden");
  }
  if (url.port) {
    throw new OutboundUrlError("Non-standard HTTPS ports are forbidden");
  }
  if (isBlockedHostname(url.hostname)) {
    throw new OutboundUrlError("Private or reserved destination blocked");
  }

  if (options.allowedHosts !== undefined) {
    const host = canonicalHostname(url.hostname);
    const allowed = options.allowedHosts
      .map(canonicalHostname)
      .filter(Boolean)
      .some((entry) => host === entry || host.endsWith(`.${entry}`));
    if (!allowed) {
      throw new OutboundUrlError("Destination is outside the allowlist");
    }
  }

  return url;
}

export interface DnsAnswer {
  address: string;
  family: number;
}

export type DnsLookup = (hostname: string) => Promise<readonly DnsAnswer[]>;

const defaultLookup: DnsLookup = async (hostname) =>
  nodeLookup(hostname, { all: true, verbatim: true });

/** Resolve every A/AAAA answer and fail if any target is non-public. */
export async function assertPublicDns(
  url: URL,
  lookup: DnsLookup = defaultLookup,
): Promise<void> {
  const hostname = canonicalHostname(url.hostname);
  if (isIP(hostname)) {
    if (!isPublicIpAddress(hostname)) {
      throw new OutboundUrlError("Private or reserved destination blocked");
    }
    return;
  }

  let answers: readonly DnsAnswer[];
  try {
    answers = await lookup(hostname);
  } catch {
    throw new OutboundUrlError("DNS resolution failed");
  }
  if (
    answers.length === 0 ||
    answers.some((answer) => !isPublicIpAddress(answer.address))
  ) {
    throw new OutboundUrlError("DNS resolved to a private or reserved address");
  }
}

/** Return only the exact configured ClipsFlow Supabase project hostname. */
export function defaultClipsAllowedHosts(): string[] {
  const raw = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!raw) return [];
  try {
    const url = new URL(raw);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.port ||
      isBlockedHostname(url.hostname)
    ) {
      return [];
    }
    return [canonicalHostname(url.hostname)];
  } catch {
    return [];
  }
}
