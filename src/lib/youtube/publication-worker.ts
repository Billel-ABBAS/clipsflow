import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdtemp, open, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable, Transform } from "node:stream";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import {
  defaultClipsAllowedHosts,
  localSupabaseHttpOrigin,
  validateOutboundUrl,
} from "@/lib/security/validate-outbound-url";
import { safeFetch } from "@/lib/utils/safe-fetch";

import {
  checkYouTubeUploadSession,
  createYouTubeUploadSession,
  refreshYouTubeAccessToken,
  uploadYouTubeChunk,
  YouTubeProviderError,
} from "./google-api";
import {
  buildYouTubePublishRequestPayload,
  getYouTubeOAuthConfig,
  type YouTubePublishPrivacyStatus,
} from "./oauth";
import {
  decryptYouTubeRefreshToken,
  decryptYouTubeUploadSessionUri,
  encryptYouTubeUploadSessionUri,
  getYouTubeTokenVaultKeyFromEnvironment,
} from "./token-vault";

export const YOUTUBE_PUBLICATION_MAX_BYTES = 512 * 1024 * 1024;
export const YOUTUBE_UPLOAD_CHUNK_BYTES = 8 * 1024 * 1024;
const YOUTUBE_WORKER_LEASE_SECONDS = 300;
const YOUTUBE_DOWNLOAD_TIMEOUT_MS = 5 * 60 * 1_000;

type AdminClient = SupabaseClient;
type ClaimedPublication = Readonly<{
  publication_id: string;
  lease_token: string;
}>;

type PublicationRow = Readonly<{
  id: string;
  user_id: string;
  clip_id: string;
  youtube_connection_id: string;
  title: string;
  description: string;
  tags: string[];
  visibility: YouTubePublishPrivacyStatus;
  made_for_kids: boolean;
  contains_synthetic_media: boolean;
  notify_subscribers: boolean;
  attempt_count: number;
  upload_session_uri_ciphertext: string | null;
}>;

type ConnectionRow = Readonly<{
  id: string;
  user_id: string;
  refresh_token_ciphertext: string | null;
  is_active: boolean;
}>;

type ClipRow = Readonly<{
  id: string;
  user_id: string;
  status: string;
  video_storage_path: string | null;
}>;

export type YouTubePublicationWorkerResult =
  | { kind: "idle" }
  | { kind: "published"; publicationId: string; videoId: string }
  | { kind: "queued_retry"; publicationId: string; errorCode: string }
  | { kind: "failed"; publicationId: string; errorCode: string }
  | { kind: "stale"; publicationId: string }
  | { kind: "unavailable" };

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function parseClaim(value: unknown): ClaimedPublication | null {
  if (!Array.isArray(value) || value.length !== 1) return null;
  const row = asRecord(value[0]);
  if (
    !row ||
    !z.uuid().safeParse(row.publication_id).success ||
    !z.uuid().safeParse(row.lease_token).success
  ) {
    return null;
  }
  return {
    publication_id: row.publication_id as string,
    lease_token: row.lease_token as string,
  };
}

function parsePublication(value: unknown): PublicationRow | null {
  const row = asRecord(value);
  if (
    !row ||
    !z.uuid().safeParse(row.id).success ||
    !z.uuid().safeParse(row.user_id).success ||
    !z.uuid().safeParse(row.clip_id).success ||
    !z.uuid().safeParse(row.youtube_connection_id).success ||
    typeof row.title !== "string" ||
    typeof row.description !== "string" ||
    !Array.isArray(row.tags) ||
    !row.tags.every((tag) => typeof tag === "string") ||
    (row.visibility !== "private" &&
      row.visibility !== "unlisted" &&
      row.visibility !== "public") ||
    typeof row.made_for_kids !== "boolean" ||
    typeof row.contains_synthetic_media !== "boolean" ||
    typeof row.notify_subscribers !== "boolean" ||
    !Number.isSafeInteger(row.attempt_count) ||
    (row.upload_session_uri_ciphertext !== null &&
      typeof row.upload_session_uri_ciphertext !== "string")
  ) {
    return null;
  }
  return row as unknown as PublicationRow;
}

function parseConnection(value: unknown): ConnectionRow | null {
  const row = asRecord(value);
  if (
    !row ||
    !z.uuid().safeParse(row.id).success ||
    !z.uuid().safeParse(row.user_id).success ||
    typeof row.is_active !== "boolean" ||
    (row.refresh_token_ciphertext !== null &&
      typeof row.refresh_token_ciphertext !== "string")
  ) {
    return null;
  }
  return row as unknown as ConnectionRow;
}

function parseClip(value: unknown): ClipRow | null {
  const row = asRecord(value);
  if (
    !row ||
    !z.uuid().safeParse(row.id).success ||
    !z.uuid().safeParse(row.user_id).success ||
    typeof row.status !== "string" ||
    (row.video_storage_path !== null &&
      typeof row.video_storage_path !== "string")
  ) {
    return null;
  }
  return row as unknown as ClipRow;
}

function providerFailure(error: unknown): {
  errorCode: string;
  retryable: boolean;
} {
  if (error instanceof YouTubeProviderError) {
    return {
      errorCode: error.code.replace(/^youtube_provider:/u, ""),
      retryable: error.retryable,
    };
  }
  if (error instanceof Error && /^[a-z0-9_]{1,80}$/u.test(error.message)) {
    return {
      errorCode: error.message,
      retryable: new Set([
        "youtube_storage_failed",
        "youtube_source_read_failed",
        "youtube_worker_failed",
      ]).has(error.message),
    };
  }
  return { errorCode: "youtube_worker_failed", retryable: true };
}

function safeStoragePath(path: string, userId: string): boolean {
  if (!path.startsWith(`${userId}/`) || !path.toLowerCase().endsWith(".mp4")) {
    return false;
  }
  const parts = path.split("/");
  return (
    parts.length >= 2 &&
    parts.every((part) => part && part !== "." && part !== "..")
  );
}

async function downloadClipToFile(
  admin: AdminClient,
  clip: ClipRow,
  userId: string,
  outputPath: string,
): Promise<number> {
  if (
    clip.status !== "completed" ||
    typeof clip.video_storage_path !== "string" ||
    !safeStoragePath(clip.video_storage_path, userId)
  ) {
    throw new Error("youtube_clip_unavailable");
  }
  const segments = clip.video_storage_path.split("/");
  const fileName = segments.pop();
  const directory = segments.join("/");
  if (!fileName || !directory) throw new Error("youtube_clip_unavailable");
  const storage = admin.storage.from("clip-outputs");
  const { data: objects, error: listError } = await storage.list(directory, {
    limit: 1000,
    search: fileName,
  });
  if (listError) throw new Error("youtube_storage_failed");
  const object = objects?.find((item) => item.name === fileName);
  const size = Number(object?.metadata?.size);
  if (
    !Number.isSafeInteger(size) ||
    size < 1 ||
    size > YOUTUBE_PUBLICATION_MAX_BYTES
  ) {
    throw new Error("youtube_clip_size_invalid");
  }
  const { data: signed, error: signError } = await storage.createSignedUrl(
    clip.video_storage_path,
    3_600,
  );
  if (signError || !signed?.signedUrl)
    throw new Error("youtube_storage_failed");
  const allowHttpOrigin = localSupabaseHttpOrigin();
  const allowedHosts = allowHttpOrigin ? undefined : defaultClipsAllowedHosts();
  try {
    validateOutboundUrl(signed.signedUrl, {
      allowedHosts,
      allowHttpOrigin,
    });
  } catch {
    throw new Error("youtube_storage_failed");
  }

  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    YOUTUBE_DOWNLOAD_TIMEOUT_MS,
  );
  timeout.unref?.();
  try {
    const response = await safeFetch(signed.signedUrl, {
      timeoutMs: 60_000,
      signal: controller.signal,
      allowedHosts,
      allowHttpOrigin,
    });
    if (!response.ok || !response.body)
      throw new Error("youtube_storage_failed");
    const remoteLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(remoteLength) && remoteLength !== size) {
      await response.body.cancel().catch(() => undefined);
      throw new Error("youtube_storage_failed");
    }
    let downloadedBytes = 0;
    const sizeGuard = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        downloadedBytes += chunk.byteLength;
        if (downloadedBytes > size) {
          callback(new Error("youtube_storage_failed"));
          return;
        }
        callback(null, chunk);
      },
    });
    await pipeline(
      Readable.fromWeb(
        response.body as import("node:stream/web").ReadableStream,
      ),
      sizeGuard,
      createWriteStream(outputPath, { flags: "wx" }),
      { signal: controller.signal },
    );
    const fileInfo = await stat(outputPath);
    if (downloadedBytes !== size || fileInfo.size !== size) {
      throw new Error("youtube_storage_failed");
    }
    return size;
  } catch {
    throw new Error("youtube_storage_failed");
  } finally {
    clearTimeout(timeout);
  }
}

async function assertLease(
  admin: AdminClient,
  publicationId: string,
  leaseToken: string,
): Promise<void> {
  const { data, error } = await admin.rpc(
    "shorts_renew_youtube_publication_lease",
    {
      p_publication_id: publicationId,
      p_lease_token: leaseToken,
      p_lease_seconds: YOUTUBE_WORKER_LEASE_SECONDS,
    },
  );
  if (error || data !== true) throw new Error("youtube_lease_lost");
}

async function saveUploadProgress(
  admin: AdminClient,
  publicationId: string,
  leaseToken: string,
  encryptedSessionUri: string,
  offset: number,
): Promise<void> {
  const { data, error } = await admin.rpc(
    "shorts_save_youtube_upload_progress",
    {
      p_publication_id: publicationId,
      p_lease_token: leaseToken,
      p_session_uri_ciphertext: encryptedSessionUri,
      p_upload_offset_bytes: offset,
    },
  );
  if (error || data !== true) throw new Error("youtube_lease_lost");
}

/** Process at most one confirmed publication. No work is claimed before the creator's final confirmation. */
export async function processOneYouTubePublicationJob(
  admin: AdminClient,
): Promise<YouTubePublicationWorkerResult> {
  if (
    process.env.YOUTUBE_PUBLISH_WORKER_ENABLED !== "true" &&
    process.env.YOUTUBE_PUBLISH_WORKER_ENABLED !== "1"
  ) {
    return { kind: "unavailable" };
  }
  let oauthConfig: ReturnType<typeof getYouTubeOAuthConfig>;
  let vaultKey: Buffer;
  try {
    oauthConfig = getYouTubeOAuthConfig(process.env, {
      allowHttpLocalhost: process.env.NODE_ENV !== "production",
    });
    vaultKey = getYouTubeTokenVaultKeyFromEnvironment();
  } catch {
    return { kind: "unavailable" };
  }
  const { data: claimData, error: claimError } = await admin.rpc(
    "shorts_claim_youtube_publication",
    { p_lease_seconds: YOUTUBE_WORKER_LEASE_SECONDS },
  );
  if (claimError) return { kind: "unavailable" };
  if (Array.isArray(claimData) && claimData.length === 0)
    return { kind: "idle" };
  const claim = parseClaim(claimData);
  if (!claim) return { kind: "unavailable" };

  const publicationId = claim.publication_id;
  const leaseToken = claim.lease_token;
  let currentAttempt = 1;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let heartbeatError = false;
  try {
    const publicationResult = await admin
      .from("shorts_publications")
      .select(
        "id, user_id, clip_id, youtube_connection_id, title, description, tags, visibility, made_for_kids, contains_synthetic_media, notify_subscribers, attempt_count, upload_session_uri_ciphertext",
      )
      .eq("id", publicationId)
      .eq("status", "uploading")
      .eq("worker_lease_token", leaseToken)
      .maybeSingle();
    if (publicationResult.error) throw new Error("youtube_storage_failed");
    const publication = parsePublication(publicationResult.data);
    if (!publication) throw new Error("youtube_publication_invalid");
    if (
      publication.visibility !== "private" &&
      process.env.YOUTUBE_PUBLIC_UPLOADS_ENABLED !== "true"
    ) {
      throw new Error("youtube_public_uploads_disabled");
    }
    currentAttempt = publication.attempt_count;
    heartbeat = setInterval(() => {
      void assertLease(admin, publicationId, leaseToken).catch(() => {
        heartbeatError = true;
      });
    }, 30_000);
    heartbeat.unref?.();

    const { data: connectionData, error: connectionError } = await admin
      .from("youtube_connections")
      .select("id, user_id, refresh_token_ciphertext, is_active")
      .eq("id", publication.youtube_connection_id)
      .eq("user_id", publication.user_id)
      .eq("is_active", true)
      .is("disconnected_at", null)
      .maybeSingle();
    const connection = parseConnection(connectionData);
    if (
      connectionError ||
      !connection ||
      !connection.is_active ||
      typeof connection.refresh_token_ciphertext !== "string"
    ) {
      throw new Error("youtube_connection_unavailable");
    }
    const context = {
      userId: publication.user_id,
      connectionId: connection.id,
    };
    const refreshToken = decryptYouTubeRefreshToken({
      ciphertext: connection.refresh_token_ciphertext,
      context,
      key: vaultKey,
    });
    const { accessToken } = await refreshYouTubeAccessToken({
      clientId: oauthConfig.clientId,
      clientSecret: oauthConfig.clientSecret,
      refreshToken,
    });
    await admin
      .from("youtube_connections")
      .update({
        last_used_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("id", connection.id)
      .eq("user_id", publication.user_id)
      .eq("is_active", true);
    const { data: clipData, error: clipError } = await admin
      .from("clips")
      .select("id, user_id, status, video_storage_path")
      .eq("id", publication.clip_id)
      .eq("user_id", publication.user_id)
      .maybeSingle();
    const clip = parseClip(clipData);
    if (clipError || !clip) throw new Error("youtube_clip_unavailable");

    const workDir = await mkdtemp(join(tmpdir(), "clipsflow-youtube-upload-"));
    const localVideoPath = join(workDir, `${randomUUID()}.mp4`);
    try {
      const contentLength = await downloadClipToFile(
        admin,
        clip,
        publication.user_id,
        localVideoPath,
      );
      await assertLease(admin, publicationId, leaseToken);
      const file = await open(localVideoPath, "r");
      try {
        let sessionUri: string | null = null;
        let encryptedSessionUri = publication.upload_session_uri_ciphertext;
        let progress:
          | { kind: "incomplete"; nextOffset: number }
          | { kind: "complete"; videoId: string }
          | null = null;
        if (encryptedSessionUri) {
          sessionUri = decryptYouTubeUploadSessionUri({
            ciphertext: encryptedSessionUri,
            context,
            key: vaultKey,
          });
          const checked = await checkYouTubeUploadSession({
            accessToken,
            sessionUri,
            contentLength,
          });
          if (checked.kind === "expired") {
            sessionUri = null;
            encryptedSessionUri = null;
          } else if (
            checked.kind === "incomplete" ||
            checked.kind === "complete"
          ) {
            progress = checked;
          } else {
            throw new Error("youtube_upload_status_invalid");
          }
        }

        if (!sessionUri) {
          const payload = buildYouTubePublishRequestPayload({
            title: publication.title,
            description: publication.description,
            tags: publication.tags,
            privacyStatus: publication.visibility,
            confirmPublic: publication.visibility === "public",
            madeForKids: publication.made_for_kids,
            notifySubscribers: publication.notify_subscribers,
          });
          const body = {
            ...payload.body,
            status: {
              ...payload.body.status,
              containsSyntheticMedia: publication.contains_synthetic_media,
            },
          };
          sessionUri = await createYouTubeUploadSession({
            accessToken,
            notifySubscribers: payload.notifySubscribers,
            payload: body,
            contentLength,
          });
          encryptedSessionUri = encryptYouTubeUploadSessionUri({
            uploadSessionUri: sessionUri,
            context,
            key: vaultKey,
          });
          await saveUploadProgress(
            admin,
            publicationId,
            leaseToken,
            encryptedSessionUri,
            0,
          );
        }

        if (progress?.kind === "complete") {
          const { data: completed, error: completeError } = await admin.rpc(
            "shorts_complete_youtube_publication",
            {
              p_publication_id: publicationId,
              p_lease_token: leaseToken,
              p_youtube_video_id: progress.videoId,
            },
          );
          if (completeError || completed !== true) {
            return { kind: "stale", publicationId };
          }
          return {
            kind: "published",
            publicationId,
            videoId: progress.videoId,
          };
        }

        let offset = progress?.kind === "incomplete" ? progress.nextOffset : 0;
        let noProgressCount = 0;
        let videoId: string | null = null;
        while (offset < contentLength) {
          if (heartbeatError) throw new Error("youtube_lease_lost");
          await assertLease(admin, publicationId, leaseToken);
          const size = Math.min(
            YOUTUBE_UPLOAD_CHUNK_BYTES,
            contentLength - offset,
          );
          const chunk = Buffer.allocUnsafe(size);
          const { bytesRead } = await file.read(chunk, 0, size, offset);
          if (bytesRead !== size) throw new Error("youtube_source_read_failed");
          const uploaded = await uploadYouTubeChunk({
            accessToken,
            sessionUri: sessionUri!,
            contentLength,
            startOffset: offset,
            bytes: chunk,
          });
          if (uploaded.kind === "complete") {
            videoId = uploaded.videoId;
            break;
          }
          if (uploaded.kind !== "incomplete" || uploaded.nextOffset <= offset) {
            noProgressCount += 1;
            if (noProgressCount > 1) {
              throw new YouTubeProviderError("upload_chunk_failed", true);
            }
          } else {
            noProgressCount = 0;
          }
          offset = uploaded.nextOffset;
          await saveUploadProgress(
            admin,
            publicationId,
            leaseToken,
            encryptedSessionUri!,
            offset,
          );
        }
        if (!videoId && offset >= contentLength) {
          const finalStatus = await checkYouTubeUploadSession({
            accessToken,
            sessionUri: sessionUri!,
            contentLength,
          });
          if (finalStatus.kind === "complete") {
            videoId = finalStatus.videoId;
          } else {
            throw new YouTubeProviderError("upload_chunk_failed", true);
          }
        }
        if (!videoId) throw new YouTubeProviderError("upload_response_invalid");
        const { data: completed, error: completeError } = await admin.rpc(
          "shorts_complete_youtube_publication",
          {
            p_publication_id: publicationId,
            p_lease_token: leaseToken,
            p_youtube_video_id: videoId,
          },
        );
        if (completeError || completed !== true) {
          return { kind: "stale", publicationId };
        }
        return { kind: "published", publicationId, videoId };
      } finally {
        await file.close().catch(() => undefined);
      }
    } finally {
      await rm(workDir, { recursive: true, force: true }).catch(
        () => undefined,
      );
      if (heartbeat) clearInterval(heartbeat);
    }
  } catch (error) {
    if (heartbeat) clearInterval(heartbeat);
    if (error instanceof Error && error.message === "youtube_lease_lost") {
      return { kind: "stale", publicationId };
    }
    const failure = providerFailure(error);
    const retryable = failure.retryable;
    const retryDelaySeconds = Math.min(
      900,
      30 * 2 ** Math.max(0, currentAttempt - 1),
    );
    const { data: failed, error: failError } = await admin.rpc(
      "shorts_fail_youtube_publication",
      {
        p_publication_id: publicationId,
        p_lease_token: leaseToken,
        p_error_code:
          error instanceof Error && /^[a-z0-9_]{1,80}$/u.test(error.message)
            ? error.message
            : failure.errorCode,
        p_retryable: retryable,
        p_retry_delay_seconds: retryDelaySeconds,
      },
    );
    if (failError || failed !== true) return { kind: "stale", publicationId };
    return retryable
      ? { kind: "queued_retry", publicationId, errorCode: failure.errorCode }
      : { kind: "failed", publicationId, errorCode: failure.errorCode };
  }
}
