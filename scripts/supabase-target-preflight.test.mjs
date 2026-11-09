import assert from 'node:assert/strict';
import { test } from 'node:test';
import { auditSupabaseTarget } from './supabase-target-preflight.mjs';
const ref = 'a'.repeat(20);
const other = 'b'.repeat(20);
function jwt(project, role) {
  const part = Buffer.from(JSON.stringify({ ref: project, role })).toString('base64url');
  return `eyJhbGciOiJIUzI1NiJ9.${part}.FAKE_SIGNATURE_TEST_ONLY`;
}
function valid() {
  return {
    CLIPS_EXPECTED_SUPABASE_PROJECT_REF: ref,
    NEXT_PUBLIC_SUPABASE_URL: `https://${ref}.supabase.co`,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: jwt(ref, 'anon'),
    SUPABASE_SERVICE_ROLE_KEY: jwt(ref, 'service_role'),
  };
}
test('accepts coherent legacy claims without claiming authenticated access', () => {
  const report = auditSupabaseTarget(valid(), true);
  assert.equal(report.configurationCoherent, true);
  assert.equal(report.authenticatedAccessVerified, false);
  assert.equal(report.databaseSchemaVerified, false);
  assert.deepEqual(report.blockers, []);
});
test('requires an explicit expected reference', () => {
  const env = valid(); delete env.CLIPS_EXPECTED_SUPABASE_PROJECT_REF;
  assert.ok(auditSupabaseTarget(env).blockers.includes('expected_project_ref_invalid'));
});
test('rejects a different project even when URL and keys are mutually consistent', () => {
  const env = { ...valid(), CLIPS_EXPECTED_SUPABASE_PROJECT_REF: other };
  assert.ok(auditSupabaseTarget(env).blockers.includes('supabase_target_mismatch'));
});
test('rejects wrong-project service and anon keys separately', () => {
  for (const [key, role] of [['SUPABASE_SERVICE_ROLE_KEY','service_role'], ['NEXT_PUBLIC_SUPABASE_ANON_KEY','anon']]) {
    const env = { ...valid(), [key]: jwt(other, role) };
    assert.ok(auditSupabaseTarget(env, true).blockers.includes(`${key}_project_mismatch`));
  }
});
test('refuses an administrative JWT in the browser key', () => {
  const env = { ...valid(), NEXT_PUBLIC_SUPABASE_ANON_KEY: jwt(ref, 'service_role') };
  assert.ok(auditSupabaseTarget(env, true).blockers.includes('NEXT_PUBLIC_SUPABASE_ANON_KEY_role_mismatch'));
});
test('refuses a publishable key in the privileged server slot', () => {
  const env = { ...valid(), SUPABASE_SERVICE_ROLE_KEY: 'sb_publishable_test_only' };
  assert.equal(auditSupabaseTarget(env).configurationCoherent, false);
});
test('rejects malformed credential and endpoint inputs without reflecting them', () => {
  for (const suffix of ['?token=DO_NOT_ECHO', '#DO_NOT_ECHO', '/rest/v1', ':8443']) {
    const url = `https://${ref}.supabase.co${suffix}`;
    const result = auditSupabaseTarget({ ...valid(), NEXT_PUBLIC_SUPABASE_URL: url });
    assert.equal(result.configurationCoherent, false);
    assert.ok(!JSON.stringify(result).includes('DO_NOT_ECHO'));
  }
  for (const key of ['bad.payload.jwt','not-a-key','', 'eyJ.'+'x'.repeat(20000)+'.fake']) {
    assert.equal(auditSupabaseTarget({ ...valid(), SUPABASE_SERVICE_ROLE_KEY: key }).configurationCoherent, false);
  }
});
test('modern opaque keys are supported but their project binding stays unverified', () => {
  const result = auditSupabaseTarget({ ...valid(),
    NEXT_PUBLIC_SUPABASE_ANON_KEY: 'sb_publishable_TEST_ONLY',
    SUPABASE_SERVICE_ROLE_KEY: 'sb_secret_TEST_ONLY',
  }, true);
  assert.equal(result.configurationCoherent, true);
  assert.equal(result.keyProjectClaimsChecked, false);
  assert.equal(result.authenticatedAccessVerified, false);
  assert.ok(result.warnings.includes('opaque_key_project_binding_requires_runtime_check'));
});
test('workers may omit the public key but web must supply it', () => {
  const env = valid(); delete env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  assert.equal(auditSupabaseTarget(env).configurationCoherent, true);
  assert.equal(auditSupabaseTarget(env, true).configurationCoherent, false);
});
test('never serializes credential values or payloads', () => {
  const env = valid();
  const result = JSON.stringify(auditSupabaseTarget(env, true));
  for (const key of ['SUPABASE_SERVICE_ROLE_KEY','NEXT_PUBLIC_SUPABASE_ANON_KEY']) {
    assert.ok(!result.includes(env[key]));
    assert.ok(!result.includes(env[key].split('.')[1]));
  }
  assert.ok(!result.includes('FAKE_SIGNATURE'));
});
