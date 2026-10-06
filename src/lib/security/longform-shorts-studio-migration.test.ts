import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  join(
    process.cwd(),
    "supabase/migrations/20261003172541_longform_shorts_studio.sql",
  ),
  "utf8",
).replace(/\s+/g, " ");

describe("migration studio Shorts long format", () => {
  const privateTables = [
    "shorts_projects",
    "shorts_candidates",
    "shorts_audio_assets",
    "shorts_analysis_jobs",
    "youtube_connections",
    "shorts_publications",
  ];

  it("conserve les projets, suggestions et publications sous le même propriétaire", () => {
    expect(migration).toMatch(
      /CREATE TABLE public\.shorts_candidates[\s\S]*?FOREIGN KEY \(project_id, user_id\)[\s\S]*?REFERENCES public\.shorts_projects\(id, user_id\) ON DELETE CASCADE/i,
    );
    expect(migration).toMatch(
      /CREATE TABLE public\.shorts_publications[\s\S]*?FOREIGN KEY \(clip_id, user_id\)[\s\S]*?REFERENCES public\.clips\(id, user_id\) ON DELETE CASCADE/i,
    );
    expect(migration).toMatch(
      /FOREIGN KEY \(youtube_connection_id, user_id\)[\s\S]*?REFERENCES public\.youtube_connections\(id, user_id\) ON DELETE CASCADE/i,
    );
  });

  it("borne les longues sources, les extraits et les instructions", () => {
    expect(migration).toMatch(
      /jev_shadow_consent boolean NOT NULL DEFAULT false/i,
    );
    expect(migration).toMatch(/source_duration_seconds BETWEEN 1200 AND 7200/i);
    expect(migration).toMatch(
      /end_seconds - start_seconds BETWEEN 10 AND 180/i,
    );
    expect(migration).toMatch(/char_length\(user_instructions\) <= 1200/i);
    expect(migration).toMatch(/analysis_mode IN \('audio', 'audio_video'\)/i);
    expect(migration).toMatch(
      /music_mood text NOT NULL CHECK \(music_mood IN \([\s\S]*?'focused'[\s\S]*?'minimal'/i,
    );
    expect(migration).toMatch(
      /motion_direction text NOT NULL CHECK \(char_length\(motion_direction\) BETWEEN 1 AND 160\)/i,
    );
    expect(migration).toMatch(
      /CREATE TABLE public\.shorts_projects \([\s\S]*?transcript_text text[\s\S]*?transcript_segments jsonb[\s\S]*?jsonb_array_length\(transcript_segments\) <= 120000/i,
    );
    expect(migration).toMatch(
      /OR\s+\(\s*CASE\s+WHEN jsonb_typeof\(p_transcript_segments\) = 'array'[\s\S]*?END\s+\)\s+THEN/i,
    );
  });

  it("met les analyses longues dans une queue leasee et idempotente", () => {
    expect(migration).toMatch(
      /CREATE TABLE public\.shorts_analysis_jobs[\s\S]*?lease_token uuid[\s\S]*?lease_expires_at timestamptz/i,
    );
    expect(migration).toMatch(
      /CREATE OR REPLACE FUNCTION public\.shorts_submit_analysis_job\([\s\S]*?pg_catalog\.pg_advisory_xact_lock/i,
    );
    expect(migration).toMatch(
      /p_jev_shadow_consent boolean[\s\S]*?v_project\.jev_shadow_consent IS DISTINCT FROM COALESCE\(p_jev_shadow_consent, false\)/i,
    );
    expect(migration).toMatch(
      /shorts_submit_analysis_job\(uuid, uuid, text, integer, text, boolean, uuid\)/i,
    );
    for (const functionName of [
      "shorts_submit_analysis_job",
      "shorts_claim_analysis_job",
      "shorts_renew_analysis_lease",
      "shorts_mark_analysis_analyzing",
      "shorts_complete_analysis_job",
      "shorts_fail_analysis_job",
      "shorts_set_selected_candidates",
    ]) {
      expect(migration).toMatch(
        new RegExp(`CREATE OR REPLACE FUNCTION public\\.${functionName}`, "i"),
      );
      expect(migration).toMatch(
        new RegExp(
          `REVOKE ALL ON FUNCTION public\\.${functionName}\\([^)]+\\) FROM PUBLIC, anon, authenticated`,
          "i",
        ),
      );
    }
    expect(migration).toMatch(
      /shorts_set_selected_candidates[\s\S]*?candidate_not_in_project/i,
    );
    expect(migration).toMatch(
      /shorts_complete_analysis_job[\s\S]*?transcript_segments = p_transcript_segments/i,
    );
    expect(migration).toMatch(
      /INSERT INTO public\.shorts_candidates \([\s\S]*?music_mood,[\s\S]*?motion_direction,[\s\S]*?entry\.value ->> 'music_mood',[\s\S]*?entry\.value ->> 'motion_direction'/i,
    );
  });

  it("n'expose ni analyses privées ni tokens OAuth à la Data API", () => {
    for (const table of privateTables) {
      expect(migration).toMatch(
        new RegExp(
          `ALTER TABLE public\\.${table} ENABLE ROW LEVEL SECURITY`,
          "i",
        ),
      );
      expect(migration).toMatch(
        new RegExp(
          `ALTER TABLE public\\.${table} FORCE ROW LEVEL SECURITY`,
          "i",
        ),
      );
      expect(migration).toMatch(
        new RegExp(
          `REVOKE ALL ON TABLE public\\.${table} FROM PUBLIC, anon, authenticated`,
          "i",
        ),
      );
      expect(migration).toMatch(
        new RegExp(
          `GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public\\.${table} TO service_role`,
          "i",
        ),
      );
    }
    expect(migration).toMatch(/refresh_token_ciphertext text NOT NULL/i);
    expect(migration).not.toMatch(/refresh_token text NOT NULL/i);
    expect(migration).toMatch(
      /provider IN \('elevenlabs', 'licensed_catalog'\)/i,
    );
    expect(migration).toMatch(/kind IN \('music', 'sound_effect'\)/i);
    expect(migration).toMatch(/prompt_hash text CHECK/i);
    expect(migration).toMatch(/visibility text NOT NULL DEFAULT 'private'/i);
  });
});
