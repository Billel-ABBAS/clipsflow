/** Read-only typo/misrouting guard. It does NOT authenticate keys or verify a DB. */
import { pathToFileURL } from 'node:url';
const REF = /^[a-z0-9]{20}$/u;
function projectFromUrl(value) {
  try {
    const u = new URL(value);
    if (u.protocol !== 'https:' || u.username || u.password || u.port ||
        u.pathname !== '/' || u.search || u.hash) return null;
    return /^([a-z0-9]{20})\.supabase\.co$/u.exec(u.hostname)?.[1] ?? null;
  } catch { return null; }
}
/** Credential payloads are decoded only as configuration hints, never trusted auth. */
function keyHints(value, expectedRole) {
  if (typeof value !== 'string' || value.length > 8192) return { kind: 'invalid' };
  const key = value.trim();
  const modern = expectedRole === 'anon' ? /^sb_publishable_[A-Za-z0-9_-]{1,256}$/u
    : /^sb_secret_[A-Za-z0-9_-]{1,256}$/u;
  if (modern.test(key)) return { kind: 'opaque' };
  const parts = key.split('.');
  if (parts.length !== 3 || parts.some(p => !/^[A-Za-z0-9_-]+$/u.test(p))) return { kind: 'invalid' };
  try {
    const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    if (!claims || typeof claims !== 'object' || !REF.test(claims.ref ?? '')) return { kind: 'invalid' };
    return { kind: 'legacy', ref: claims.ref, role: claims.role };
  } catch { return { kind: 'invalid' }; }
}
export function auditSupabaseTarget(env = {}, publicKeyRequired = false) {
  const rawExpected = env.CLIPS_EXPECTED_SUPABASE_PROJECT_REF;
  const expectedProjectRef = typeof rawExpected === 'string' && REF.test(rawExpected) ? rawExpected : null;
  const actualProjectRef = projectFromUrl(env.NEXT_PUBLIC_SUPABASE_URL);
  const blockers = [], warnings = [];
  if (!expectedProjectRef) blockers.push('expected_project_ref_invalid');
  if (!actualProjectRef) blockers.push('supabase_url_invalid');
  if (expectedProjectRef && actualProjectRef && expectedProjectRef !== actualProjectRef) blockers.push('supabase_target_mismatch');
  let keyProjectClaimsChecked = true;
  const keys = [['SUPABASE_SERVICE_ROLE_KEY', 'service_role']];
  if (publicKeyRequired || env.NEXT_PUBLIC_SUPABASE_ANON_KEY) keys.push(['NEXT_PUBLIC_SUPABASE_ANON_KEY', 'anon']);
  for (const [name, role] of keys) {
    const hints = keyHints(env[name], role);
    if (hints.kind === 'invalid') {
      blockers.push(`${name}_invalid`); keyProjectClaimsChecked = false;
    } else if (hints.kind === 'opaque') {
      keyProjectClaimsChecked = false;
      if (!warnings.length) warnings.push('opaque_key_project_binding_requires_runtime_check');
    } else {
      if (hints.ref !== actualProjectRef) blockers.push(`${name}_project_mismatch`);
      if (hints.role !== role) blockers.push(`${name}_role_mismatch`);
    }
  }
  return {
    schemaVersion: 1, expectedProjectRef, actualProjectRef,
    configurationCoherent: blockers.length === 0, keyProjectClaimsChecked,
    authenticatedAccessVerified: false, databaseSchemaVerified: false,
    blockers, warnings,
  };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const report = auditSupabaseTarget(process.env, process.argv[2] === 'web');
  console.log(JSON.stringify(report));
  process.exitCode = report.configurationCoherent ? 0 : 2;
}
