-- Long-form Shorts uploads use Supabase Storage's TUS endpoint. The signed
-- upload token remains scoped to a single owner-prefixed path; this bucket
-- limit is intentionally lower than Supabase's 50 GB TUS transfer ceiling.
-- Operators must also set the project's global Storage limit to at least
-- 8 GiB in Storage Settings (the global limit cannot be raised by this SQL).
-- Railway/worker temporary storage must be provisioned for the same source
-- ceiling plus the derived audio, frames, and render output.

UPDATE storage.buckets
SET file_size_limit = 8589934592
WHERE id = 'clip-sources';
