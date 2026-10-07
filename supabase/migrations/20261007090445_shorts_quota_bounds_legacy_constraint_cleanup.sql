-- The original quota migration created a singularly named 20-minute–2-hour
-- check. The 1-minute–4-hour migration added a second (plural-named) check but
-- left the original in place, so PostgreSQL still rejected longer sources.
-- Keep the widened canonical constraint and remove only the obsolete guard.
ALTER TABLE public.shorts_analysis_quota_reservations
  DROP CONSTRAINT IF EXISTS shorts_analysis_quota_reservation_source_duration_seconds_check;
