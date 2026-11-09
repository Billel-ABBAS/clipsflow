import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeConfiguration } from './railway-rollout-preflight.mjs';
const base = {
  NEXT_PUBLIC_SUPABASE_URL: 'https://abcdefghijklmnopqrst.supabase.co',
  NEXT_PUBLIC_APP_URL: 'https://clipsflow-web-railway-canary-production.up.railway.app',
  SUPABASE_SERVICE_ROLE_KEY: 'never-print-service-secret',
  CLIPS_ENABLED: 'none', CLIPS_WORKER_ENABLED: 'false',
  SHORTS_ANALYSIS_WORKER_ENABLED: 'false', YOUTUBE_PUBLISH_WORKER_ENABLED: 'false',
  CLIPS_AI_BUDGET_AUTHORIZED: 'false', CLIPS_VOICESTUDIO_ENABLED: 'false',
  CLIPS_SOUNDBOX_ENABLED: 'false',
};
test('reports only public project reference and secret presence', () => {
  const r = summarizeConfiguration(base, 'render');
  assert.equal(r.supabaseProjectRef, 'abcdefghijklmnopqrst');
  assert.equal(r.secrets.SUPABASE_SERVICE_ROLE_KEY, true);
  assert.equal(JSON.stringify(r).includes('never-print-service-secret'), false);
});
test('refuses to validate an active canary', () => {
  const r = summarizeConfiguration({ ...base, CLIPS_WORKER_ENABLED: 'true' }, 'render');
  assert.ok(r.blockers.includes('canary_processing_enabled'));
});
test('requires the role-specific provider credentials', () => {
  const r = summarizeConfiguration({ ...base, SUPABASE_SERVICE_ROLE_KEY: '' }, 'render');
  assert.ok(r.blockers.includes('missing_SUPABASE_SERVICE_ROLE_KEY'));
});
test('never serializes credentials in malformed URLs', () => {
  const r = summarizeConfiguration({ ...base, NEXT_PUBLIC_SUPABASE_URL: 'https://user:hidden@x.supabase.co' }, 'web');
  assert.equal(r.supabaseProjectRef, null);
  assert.equal(JSON.stringify(r).includes('hidden'), false);
});
test('does not claim audio is ready from the enabled flag', () => {
  const r = summarizeConfiguration({ ...base, CLIPS_VOICESTUDIO_ENABLED: 'true' }, 'web');
  assert.equal(r.inferenceVerified, false);
  assert.ok(r.blockers.includes('canary_audio_enabled'));
});
test('validates role instead of printing arbitrary user input', () => {
  assert.throws(() => summarizeConfiguration(base, 'unknown-role'), /preflight_role_invalid/);
});
test('does not report an external app origin as Railway-ready', () => {
  const r = summarizeConfiguration({ ...base, NEXT_PUBLIC_APP_URL: 'https://clipsflow.vercel.app' }, 'web');
  assert.ok(r.blockers.includes('app_origin_not_railway'));
});
test('closed render canary with required credentials passes configuration check only', () => {
  const r = summarizeConfiguration(base, 'render');
  assert.equal(r.canaryConfigurationSafe, true);
  assert.deepEqual(r.blockers, []);
  assert.equal(r.inferenceVerified, false);
});
