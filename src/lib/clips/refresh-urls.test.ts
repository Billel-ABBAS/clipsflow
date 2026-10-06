import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";

import { refreshClipUrls } from "./refresh-urls";

type StorageResponse = {
  data: { path: string; signedUrl: string | null }[] | null;
  error: { message: string } | null;
};

function storageClient(response: {
  playback: StorageResponse;
  download?: StorageResponse;
}) {
  const createSignedUrls = vi.fn(
    (
      _paths: string[],
      _expiresIn: number,
      options?: { download?: string | boolean },
    ) =>
      Promise.resolve(
        options?.download
          ? (response.download ?? response.playback)
          : response.playback,
      ),
  );
  const from = vi.fn(() => ({ createSignedUrls }));
  return {
    client: { storage: { from } } as unknown as SupabaseClient,
    from,
    createSignedUrls,
  };
}

describe("refreshClipUrls", () => {
  it("remplace les URL expirées à partir des chemins de stockage", async () => {
    const { client, from, createSignedUrls } = storageClient({
      playback: {
        data: [
          { path: "u1/clip-a.mp4", signedUrl: "https://storage/new.mp4" },
          { path: "u1/clip-a.vtt", signedUrl: "https://storage/new.vtt" },
        ],
        error: null,
      },
      download: {
        data: [
          {
            path: "u1/clip-a.mp4",
            signedUrl: "https://storage/new.mp4?download=",
          },
          {
            path: "u1/clip-a.vtt",
            signedUrl: "https://storage/new.vtt?download=",
          },
        ],
        error: null,
      },
    });
    const clips = [
      {
        id: "clip-a",
        video_url: "https://storage/old.mp4?token=expired",
        video_download_url: null,
        video_storage_path: "u1/clip-a.mp4",
        captions_vtt_url: "https://storage/old.vtt?token=expired",
        captions_vtt_download_url: null,
        captions_vtt_storage_path: "u1/clip-a.vtt",
      },
    ];

    const refreshed = await refreshClipUrls(client, clips);

    expect(from).toHaveBeenCalledWith("clip-outputs");
    expect(createSignedUrls).toHaveBeenCalledWith(
      ["u1/clip-a.mp4", "u1/clip-a.vtt"],
      86_400,
    );
    expect(createSignedUrls).toHaveBeenCalledWith(
      ["u1/clip-a.mp4", "u1/clip-a.vtt"],
      86_400,
      { download: true },
    );
    expect(refreshed[0]?.video_url).toBe("https://storage/new.mp4");
    expect(refreshed[0]?.video_download_url).toBe(
      "https://storage/new.mp4?download=",
    );
    expect(refreshed[0]?.captions_vtt_url).toBe("https://storage/new.vtt");
    expect(refreshed[0]?.captions_vtt_download_url).toBe(
      "https://storage/new.vtt?download=",
    );
    expect(clips[0]?.video_url).toBe("https://storage/old.mp4?token=expired");
  });

  it("conserve les URL existantes si Storage ne renvoie pas de lien frais", async () => {
    const { client } = storageClient({
      playback: {
        data: [{ path: "u1/clip-a.mp4", signedUrl: null }],
        error: null,
      },
      download: {
        data: null,
        error: { message: "download URL generation failed" },
      },
    });
    const clips = [
      {
        video_url: "https://storage/old.mp4?token=expired",
        video_download_url: null,
        video_storage_path: "u1/clip-a.mp4",
      },
    ];

    const refreshed = await refreshClipUrls(client, clips);

    expect(refreshed[0]?.video_url).toBe(
      "https://storage/old.mp4?token=expired",
    );
    expect(refreshed[0]?.video_download_url).toBeNull();
  });

  it("ne contacte pas Storage quand aucune ligne n'a de chemin", async () => {
    const { client, from } = storageClient({
      playback: { data: [], error: null },
    });
    const clips = [{ video_url: "https://external/video.mp4" }];

    const refreshed = await refreshClipUrls(client, clips);

    expect(refreshed).toBe(clips);
    expect(from).not.toHaveBeenCalled();
  });
});
