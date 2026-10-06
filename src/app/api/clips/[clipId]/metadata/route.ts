import { NextResponse } from "next/server";
import { z } from "zod";

import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

const bodySchema = z
  .strictObject({
    title_override: z.string().trim().max(120).nullable().optional(),
    is_favorite: z.boolean().optional(),
  })
  .refine(
    (value) =>
      value.title_override !== undefined || value.is_favorite !== undefined,
    { message: "At least one metadata field is required" },
  );

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ clipId: string }> },
): Promise<Response> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const { clipId } = await params;
  if (!z.uuid().safeParse(clipId).success) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
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

  const admin = createAdminClient();
  const { data, error } = await admin
    .from("clips")
    .update(parsed.data)
    .eq("id", clipId)
    .eq("user_id", user.id)
    .select("id, title_override, is_favorite")
    .maybeSingle();
  if (error) {
    return NextResponse.json(
      { error: "metadata_update_failed" },
      { status: 500 },
    );
  }
  if (!data) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  return NextResponse.json({ data });
}
