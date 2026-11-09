/** Read-only rollout report. No network request, DB write or secret value output. */
import { pathToFileURL } from 'node:url';

const SECRET_NAMES = [
  'NEXT_PUBLIC_SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY',
  'STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET',
  'YOUTUBE_OAUTH_CLIENT_ID', 'YOUTUBE_OAUTH_CLIENT_SECRET',
  'YOUTUBE_TOKEN_ENCRYPTION_KEY', 'CLIPS_VOICESTUDIO_API_KEY',
  'CLIPS_SOUNDBOX_PROXY_TOKEN',
];
const FLAGS = [
  'CLIPS_WORKER_ENABLED', 'SHORTS_ANALYSIS_WORKER_ENABLED',
  'YOUTUBE_PUBLISH_WORKER_ENABLED', 'CLIPS_AI_BUDGET_AUTHORIZED',
  'CLIPS_VOICESTUDIO_ENABLED', 'CLIPS_SOUNDBOX_ENABLED',
];
function publicProjectRef(value) {
  try {
    const u = new URL(value);
    return u.protocol === 'https:' && !u.username && !u.password &&
      !u.search && !u.hash && u.pathname === '/' && !u.port
      ? /^([a-z0-9]{20})\.supabase\.co$/u.exec(u.hostname)?.[1] ?? null
      : null;
  } catch { return null; }
}
export function summarizeConfiguration(env, role) {
  if (!['web', 'render', 'analysis', 'youtube'].includes(role)) {
    throw new Error('preflight_role_invalid');
  }
  const secrets = Object.fromEntries(SECRET_NAMES.map(name => [name, Boolean(env[name]?.trim())]));
  const flags = Object.fromEntries(FLAGS.map(name => [name,
    ['true', 'false'].includes(env[name]) ? env[name] : env[name] ? 'other' : 'unset',
  ]));
  const blockers = [];
  const supabaseProjectRef = publicProjectRef(env.NEXT_PUBLIC_SUPABASE_URL);
  if (!supabaseProjectRef) blockers.push('supabase_project_unidentified');
  if (!secrets.SUPABASE_SERVICE_ROLE_KEY) blockers.push('missing_SUPABASE_SERVICE_ROLE_KEY');
  if (role === 'web' && !secrets.NEXT_PUBLIC_SUPABASE_ANON_KEY) {
    blockers.push('missing_NEXT_PUBLIC_SUPABASE_ANON_KEY');
  }
  if (FLAGS.slice(0, 3).some(name => !['false', 'unset'].includes(flags[name]))) {
    blockers.push('canary_processing_enabled');
  }
  if (!['false', 'unset'].includes(flags.CLIPS_AI_BUDGET_AUTHORIZED)) blockers.push('paid_ai_not_closed');
  if (FLAGS.slice(4).some(name => !['false', 'unset'].includes(flags[name]))) blockers.push('canary_audio_enabled');
  let appOnRailway = false;
  try {
    const u = new URL(env.NEXT_PUBLIC_APP_URL);
    appOnRailway = u.protocol === 'https:' && u.hostname.endsWith('.up.railway.app') &&
      !u.username && !u.password && !u.search && !u.hash && u.pathname === '/';
  } catch { /* No URL value is echoed, including invalid input. */ }
  if (role === 'web') {
    if (!appOnRailway) blockers.push('app_origin_not_railway');
    if (env.CLIPS_ENABLED !== 'none') blockers.push('canary_admission_not_closed');
  }
  return {
    schemaVersion: 1, role, supabaseProjectRef, appOnRailway, secrets, flags,
    canaryConfigurationSafe: blockers.length === 0,
    inferenceVerified: false, blockers,
  };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const report = summarizeConfiguration(process.env, process.argv[2] ?? 'render');
    console.log(JSON.stringify(report));
    process.exitCode = report.canaryConfigurationSafe ? 0 : 2;
  } catch {
    console.error(JSON.stringify({ error: 'preflight_role_invalid' }));
    process.exitCode = 2;
  }
}
