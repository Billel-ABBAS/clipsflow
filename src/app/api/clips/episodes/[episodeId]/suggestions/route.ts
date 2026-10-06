import { NextResponse } from "next/server";
import { z } from "zod";

import { suggestClipMoments } from "@/lib/clips/suggestions";
import { createClient } from "@/lib/supabase/server";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ episodeId: string }> },
): Promise<Response> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const { episodeId } = await params;
  if (!z.uuid().safeParse(episodeId).success) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  const { data: episode } = await supabase
    .from("episodes")
    .select("id")
    .eq("id", episodeId)
    .eq("user_id", user.id)
    .maybeSingle();
  if (!episode) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  const { data: clip, error } = await supabase
    .from("clips")
    .select("start_seconds, end_seconds, transcript_segments")
    .eq("episode_id", episodeId)
    .eq("user_id", user.id)
    .eq("status", "completed")
    .not("transcript_segments", "is", null)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) {
    return NextResponse.json(
      { error: "suggestions_unavailable" },
      { status: 503 },
    );
  }
  if (!clip || !Array.isArray(clip.transcript_segments)) {
    return NextResponse.json(
      { data: [] },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  }

  const data = suggestClipMoments(
    clip.transcript_segments,
    clip.start_seconds,
    clip.end_seconds,
  );
  return NextResponse.json(
    { data },
    { headers: { "Cache-Control": "private, no-store" } },
  );
}
