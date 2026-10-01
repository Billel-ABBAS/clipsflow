import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next-intl", () => ({
  useLocale: () => "en",
  useTranslations: () => (key: string) => key,
}));

vi.mock("@/i18n/navigation", () => ({
  Link: ({
    href,
    children,
    ...props
  }: {
    href: string;
    children: React.ReactNode;
    [key: string]: unknown;
  }) => React.createElement("a", { href, ...props }, children),
}));

vi.mock("./GalleryToolbar", () => ({
  applyToolbar: (clips: unknown[]) => clips,
  DEFAULT_TOOLBAR: {},
  GalleryToolbar: () => null,
}));

vi.mock("./ReclipMenu", () => ({ ReclipMenu: () => null }));
vi.mock("./RetryClipButton", () => ({ RetryClipButton: () => null }));
vi.mock("./ShareButton", () => ({ ShareButton: () => null }));

import {
  ClipsGallery,
  seekGalleryPreviewFrame,
  type GalleryClipRow,
} from "./ClipsGallery";

const completedClip: GalleryClipRow = {
  id: "clip-test-1",
  episode_id: "episode-test-1",
  status: "completed",
  style_key: "viral",
  aspect_ratio: "9:16",
  language: "en",
  start_seconds: 0,
  end_seconds: 12,
  customizations: null,
  overlays: null,
  video_url: "https://storage.example.test/signed/canary.mp4",
  thumbnail_url: null,
  captions_vtt_url: "https://storage.example.test/signed/canary.vtt",
  error_message: null,
  created_at: "2026-10-01T17:00:00.000Z",
  completed_at: "2026-10-01T17:00:51.000Z",
  duration_seconds: 12,
  score: null,
  episode_title: "Synthetic staging verification",
};

describe("ClipsGallery completed render", () => {
  it("renders the video preview and MP4/VTT actions from a completed gallery row", () => {
    const html = renderToStaticMarkup(<ClipsGallery clips={[completedClip]} />);

    expect(html).toContain("<video");
    expect(html).toContain(completedClip.video_url);
    expect(html).toContain(completedClip.captions_vtt_url);
    expect(html).toContain("gallery_download_vtt");
    expect(html).toContain(completedClip.episode_title);
    expect(html).toContain("aspect-[9/16]");
    expect(html).toContain("object-contain");
  });
});

describe("gallery video preview frame", () => {
  it("seeks when metadata was ready before React attached its event handler", () => {
    const video = {
      readyState: 1,
      duration: 12,
      currentTime: 0,
    } as HTMLVideoElement;

    seekGalleryPreviewFrame(video);

    expect(video.currentTime).toBeCloseTo(1.2);
  });

  it("waits for media metadata before seeking", () => {
    const video = {
      readyState: 0,
      duration: 12,
      currentTime: 0,
    } as HTMLVideoElement;

    seekGalleryPreviewFrame(video);

    expect(video.currentTime).toBe(0);
  });
});
