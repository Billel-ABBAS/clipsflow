export const SHORTS_SOURCE_METADATA_TIMEOUT_MS = 5_000;

/**
 * Read duration from browser media metadata without reading the source into
 * memory. The caller can keep its manual-duration fallback when a codec is
 * unsupported or metadata is unavailable.
 */
export function readShortsSourceDuration(
  file: File,
  mime: string,
): Promise<number | null> {
  if (typeof document === "undefined") return Promise.resolve(null);

  let media: HTMLMediaElement;
  let objectUrl: string;
  try {
    media = document.createElement(
      mime.startsWith("video/") ? "video" : "audio",
    );
    objectUrl = URL.createObjectURL(file);
  } catch {
    return Promise.resolve(null);
  }

  return new Promise((resolve) => {
    let settled = false;
    const timeout = globalThis.setTimeout(
      () => finish(null),
      SHORTS_SOURCE_METADATA_TIMEOUT_MS,
    );

    const cleanup = () => {
      globalThis.clearTimeout(timeout);
      media.removeEventListener("loadedmetadata", onLoadedMetadata);
      media.removeEventListener("error", onError);
      media.removeAttribute("src");
      try {
        media.load();
      } catch {
        // Metadata probing is best-effort; cleanup must not block the upload.
      }
      try {
        URL.revokeObjectURL(objectUrl);
      } catch {
        // Some constrained browsers do not implement object URL cleanup.
      }
    };

    const finish = (duration: number | null) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(
        duration !== null && Number.isFinite(duration) && duration > 0
          ? Math.round(duration)
          : null,
      );
    };

    const onLoadedMetadata = () => finish(media.duration);
    const onError = () => finish(null);

    media.preload = "metadata";
    media.addEventListener("loadedmetadata", onLoadedMetadata, { once: true });
    media.addEventListener("error", onError, { once: true });
    try {
      media.src = objectUrl;
      media.load();
    } catch {
      finish(null);
    }
  });
}
