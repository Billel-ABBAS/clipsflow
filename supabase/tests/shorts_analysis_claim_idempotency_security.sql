\set ON_ERROR_STOP on

BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA public;
SELECT plan(11);

SELECT ok(pg_catalog.to_regclass('public.shorts_analysis_claim_requests') IS NOT NULL,
  'the private claim idempotency ledger exists');
SELECT ok((SELECT relrowsecurity AND relforcerowsecurity
  FROM pg_catalog.pg_class
  WHERE oid = 'public.shorts_analysis_claim_requests'::regclass),
  'the claim idempotency ledger enforces RLS');
SELECT ok(
  NOT has_table_privilege('anon', 'public.shorts_analysis_claim_requests', 'SELECT')
  AND NOT has_table_privilege('authenticated', 'public.shorts_analysis_claim_requests', 'SELECT')
  AND NOT has_table_privilege('service_role', 'public.shorts_analysis_claim_requests', 'SELECT')
  AND NOT has_table_privilege('anon', 'public.shorts_analysis_claim_requests', 'INSERT')
  AND NOT has_table_privilege('authenticated', 'public.shorts_analysis_claim_requests', 'INSERT')
  AND NOT has_table_privilege('service_role', 'public.shorts_analysis_claim_requests', 'INSERT')
  AND NOT has_table_privilege('anon', 'public.shorts_analysis_claim_requests', 'UPDATE')
  AND NOT has_table_privilege('authenticated', 'public.shorts_analysis_claim_requests', 'UPDATE')
  AND NOT has_table_privilege('service_role', 'public.shorts_analysis_claim_requests', 'UPDATE')
  AND NOT has_table_privilege('anon', 'public.shorts_analysis_claim_requests', 'DELETE')
  AND NOT has_table_privilege('authenticated', 'public.shorts_analysis_claim_requests', 'DELETE')
  AND NOT has_table_privilege('service_role', 'public.shorts_analysis_claim_requests', 'DELETE'),
  'API roles have no direct access to the internal claim ledger');
SELECT ok((SELECT count(*) = 2
  FROM pg_catalog.pg_constraint
  WHERE conrelid = 'public.shorts_analysis_claim_requests'::regclass
    AND convalidated
    AND conname IN (
      'shorts_analysis_claim_requests_outcome_check',
      'shorts_analysis_claim_requests_outcome_lease_check'
    )), 'the ledger outcome and lease checks are present and validated');
SELECT ok(has_function_privilege(
  'service_role', 'public.shorts_claim_analysis_job_idempotent(uuid,integer)', 'EXECUTE'),
  'service_role can invoke the idempotent claim RPC');
SELECT ok(
  NOT has_function_privilege('anon', 'public.shorts_claim_analysis_job_idempotent(uuid,integer)', 'EXECUTE')
  AND NOT has_function_privilege('authenticated', 'public.shorts_claim_analysis_job_idempotent(uuid,integer)', 'EXECUTE'),
  'browser roles cannot invoke the idempotent claim RPC');
SELECT ok(pg_catalog.to_regprocedure('public.shorts_claim_analysis_job(integer)') IS NOT NULL,
  'the legacy claim RPC remains available during rolling deployment');
SELECT ok(has_function_privilege(
  'service_role', 'public.shorts_claim_analysis_job(integer)', 'EXECUTE'),
  'service_role retains access to the legacy claim RPC');
SELECT ok(
  NOT has_function_privilege('anon', 'public.shorts_claim_analysis_job(integer)', 'EXECUTE')
  AND NOT has_function_privilege('authenticated', 'public.shorts_claim_analysis_job(integer)', 'EXECUTE'),
  'browser roles cannot invoke the legacy claim RPC');
SELECT throws_ok(
  $$SELECT * FROM public.shorts_claim_analysis_job_idempotent(
    '00000000-0000-4000-8000-000000000020', NULL
  )$$,
  '22023', 'lease_seconds_out_of_range',
  'the idempotent claim RPC rejects a null lease duration');
SELECT throws_ok($$SELECT * FROM public.shorts_claim_analysis_job(NULL)$$,
  '22023', 'lease_seconds_out_of_range',
  'the legacy claim RPC rejects a null lease duration');

ROLLBACK;
