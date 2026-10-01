# Archived Supabase migrations

`20260925000000_explicit_data_api_grants.superseded.sql` is retained for audit
history, but is intentionally outside `supabase/migrations/`: the connected
Supabase project's applied migration registry has no entry for it. Its table
grants are re-established by the registered `restrict_data_api_roles`
migration (`20260928203332`), which also applies the required revocations and
policy restrictions. Do not replay the archived file independently.

The active migration filenames are aligned to the 11 versions recorded in
`supabase_migrations.schema_migrations`. This alignment changed repository
filenames only; it did not execute or repair any remote SQL migration.
