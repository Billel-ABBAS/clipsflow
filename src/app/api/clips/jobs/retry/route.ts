import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { z } from "zod";

import { isClipsEnabled, isClipsWorkerEnabled } from "@/lib/clips/feature-flag";
import { routing } from "@/i18n/routing";
import { checkDistributedRateLimit } from "@/lib/rate-limit-distributed";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

const bodySchema = z.strictObject({ clip_id: z.uuid() });

export async function POST(request: Request): Promise<Response> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "validation_error" }, { status: 400 });
  }
  const suppliedRequestId = request.headers.get("Idempotency-Key");
  if (suppliedRequestId && !z.uuid().safeParse(suppliedRequestId).success) {
    return NextResponse.json(
      { error: "invalid_idempotency_key" },
      { status: 400 },
    );
  }
  const requestId = suppliedRequestId ?? randomUUID();

  const cookieStore = await cookies();
  const locale = cookieStore.get("NEXT_LOCALE")?.value ?? routing.defaultLocale;
  if (!isClipsEnabled({ locale, userId: user.id })) {
    return NextResponse.json({ error: "not_yet_available" }, { status: 403 });
  }
  if (!isClipsWorkerEnabled()) {
    return NextResponse.json(
      { error: "rendering_temporarily_unavailable", retry_after_seconds: 300 },
      { status: 503, headers: { "Retry-After": "300" } },
    );
  }

  const admin = createAdminClient();
  let rateLimit;
  try {
    rateLimit = await checkDistributedRateLimit(
      admin,
      `retry:${user.id}`,
      10,
      60,
    );
  } catch {
    return NextResponse.json(
      { error: "rate_limit_unavailable" },
      { status: 503 },
    );
  }
  if (!rateLimit.allowed) {
    return NextResponse.json(
      { error: "rate_limited" },
      {
        status: 429,
        headers: { "Retry-After": rateLimit.retryAfterSeconds.toString() },
      },
    );
  }

  const { data, error } = await admin.rpc("clips_retry_failed_job", {
    p_user_id: user.id,
    p_source_clip_id: parsed.data.clip_id,
    p_request_id: requestId,
  });
  if (error || !Array.isArray(data) || data.length !== 1) {
    return NextResponse.json({ error: "retry_unavailable" }, { status: 503 });
  }

  const result = data[0] as {
    clip_id?: unknown;
    job_id?: unknown;
    remaining_seconds?: unknown;
    error_code?: unknown;
  };
  if (result.error_code === "quota_exceeded") {
    return NextResponse.json(
      {
        error: "quota_exceeded",
        remaining:
          typeof result.remaining_seconds === "number"
            ? result.remaining_seconds
            : 0,
      },
      { status: 402 },
    );
  }
  if (
    result.error_code === "budget_exceeded" ||
    result.error_code === "budget_unconfigured"
  ) {
    return NextResponse.json(
      { error: "rendering_temporarily_unavailable", retry_after_seconds: 300 },
      { status: 503, headers: { "Retry-After": "300" } },
    );
  }
  if (result.error_code === "not_retryable") {
    return NextResponse.json({ error: "not_retryable" }, { status: 409 });
  }
  if (typeof result.clip_id !== "string" || typeof result.job_id !== "string") {
    return NextResponse.json({ error: "retry_unavailable" }, { status: 503 });
  }

  const { data: clip } = await admin
    .from("clips")
    .select("status")
    .eq("id", result.clip_id)
    .eq("user_id", user.id)
    .maybeSingle();
  const status = typeof clip?.status === "string" ? clip.status : "pending";

  return NextResponse.json(
    {
      data: {
        clip_id: result.clip_id,
        job_id: result.job_id,
        status,
      },
    },
    {
      status: status === "completed" || status === "failed" ? 200 : 202,
      headers: { "Cache-Control": "private, no-store" },
    },
  );
}
