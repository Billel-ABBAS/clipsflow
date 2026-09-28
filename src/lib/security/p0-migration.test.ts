import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  join(
    process.cwd(),
    "supabase/migrations/20260816133249_p0_security_hardening.sql",
  ),
  "utf8",
).replace(/\s+/g, " ");

describe("migration P0 — frontière de mutation", () => {
  it.each(["profiles", "episodes", "clips", "jobs"])(
    "maintient la RLS forcée sur public.%s",
    (table) => {
      expect(migration).toMatch(
        new RegExp(
          `ALTER TABLE public\\.${table} FORCE ROW LEVEL SECURITY`,
          "i",
        ),
      );
    },
  );

  it("supprime les policies navigateur de création et de mutation du pipeline", () => {
    expect(migration).toMatch(/DROP POLICY IF EXISTS "episodes_insert_own"/i);
    expect(migration).toMatch(/DROP POLICY IF EXISTS "episodes_update_own"/i);
    expect(migration).toMatch(/DROP POLICY IF EXISTS "clips_insert_own"/i);
    expect(migration).toMatch(/DROP POLICY IF EXISTS "clips_update_own"/i);
    expect(migration).toMatch(/DROP POLICY IF EXISTS "jobs_insert_own"/i);
    expect(migration).toMatch(
      /REVOKE INSERT, UPDATE ON TABLE public\.episodes, public\.clips FROM anon, authenticated/i,
    );
  });

  it("n'accorde au profil que les colonnes utilisateur non sensibles", () => {
    expect(migration).toMatch(
      /REVOKE UPDATE ON TABLE public\.profiles FROM anon, authenticated/i,
    );
    expect(migration).toMatch(
      /GRANT UPDATE \(email, full_name, locale\) ON TABLE public\.profiles TO authenticated/i,
    );
    for (const column of [
      "plan",
      "stripe_customer_id",
      "subscription_status",
      "clip_seconds_used_this_month",
      "clip_quota_reset_at",
    ]) {
      expect(migration).toContain(
        `NEW.${column} IS DISTINCT FROM OLD.${column}`,
      );
    }
  });

  it("expose clips_submit_job au seul service_role avec un search_path vide", () => {
    expect(migration).toMatch(
      /CREATE OR REPLACE FUNCTION public\.clips_submit_job[\s\S]*SECURITY DEFINER SET search_path = ''/i,
    );
    expect(migration).toMatch(
      /REVOKE ALL ON FUNCTION public\.clips_submit_job\([^)]+\) FROM PUBLIC/i,
    );
    expect(migration).toMatch(
      /REVOKE ALL ON FUNCTION public\.clips_submit_job\([^)]+\) FROM anon, authenticated/i,
    );
    expect(migration).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.clips_submit_job\([^)]+\) TO service_role/i,
    );
  });

  it("réserve le quota et crée clip plus job dans la même fonction", () => {
    expect(migration).toMatch(
      /UPDATE public\.profiles[\s\S]*clip_seconds_used_this_month[\s\S]*RETURNING/i,
    );
    expect(migration).toMatch(/INSERT INTO public\.clips/i);
    expect(migration).toMatch(/INSERT INTO public\.jobs/i);
    expect(migration).toContain("'quota_exceeded'");
  });

  it("stocke le rate limit derrière un RPC service_role atomique", () => {
    expect(migration).toMatch(/CREATE TABLE public\.api_rate_limits/i);
    expect(migration).toMatch(
      /ALTER TABLE public\.api_rate_limits FORCE ROW LEVEL SECURITY/i,
    );
    expect(migration).toMatch(
      /CREATE OR REPLACE FUNCTION public\.consume_api_rate_limit[\s\S]*SECURITY DEFINER SET search_path = ''/i,
    );
    expect(migration).toMatch(/ON CONFLICT \(key\) DO UPDATE/i);
    expect(migration).toMatch(
      /REVOKE ALL ON FUNCTION public\.consume_api_rate_limit\([^)]+\) FROM PUBLIC/i,
    );
    expect(migration).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.consume_api_rate_limit\([^)]+\) TO service_role/i,
    );
  });

  it("rend les événements Stripe idempotents et les profils monotones", () => {
    expect(migration).toMatch(/CREATE TABLE public\.stripe_webhook_events/i);
    expect(migration).toMatch(
      /ALTER TABLE public\.stripe_webhook_events FORCE ROW LEVEL SECURITY/i,
    );
    expect(migration).toMatch(
      /CREATE OR REPLACE FUNCTION public\.stripe_claim_webhook_event[\s\S]*ON CONFLICT \(event_id\) DO UPDATE/i,
    );
    expect(migration).toMatch(
      /CREATE OR REPLACE FUNCTION public\.stripe_apply_profile_event[\s\S]*stripe_event_created_at <= p_event_created/i,
    );
    for (const status of [
      "incomplete",
      "incomplete_expired",
      "trialing",
      "active",
      "past_due",
      "canceled",
      "unpaid",
      "paused",
    ]) {
      expect(migration).toContain(`'${status}'`);
    }
    for (const functionName of [
      "stripe_claim_webhook_event",
      "stripe_complete_webhook_event",
      "stripe_fail_webhook_event",
      "stripe_apply_profile_event",
    ]) {
      expect(migration).toMatch(
        new RegExp(
          `REVOKE ALL ON FUNCTION public\\.${functionName}\\([^)]+\\) FROM PUBLIC`,
          "i",
        ),
      );
      expect(migration).toMatch(
        new RegExp(
          `GRANT EXECUTE ON FUNCTION public\\.${functionName}\\([^)]+\\) TO service_role`,
          "i",
        ),
      );
    }
  });
});
