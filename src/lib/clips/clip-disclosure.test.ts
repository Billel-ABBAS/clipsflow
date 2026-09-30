import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  CLIP_SUBTITLE_DISCLOSURE_SURFACE,
  CLIP_SUBTITLE_DISCLOSURE_VERSION,
  ClipDisclosureError,
  recordClipSubtitleDisclosure,
} from "./clip-disclosure";

function disclosureClient(error: { message: string } | null = null) {
  const upsert = vi.fn().mockResolvedValue({ error });
  const from = vi.fn().mockReturnValue({ upsert });
  return { client: { from } as unknown as SupabaseClient, from, upsert };
}

describe("recordClipSubtitleDisclosure", () => {
  it("writes only bounded audit metadata and is idempotent across worker resumes", async () => {
    const { client, from, upsert } = disclosureClient();

    await expect(
      recordClipSubtitleDisclosure(client, {
        userId: "user-1",
        clipId: "clip-1",
        locale: "fr",
      }),
    ).resolves.toBeUndefined();

    expect(from).toHaveBeenCalledWith("ai_disclosure_events");
    expect(upsert).toHaveBeenCalledWith(
      {
        user_id: "user-1",
        clip_id: "clip-1",
        surface: CLIP_SUBTITLE_DISCLOSURE_SURFACE,
        disclosure_version: CLIP_SUBTITLE_DISCLOSURE_VERSION,
        metadata: {
          content_kind: "generated_subtitle_overlay",
          locale: "fr",
          renderer: "railway",
        },
      },
      {
        onConflict: "clip_id,surface,disclosure_version",
        ignoreDuplicates: true,
      },
    );
    expect(JSON.stringify(upsert.mock.calls[0][0])).not.toMatch(
      /transcript|signedUrl|source_url/i,
    );
  });

  it("fails closed without leaking database details when the audit insert fails", async () => {
    const { client } = disclosureClient({
      message: "sensitive postgres detail must not reach a user-facing job",
    });

    const error = await recordClipSubtitleDisclosure(client, {
      userId: "user-1",
      clipId: "clip-1",
      locale: "en",
    }).catch((failure: unknown) => failure);

    expect(error).toBeInstanceOf(ClipDisclosureError);
    expect(error).toMatchObject({ code: "disclosure_log_failed" });
    expect((error as Error).message).not.toContain("sensitive postgres detail");
  });
});
