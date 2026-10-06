import { NextResponse } from "next/server";
import { z } from "zod";

import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

const createSchema = z.strictObject({
  name: z.string().trim().min(1).max(80),
});

export async function GET(): Promise<Response> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const { data, error } = await createAdminClient()
    .from("clip_collections")
    .select("id, name, clip_collection_items(clip_id)")
    .eq("user_id", user.id)
    .order("created_at", { ascending: true });
  if (error) {
    return NextResponse.json(
      { error: "collections_unavailable" },
      { status: 503 },
    );
  }

  const collections = (data ?? []).map((row) => {
    const items = row.clip_collection_items as { clip_id: string }[] | null;
    return {
      id: row.id as string,
      name: row.name as string,
      clip_ids: (items ?? []).map((item) => item.clip_id),
    };
  });
  return NextResponse.json(
    { data: collections },
    { headers: { "Cache-Control": "private, no-store" } },
  );
}

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
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "validation_error" }, { status: 400 });
  }

  const { data, error } = await createAdminClient()
    .from("clip_collections")
    .insert({ user_id: user.id, name: parsed.data.name })
    .select("id, name")
    .single();
  if (error?.code === "23505") {
    return NextResponse.json({ error: "collection_exists" }, { status: 409 });
  }
  if (error || !data) {
    return NextResponse.json(
      { error: "collection_create_failed" },
      { status: 500 },
    );
  }
  return NextResponse.json({ data }, { status: 201 });
}
