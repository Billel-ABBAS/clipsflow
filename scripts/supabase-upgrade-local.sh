#!/usr/bin/env bash
# Disposable CI only. No linked project, remote host, credentials or DB target flags.
set -euo pipefail
[[ "${CI:-}" == true && "${GITHUB_ACTIONS:-}" == true && "${CLIPS_EPHEMERAL_DB_TEST:-}" == true ]] || { echo 'ephemeral_ci_only' >&2; exit 78; }
[[ -z "${SUPABASE_ACCESS_TOKEN:-}" && -z "${SUPABASE_DB_PASSWORD:-}" && -z "${DATABASE_URL:-}" ]] || { echo 'remote_credentials_forbidden' >&2; exit 78; }
[[ ! -f supabase/.temp/project-ref ]] || { echo 'linked_project_forbidden' >&2; exit 78; }
[[ -n "${RUNNER_TEMP:-}" ]] || exit 78
pending=$(mktemp -d "$RUNNER_TEMP/clips-upgrade.XXXXXX")
cleanup() {
  pnpm exec supabase stop --no-backup >/dev/null 2>&1 || true
  for f in "$pending"/*.sql; do [[ ! -f "$f" ]] || mv "$f" supabase/migrations/; done
  rmdir "$pending" 2>/dev/null || true
}
trap cleanup EXIT
for f in supabase/migrations/*.sql; do
  name=$(basename "$f")
  [[ "$name" < 20261000000000 ]] || mv "$f" "$pending/"
done
count=$(find "$pending" -maxdepth 1 -name '*.sql' | wc -l)
[[ "$count" -eq 17 ]] || { echo "unexpected_pending_count:$count" >&2; exit 1; }
pnpm exec supabase --version
pnpm exec supabase start --help >/dev/null
pnpm exec supabase db reset --help >/dev/null
pnpm exec supabase migration up --help >/dev/null
pnpm exec supabase start >"$RUNNER_TEMP/clips-local-start.log" 2>&1 || { tail -n 35 "$RUNNER_TEMP/clips-local-start.log"; exit 1; }
pnpm exec supabase db reset --local --no-seed
local_url='postgresql://postgres:postgres@127.0.0.1:55322/postgres'
psql "$local_url" -X -v ON_ERROR_STOP=1 -f scripts/seed-upgrade-baseline.sql
# First prove that the unchanged legacy schema cannot pass the new acceptance test.
set +e
psql "$local_url" -X -v ON_ERROR_STOP=1 -f scripts/verify-upgraded-audio-schema.sql >"$RUNNER_TEMP/upgrade-red.log" 2>&1
code=$?
set -e
if [[ "$code" -eq 0 ]] || ! grep -q UPGRADE_NOT_APPLIED "$RUNNER_TEMP/upgrade-red.log"; then
  echo 'legacy_acceptance_did_not_fail_as_expected' >&2; exit 1
fi
echo 'EXPECTED_RED: new audio schema absent in legacy baseline'
for f in "$pending"/*.sql; do mv "$f" supabase/migrations/; done
# Local-only CLI records the real sequence; never repair hosted history here.
pnpm exec supabase migration up --local
psql "$local_url" -X -v ON_ERROR_STOP=1 -f scripts/verify-upgraded-audio-schema.sql
pnpm exec supabase test db
