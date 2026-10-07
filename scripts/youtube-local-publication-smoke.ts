import { createHash, randomBytes, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";

import { createServerClient } from "@supabase/ssr";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import ffmpegPath from "@ffmpeg-installer/ffmpeg";

import { processOneYouTubePublicationJob } from "../src/lib/youtube/publication-worker";
import { encryptYouTubeRefreshToken } from "../src/lib/youtube/token-vault";

const baseUrl = process.env.CLIPSFLOW_LOCAL_SHORTS_BASE_URL;
const supabaseUrl = process.env.CLIPSFLOW_LOCAL_SUPABASE_URL;
const anonKey = process.env.CLIPSFLOW_LOCAL_SUPABASE_ANON_KEY;
const serviceRoleKey = process.env.CLIPSFLOW_LOCAL_SUPABASE_SERVICE_ROLE_KEY;
const refreshToken = "clipsflow-local-youtube-refresh-token";
const fakeAccessToken = "clipsflow-local-youtube-access-token";
const fakeVideoId = "clipsflowMockVideo123";
const nativeFetch = globalThis.fetch.bind(globalThis);

type LocalConfiguration = Readonly<{
  appUrl: string;
  supabaseUrl: string;
  anonKey: string;
  serviceRoleKey: string;
}>;

type GoogleMockState = {
  sessionUri: string | null;
  expectedLength: number | null;
  uploadPayload: Record<string, unknown> | null;
  uploadedBytes: number;
};

function requireLocalConfiguration(): LocalConfiguration {
  if (!baseUrl || !supabaseUrl || !anonKey || !serviceRoleKey) {
    throw new Error("Local app URL and local Supabase keys are required");
  }

  const app = new URL(baseUrl);
  const supabase = new URL(supabaseUrl);
  if (
    !["localhost", "127.0.0.1", "::1"].includes(app.hostname) ||
    !["localhost", "127.0.0.1", "::1"].includes(supabase.hostname) ||
    supabase.protocol !== "http:" ||
    supabase.username ||
    supabase.password ||
    !["54321", "55321"].includes(supabase.port) ||
    supabase.pathname !== "/" ||
    supabase.search ||
    supabase.hash
  ) {
    throw new Error("This smoke test refuses to write outside local services");
  }

  // Next's local dev server can canonicalize loopback requests to `localhost`.
  // Use that same host for both Origin and request URL so the CSRF check tests
  // the publication flow, not an IPv4-vs-hostname alias mismatch.
  const appOrigin = new URL(app.origin);
  if (app.hostname !== "localhost") appOrigin.hostname = "localhost";

  return {
    appUrl: appOrigin.origin,
    supabaseUrl: supabase.origin,
    anonKey,
    serviceRoleKey,
  };
}

function bodyText(body: BodyInit | null | undefined): string {
  if (typeof body === "string") return body;
  if (body instanceof URLSearchParams) return body.toString();
  if (body instanceof Uint8Array) return Buffer.from(body).toString("utf8");
  return "";
}

function installGoogleMock(localOrigins: ReadonlySet<string>): GoogleMockState {
  const state: GoogleMockState = {
    sessionUri: null,
    expectedLength: null,
    uploadPayload: null,
    uploadedBytes: 0,
  };

  globalThis.fetch = async (input, init) => {
    const url =
      input instanceof Request
        ? new URL(input.url)
        : input instanceof URL
          ? input
          : new URL(String(input));
    const method = (
      init?.method ?? (input instanceof Request ? input.method : "GET")
    ).toUpperCase();
    const headers = new Headers(
      init?.headers ?? (input instanceof Request ? input.headers : undefined),
    );

    if (
      url.href === "https://oauth2.googleapis.com/token" &&
      method === "POST"
    ) {
      const form = new URLSearchParams(bodyText(init?.body));
      if (
        form.get("grant_type") !== "refresh_token" ||
        form.get("refresh_token") !== refreshToken
      ) {
        throw new Error("Unexpected local OAuth refresh request");
      }
      return Response.json({
        access_token: fakeAccessToken,
        expires_in: 3_600,
        token_type: "Bearer",
      });
    }

    if (
      url.origin === "https://www.googleapis.com" &&
      url.pathname === "/upload/youtube/v3/videos" &&
      method === "POST" &&
      !url.searchParams.has("upload_id")
    ) {
      const contentLength = Number(headers.get("x-upload-content-length"));
      let payload: unknown;
      try {
        payload = JSON.parse(bodyText(init?.body));
      } catch {
        throw new Error("Invalid local YouTube upload-session payload");
      }
      if (
        !Number.isSafeInteger(contentLength) ||
        contentLength < 1 ||
        !payload ||
        typeof payload !== "object" ||
        Array.isArray(payload)
      ) {
        throw new Error("Invalid local YouTube upload-session request");
      }
      state.expectedLength = contentLength;
      state.uploadPayload = payload as Record<string, unknown>;
      state.sessionUri = new URL(
        `/upload/youtube/v3/videos?uploadType=resumable&upload_id=${randomUUID()}`,
        "https://www.googleapis.com",
      ).href;
      return new Response(null, {
        status: 200,
        headers: { location: state.sessionUri },
      });
    }

    if (state.sessionUri && url.href === state.sessionUri && method === "PUT") {
      const range = headers.get("content-range");
      const bytes = init?.body instanceof Uint8Array ? init.body.byteLength : 0;
      if (
        bytes !== state.expectedLength ||
        range !== `bytes 0-${bytes - 1}/${state.expectedLength}` ||
        headers.get("authorization") !== `Bearer ${fakeAccessToken}`
      ) {
        throw new Error("Invalid local YouTube upload chunk");
      }
      state.uploadedBytes = bytes;
      return Response.json({ id: fakeVideoId }, { status: 201 });
    }

    if (localOrigins.has(url.origin)) return nativeFetch(input, init);
    throw new Error("External network is blocked in the local YouTube smoke");
  };

  return state;
}

async function generateVideo(path: string): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn(
      ffmpegPath.path,
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-f",
        "lavfi",
        "-i",
        "color=c=blue:s=160x90:r=2:d=2",
        "-an",
        "-c:v",
        "mpeg4",
        "-q:v",
        "12",
        "-pix_fmt",
        "yuv420p",
        "-movflags",
        "+faststart",
        "-y",
        path,
      ],
      { stdio: "ignore" },
    );
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("Synthetic YouTube clip generation timed out"));
    }, 30_000);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolvePromise();
      else reject(new Error("Synthetic YouTube clip generation failed"));
    });
  });
}

async function readJsonResponse(response: Response): Promise<{
  status: number;
  body: Record<string, unknown>;
}> {
  const body: unknown = await response.json();
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new Error("Local YouTube API returned invalid JSON");
  }
  return { status: response.status, body: body as Record<string, unknown> };
}

async function main(): Promise<void> {
  const local = requireLocalConfiguration();
  process.env.NEXT_PUBLIC_SUPABASE_URL = local.supabaseUrl;
  process.env.YOUTUBE_OAUTH_CLIENT_ID = "local-fixture-client-id";
  process.env.YOUTUBE_OAUTH_CLIENT_SECRET = "local-fixture-client-secret";
  process.env.YOUTUBE_OAUTH_REDIRECT_URI = `${local.appUrl}/api/youtube/oauth/callback`;
  process.env.YOUTUBE_OAUTH_STATE_SECRET =
    "local-fixture-youtube-state-secret-is-long-enough";
  process.env.YOUTUBE_PUBLISH_WORKER_ENABLED = "true";
  process.env.YOUTUBE_PUBLIC_UPLOADS_ENABLED = "false";

  const admin = createClient(local.supabaseUrl, local.serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const email = `clipsflow-youtube-local-${randomUUID()}@example.invalid`;
  const password = randomBytes(32).toString("base64url");
  const connectionId = randomUUID();
  const episodeId = randomUUID();
  const clipId = randomUUID();
  const key = Buffer.alloc(32, 0x44);
  process.env.YOUTUBE_TOKEN_ENCRYPTION_KEY = key.toString("base64");

  let userId: string | null = null;
  let videoStoragePath: string | null = null;
  let tempDirectory: string | null = null;
  let publicationId: string | null = null;
  let mockState: GoogleMockState = {
    sessionUri: null,
    expectedLength: null,
    uploadPayload: null,
    uploadedBytes: 0,
  };

  try {
    const pending = await admin
      .from("shorts_publications")
      .select("id", { count: "exact", head: true })
      .in("status", ["queued", "uploading"]);
    if (pending.error || (pending.count ?? 0) !== 0) {
      throw new Error(
        "Refusing to claim a local YouTube queue that was not empty before the smoke test",
      );
    }

    const { data: created, error: createError } =
      await admin.auth.admin.createUser({
        email,
        password,
        email_confirm: true,
      });
    if (createError || !created.user) {
      throw new Error("Could not create the temporary local YouTube user");
    }
    userId = created.user.id;

    const vaultContext = { userId, connectionId };
    const refreshTokenCiphertext = encryptYouTubeRefreshToken({
      refreshToken,
      context: vaultContext,
      key,
    });
    const { error: connectionError } = await admin
      .from("youtube_connections")
      .insert({
        id: connectionId,
        user_id: userId,
        provider: "youtube",
        channel_id: "clipsflow-local-channel",
        channel_title: "ClipsFlow Local Test Channel",
        refresh_token_ciphertext: refreshTokenCiphertext,
        is_active: true,
      });
    if (connectionError) {
      throw new Error(
        "Could not create the encrypted local YouTube connection",
      );
    }

    tempDirectory = await mkdtemp(join(tmpdir(), "clipsflow-youtube-smoke-"));
    const videoPath = join(tempDirectory, "synthetic-short.mp4");
    await generateVideo(videoPath);
    const videoBytes = await readFile(videoPath);
    if (
      videoBytes.length < 1_000 ||
      videoBytes.toString("ascii", 4, 8) !== "ftyp"
    ) {
      throw new Error("Synthetic local YouTube Short is not a valid MP4");
    }

    videoStoragePath = `${userId}/${clipId}/final.mp4`;
    const { error: uploadError } = await admin.storage
      .from("clip-outputs")
      .upload(videoStoragePath, videoBytes, {
        contentType: "video/mp4",
        upsert: false,
      });
    if (uploadError) {
      throw new Error("Could not store the synthetic local YouTube Short");
    }

    const { error: episodeError } = await admin.from("episodes").insert({
      id: episodeId,
      user_id: userId,
      title: "Temporary YouTube publication fixture",
      source_type: "upload",
      source_url: null,
      source_storage_path: null,
      duration_seconds: 2,
      transcript_text: "Synthetic local publication fixture",
      transcript_segments: [],
      transcript_language: "en",
      status: "ready",
    });
    if (episodeError) {
      throw new Error("Could not create the temporary local episode");
    }

    const { error: clipError } = await admin.from("clips").insert({
      id: clipId,
      episode_id: episodeId,
      user_id: userId,
      start_seconds: 0,
      end_seconds: 2,
      hook_text: "Synthetic local publication fixture",
      score: 90,
      status: "completed",
      style_key: "minimal",
      aspect_ratio: "9:16",
      language: "en",
      customizations: {},
      overlays: [],
      video_storage_path: videoStoragePath,
      captions_vtt_storage_path: null,
    });
    if (clipError) {
      throw new Error("Could not create the temporary completed local clip");
    }

    const cookies = new Map<string, string>();
    const sessionClient = createServerClient(local.supabaseUrl, local.anonKey, {
      cookies: {
        getAll: () => Array.from(cookies, ([name, value]) => ({ name, value })),
        setAll: (values) => {
          for (const { name, value } of values) cookies.set(name, value);
        },
      },
    });
    const { error: loginError, data: login } =
      await sessionClient.auth.signInWithPassword({ email, password });
    if (loginError || !login.session || cookies.size === 0) {
      throw new Error("Could not establish the local YouTube test session");
    }
    const cookieHeader = ["NEXT_LOCALE=fr"]
      .concat(Array.from(cookies, ([name, value]) => `${name}=${value}`))
      .join("; ");

    const oauthFeedbackCases = [
      {
        query: "youtube=connected",
        expectedText: "Compte YouTube connecté.",
      },
      {
        query: "youtube_error=cancelled",
        expectedText: "Connexion YouTube annulée.",
      },
      {
        query: "youtube_error=configuration_unavailable",
        expectedText: "Impossible de connecter le compte YouTube.",
      },
    ];
    for (const testCase of oauthFeedbackCases) {
      const pageResponse = await nativeFetch(
        new URL(`/fr/clips?${testCase.query}`, local.appUrl),
        { headers: { cookie: cookieHeader } },
      );
      const pageHtml = await pageResponse.text();
      if (!pageResponse.ok || !pageHtml.includes(testCase.expectedText)) {
        throw new Error(
          `The authenticated Clips page did not show YouTube OAuth feedback for ${testCase.query}`,
        );
      }
    }

    const connectionsResponse = await nativeFetch(
      new URL("/api/youtube/connections", local.appUrl),
      { headers: { cookie: cookieHeader } },
    );
    const connections = await readJsonResponse(connectionsResponse);
    const connectionBody = connections.body.data;
    const serializedConnections = JSON.stringify(connections.body);
    if (
      connections.status !== 200 ||
      !Array.isArray(connectionBody) ||
      connectionBody.length !== 1 ||
      serializedConnections.includes("refresh_token") ||
      serializedConnections.includes(refreshToken) ||
      serializedConnections.includes(refreshTokenCiphertext)
    ) {
      throw new Error("The YouTube connection API exposed invalid fields");
    }

    const publicationPayload = {
      clip_id: clipId,
      connection_id: connectionId,
      title: "A private local test Short",
      description: "Synthetic video used only by the local publication smoke.",
      tags: ["local-test"],
      visibility: "private",
      confirm_public_intent: false,
      made_for_kids: false,
      contains_synthetic_media: false,
      notify_subscribers: false,
    };
    const localOrigins = new Set([local.appUrl, local.supabaseUrl]);
    mockState = installGoogleMock(localOrigins);

    const publicAttempt = await nativeFetch(
      new URL("/api/youtube/publications", local.appUrl),
      {
        method: "POST",
        headers: {
          cookie: cookieHeader,
          origin: local.appUrl,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          ...publicationPayload,
          visibility: "public",
          confirm_public_intent: false,
        }),
      },
    );
    const rejectedPublic = await readJsonResponse(publicAttempt);
    if (
      rejectedPublic.status !== 400 ||
      rejectedPublic.body.error !== "public_confirmation_required"
    ) {
      throw new Error(
        `An unconfirmed public YouTube upload was not rejected as expected (HTTP ${rejectedPublic.status}; error=${String(rejectedPublic.body.error ?? "missing")})`,
      );
    }

    const draftResponse = await nativeFetch(
      new URL("/api/youtube/publications", local.appUrl),
      {
        method: "POST",
        headers: {
          cookie: cookieHeader,
          origin: local.appUrl,
          "content-type": "application/json",
        },
        body: JSON.stringify(publicationPayload),
      },
    );
    const draftResult = await readJsonResponse(draftResponse);
    const draftData =
      draftResult.body.data && typeof draftResult.body.data === "object"
        ? (draftResult.body.data as Record<string, unknown>)
        : null;
    const draft =
      draftData?.publication && typeof draftData.publication === "object"
        ? (draftData.publication as Record<string, unknown>)
        : null;
    const confirmationToken = draftData?.confirmation_token;
    if (
      draftResult.status !== 201 ||
      !draft ||
      typeof draft.id !== "string" ||
      draft.visibility !== "private" ||
      typeof confirmationToken !== "string"
    ) {
      throw new Error("The private local YouTube publication draft failed");
    }
    publicationId = draft.id;

    const tokenHash = createHash("sha256")
      .update(confirmationToken, "utf8")
      .digest("hex");
    const { data: awaiting, error: awaitingError } = await admin
      .from("shorts_publications")
      .select("status, visibility, confirmation_token_hash, confirmed_at")
      .eq("id", publicationId)
      .eq("user_id", userId)
      .single();
    if (
      awaitingError ||
      awaiting?.status !== "awaiting_confirmation" ||
      awaiting.visibility !== "private" ||
      awaiting.confirmation_token_hash !== tokenHash ||
      awaiting.confirmation_token_hash === confirmationToken ||
      awaiting.confirmed_at !== null
    ) {
      throw new Error(
        "The publication was queued before explicit confirmation",
      );
    }

    const confirmUrl = new URL(
      `/api/youtube/publications/${encodeURIComponent(publicationId)}/confirm`,
      local.appUrl,
    );
    const confirmationResponse = await nativeFetch(confirmUrl, {
      method: "POST",
      headers: {
        cookie: cookieHeader,
        origin: local.appUrl,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        confirmation_token: confirmationToken,
        user_confirmed: true,
        confirm_public: false,
      }),
    });
    const confirmation = await readJsonResponse(confirmationResponse);
    const confirmationData = confirmation.body.data as
      | Record<string, unknown>
      | undefined;
    if (
      confirmation.status !== 202 ||
      confirmationData?.status !== "queued" ||
      confirmationData?.visibility !== "private"
    ) {
      throw new Error("The private YouTube publication was not confirmed");
    }

    const duplicateConfirmationResponse = await nativeFetch(confirmUrl, {
      method: "POST",
      headers: {
        cookie: cookieHeader,
        origin: local.appUrl,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        confirmation_token: confirmationToken,
        user_confirmed: true,
        confirm_public: false,
      }),
    });
    const duplicateConfirmation = await readJsonResponse(
      duplicateConfirmationResponse,
    );
    if (
      duplicateConfirmation.status !== 409 ||
      duplicateConfirmation.body.error !== "confirmation_expired_or_used"
    ) {
      throw new Error("The YouTube publication confirmation was reusable");
    }

    const published = await processOneYouTubePublicationJob(
      admin as unknown as SupabaseClient,
    );
    if (
      published.kind !== "published" ||
      published.publicationId !== publicationId ||
      published.videoId !== fakeVideoId
    ) {
      throw new Error("The mocked private YouTube worker did not complete");
    }

    const { data: completed, error: completedError } = await admin
      .from("shorts_publications")
      .select(
        "status, visibility, youtube_video_id, youtube_url, confirmed_at, confirmation_token_hash, upload_session_uri_ciphertext",
      )
      .eq("id", publicationId)
      .eq("user_id", userId)
      .single();
    const uploadStatus = mockState.uploadPayload?.status as
      | Record<string, unknown>
      | undefined;
    const storedVideoSize = Number((await stat(videoPath)).size);
    if (
      completedError ||
      completed?.status !== "published" ||
      completed.visibility !== "private" ||
      completed.youtube_video_id !== fakeVideoId ||
      completed.youtube_url !==
        `https://www.youtube.com/shorts/${fakeVideoId}` ||
      completed.confirmed_at === null ||
      completed.confirmation_token_hash !== null ||
      completed.upload_session_uri_ciphertext !== null ||
      uploadStatus?.privacyStatus !== "private" ||
      mockState.expectedLength !== mockState.uploadedBytes ||
      mockState.uploadedBytes !== storedVideoSize
    ) {
      throw new Error(
        `The completed private YouTube publication failed validation (${JSON.stringify(
          {
            queryFailed: Boolean(completedError),
            status: completed?.status ?? null,
            visibility: completed?.visibility ?? null,
            videoIdMatches: completed?.youtube_video_id === fakeVideoId,
            publicUrlMatches:
              completed?.youtube_url ===
              `https://www.youtube.com/shorts/${fakeVideoId}`,
            confirmed: completed?.confirmed_at !== null,
            confirmationTokenCleared:
              completed?.confirmation_token_hash === null,
            uploadSessionCleared:
              completed?.upload_session_uri_ciphertext === null,
            providerPrivacyPrivate: uploadStatus?.privacyStatus === "private",
            expectedLength: mockState.expectedLength,
            uploadedBytes: mockState.uploadedBytes,
            storedVideoSize,
          },
        )})`,
      );
    }

    console.log(
      "Local YouTube publication smoke passed: connection metadata remained redacted, unconfirmed public visibility was rejected, a private publication required a one-time user confirmation, and the resumable worker completed against a blocked-by-default Google API mock. No real YouTube upload occurred.",
    );
  } finally {
    globalThis.fetch = nativeFetch;
    const cleanupErrors: string[] = [];
    if (videoStoragePath) {
      const { error } = await admin.storage
        .from("clip-outputs")
        .remove([videoStoragePath]);
      if (error) cleanupErrors.push("video-storage");
    }
    if (userId) {
      const { error } = await admin.auth.admin.deleteUser(userId);
      if (error) cleanupErrors.push("auth-user");
    }
    if (tempDirectory) {
      const tempRoot = resolve(tmpdir()) + sep;
      const target = resolve(tempDirectory);
      const relativeTarget = relative(tempRoot, target);
      if (!relativeTarget || relativeTarget.startsWith("..")) {
        cleanupErrors.push("temporary-directory-safety-check");
      } else {
        await rm(target, { recursive: true, force: true }).catch(() => {
          cleanupErrors.push("temporary-directory");
        });
      }
    }
    if (cleanupErrors.length > 0) {
      throw new Error(
        `Local YouTube smoke cleanup failed: ${cleanupErrors.join(",")}`,
      );
    }
  }
}

main().catch((error: unknown) => {
  const message =
    error instanceof Error
      ? error.message
      : "unknown local YouTube smoke error";
  console.error(`Local YouTube publication smoke failed: ${message}`);
  process.exitCode = 1;
});
