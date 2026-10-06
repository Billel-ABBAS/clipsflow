import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { z } from "zod";

import { isClipsEnabled } from "@/lib/clips/feature-flag";
import { checkDistributedRateLimit } from "@/lib/rate-limit-distributed";
import {
  defaultClipsAllowedHosts,
  localSupabaseHttpOrigin,
  validateOutboundUrl,
} from "@/lib/security/validate-outbound-url";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { safeFetch } from "@/lib/utils/safe-fetch";
import { routing } from "@/i18n/routing";
import {
  streamStoredZipEntries,
  zipStoredArchiveContentLength,
  type ZipStreamEntry,
} from "@/lib/clips/zip-stream";

export const runtime = "nodejs";
export const maxDuration = 300;

const BUCKET = "clip-outputs";
const MAX_BULK_DOWNLOAD_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_SINGLE_DOWNLOAD_BYTES = 512 * 1024 * 1024;

function respond(error: string, status: number): Response {
  return NextResponse.json({ error }, { status });
}

function asUint8Stream(
  entries: readonly ZipStreamEntry[],
): ReadableStream<Uint8Array> {
  const iterator = streamStoredZipEntries(entries);
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await iterator.next();
        if (next.done) controller.close();
        else controller.enqueue(next.value);
      } catch {
        controller.error(new Error("bulk_download_failed"));
      }
    },
    async cancel() {
      await iterator.return(undefined);
    },
  });
}

/** Stream an owner-checked ZIP of completed clips, without buffering the archive. */
export async function GET(request: Request): Promise<Response> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return respond("unauthorized", 401);

  const cookieStore = await cookies();
  const locale = cookieStore.get("NEXT_LOCALE")?.value ?? routing.defaultLocale;
  if (!isClipsEnabled({ locale, userId: user.id })) {
    return respond("not_yet_available", 403);
  }

  const rawIds = new URL(request.url).searchParams.get("clip_ids");
  const parsedIds = z
    .array(z.uuid())
    .min(2)
    .max(12)
    .safeParse(rawIds?.split(",").filter(Boolean) ?? []);
  if (
    !parsedIds.success ||
    new Set(parsedIds.data).size !== parsedIds.data.length
  ) {
    return respond("validation_error", 400);
  }

  let admin;
  try {
    admin = createAdminClient();
  } catch {
    return respond("download_unavailable", 503);
  }
  let rateLimit;
  try {
    rateLimit = await checkDistributedRateLimit(
      admin,
      `clips-bulk-download:${user.id}`,
      5,
      60,
    );
  } catch {
    return respond("rate_limit_unavailable", 503);
  }
  if (!rateLimit.allowed) {
    return NextResponse.json(
      { error: "rate_limited" },
      {
        status: 429,
        headers: { "Retry-After": String(rateLimit.retryAfterSeconds) },
      },
    );
  }

  const { data: clips, error: clipsError } = await admin
    .from("clips")
    .select("id, user_id, status, video_storage_path")
    .eq("user_id", user.id)
    .eq("status", "completed")
    .in("id", parsedIds.data);
  if (clipsError) return respond("download_unavailable", 503);
  if (!clips || clips.length !== parsedIds.data.length) {
    return respond("clips_not_found_or_not_ready", 404);
  }

  const clipById = new Map(clips.map((clip) => [clip.id, clip]));
  const orderedClips = parsedIds.data.map((id) => clipById.get(id));
  const storage = admin.storage.from(BUCKET);
  const allowHttpOrigin = localSupabaseHttpOrigin();
  const allowedHosts = allowHttpOrigin ? undefined : defaultClipsAllowedHosts();
  const entries: ZipStreamEntry[] = [];
  let totalBytes = 0;

  for (const [index, clip] of orderedClips.entries()) {
    if (
      !clip ||
      clip.user_id !== user.id ||
      typeof clip.video_storage_path !== "string" ||
      !clip.video_storage_path.startsWith(`${user.id}/`) ||
      !clip.video_storage_path.toLowerCase().endsWith(".mp4")
    ) {
      return respond("clips_not_found_or_not_ready", 404);
    }
    const segments = clip.video_storage_path.split("/");
    if (segments.some((part) => part === "" || part === "." || part === "..")) {
      return respond("download_unavailable", 503);
    }
    const fileName = segments.pop();
    const directory = segments.join("/");
    if (!fileName || !directory) return respond("download_unavailable", 503);

    const { data: storedObjects, error: listError } = await storage.list(
      directory,
      { limit: 1000, search: fileName },
    );
    if (listError) return respond("download_unavailable", 503);
    const object = storedObjects?.find((entry) => entry.name === fileName);
    const objectSize = Number(object?.metadata?.size);
    if (!Number.isSafeInteger(objectSize) || objectSize <= 0) {
      return respond("clip_file_unavailable", 409);
    }
    if (objectSize > MAX_SINGLE_DOWNLOAD_BYTES) {
      return respond("clip_file_too_large_for_bulk_download", 413);
    }
    totalBytes += objectSize;
    if (totalBytes > MAX_BULK_DOWNLOAD_BYTES) {
      return respond("bulk_download_too_large", 413);
    }

    const { data: signed, error: signError } = await storage.createSignedUrl(
      clip.video_storage_path,
      3_600,
    );
    if (signError || !signed?.signedUrl) {
      return respond("clip_file_unavailable", 409);
    }
    try {
      validateOutboundUrl(signed.signedUrl, {
        allowedHosts,
        allowHttpOrigin,
      });
    } catch {
      return respond("clip_file_unavailable", 409);
    }

    entries.push({
      name: `short-${String(index + 1).padStart(2, "0")}.mp4`,
      sizeBytes: objectSize,
      readTimeoutMs: 60_000,
      open: async () => {
        const response = await safeFetch(signed.signedUrl, {
          timeoutMs: 60_000,
          allowedHosts,
          allowHttpOrigin,
        });
        if (!response.ok || !response.body) {
          throw new Error("clip_file_download_failed");
        }
        return response.body as ReadableStream<Uint8Array>;
      },
    });
  }

  let archiveLength: number;
  try {
    archiveLength = zipStoredArchiveContentLength(entries);
  } catch {
    return respond("download_unavailable", 503);
  }
  const archive = asUint8Stream(entries);
  return new Response(archive, {
    status: 200,
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": 'attachment; filename="clipsflow-shorts.zip"',
      "Content-Length": String(archiveLength),
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
