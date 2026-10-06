import { NextResponse } from "next/server";
import { z } from "zod";

import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

const bodySchema = z.strictObject({ collection_id: z.uuid().nullable() });

export async function PUT(
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

  const { data, error } = await createAdminClient().rpc(
    "clips_set_collection",
    {
      p_user_id: user.id,
      p_clip_id: clipId,
      p_collection_id: parsed.data.collection_id,
    },
  );
  if (error || data === "clip_not_found") {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  if (data === "collection_not_found") {
    return NextResponse.json(
      { error: "collection_not_found" },
      { status: 404 },
    );
  }
  if (data !== "ok") {
    return NextResponse.json(
      { error: "collection_update_failed" },
      { status: 500 },
    );
  }
  return NextResponse.json({
    data: { clip_id: clipId, collection_id: parsed.data.collection_id },
  });
}
