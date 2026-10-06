import { afterEach, describe, expect, it, vi } from "vitest";

import {
  readShortsSourceDuration,
  SHORTS_SOURCE_METADATA_TIMEOUT_MS,
} from "./source-media-duration";

function createMediaElement(duration: number) {
  const eventTarget = new EventTarget();
  Object.defineProperty(eventTarget, "duration", {
    configurable: true,
    value: duration,
  });
  Object.assign(eventTarget, {
    preload: "",
    src: "",
    load: vi.fn(),
    removeAttribute: vi.fn(),
  });
  return eventTarget as unknown as HTMLMediaElement;
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("readShortsSourceDuration", () => {
  it("reads rounded metadata using the right media element and releases its URL", async () => {
    const media = createMediaElement(1_200.4);
    const createElement = vi.fn(() => media);
    vi.stubGlobal("document", { createElement });
    const createObjectURL = vi
      .spyOn(URL, "createObjectURL")
      .mockReturnValue("blob:shorts-source");
    const revokeObjectURL = vi
      .spyOn(URL, "revokeObjectURL")
      .mockImplementation(() => {});

    const duration = readShortsSourceDuration({} as File, "video/mp4");
    media.dispatchEvent(new Event("loadedmetadata"));

    await expect(duration).resolves.toBe(1_200);
    expect(createElement).toHaveBeenCalledWith("video");
    expect(createObjectURL).toHaveBeenCalledOnce();
    expect(media.removeAttribute).toHaveBeenCalledWith("src");
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:shorts-source");
  });

  it("falls back when media metadata is invalid or the browser reports an error", async () => {
    const media = createMediaElement(Number.POSITIVE_INFINITY);
    vi.stubGlobal("document", { createElement: () => media });
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:shorts-source");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});

    const duration = readShortsSourceDuration({} as File, "audio/mp4");
    media.dispatchEvent(new Event("loadedmetadata"));
    await expect(duration).resolves.toBeNull();

    const erroredMedia = createMediaElement(0);
    vi.stubGlobal("document", { createElement: () => erroredMedia });
    const failedDuration = readShortsSourceDuration({} as File, "audio/mp4");
    erroredMedia.dispatchEvent(new Event("error"));
    await expect(failedDuration).resolves.toBeNull();
  });

  it("times out instead of preventing upload when metadata is unavailable", async () => {
    vi.useFakeTimers();
    const media = createMediaElement(1_200);
    vi.stubGlobal("document", { createElement: () => media });
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:shorts-source");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});

    const duration = readShortsSourceDuration({} as File, "audio/mp4");
    await vi.advanceTimersByTimeAsync(SHORTS_SOURCE_METADATA_TIMEOUT_MS);

    await expect(duration).resolves.toBeNull();
    expect(media.removeAttribute).toHaveBeenCalledWith("src");
  });
});
