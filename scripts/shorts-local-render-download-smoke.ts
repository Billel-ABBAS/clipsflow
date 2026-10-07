import { createHash, randomBytes, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";

import { createServerClient } from "@supabase/ssr";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import ffmpegPath from "@ffmpeg-installer/ffmpeg";

import { processOneRenderJob } from "../src/lib/clips/render-worker";
import { ELEVENLABS_MUSIC_MODEL } from "../src/lib/clips/elevenlabs";
import {
  refreshClipUrls,
  type ClipUrlFields,
} from "../src/lib/clips/refresh-urls";
import { resolveShortsMusicPrompt } from "../src/lib/clips/elevenlabs-render";
import { SHORTS_SOURCE_BUCKET } from "../src/lib/shorts/source-upload";

const baseUrl = process.env.CLIPSFLOW_LOCAL_SHORTS_BASE_URL;
const supabaseUrl = process.env.CLIPSFLOW_LOCAL_SUPABASE_URL;
const anonKey = process.env.CLIPSFLOW_LOCAL_SUPABASE_ANON_KEY;
const serviceRoleKey = process.env.CLIPSFLOW_LOCAL_SUPABASE_SERVICE_ROLE_KEY;
const syntheticRemoteSourceUrl =
  "https://93.184.216.34/clipsflow-local-render-smoke.mp4";
const projectDurationSeconds = 1_200;
const candidateRanges = [
  { rank: 1, start_seconds: 1, end_seconds: 13 },
  { rank: 2, start_seconds: 18, end_seconds: 30 },
] as const;

function requireLocalConfiguration() {
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

  return { appUrl: app.origin, supabaseUrl, anonKey, serviceRoleKey };
}

async function generateSource(path: string): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => {
    const args = [
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "lavfi",
      "-i",
      "testsrc2=size=320x180:rate=12:duration=36",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440:sample_rate=16000:duration=36",
      "-shortest",
      "-c:v",
      "mpeg4",
      "-q:v",
      "8",
      "-c:a",
      "aac",
      "-b:a",
      "48k",
      "-pix_fmt",
      "yuv420p",
      "-y",
      path,
    ];
    const child = spawn(ffmpegPath.path, args, {
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("Synthetic render source generation timed out"));
    }, 60_000);
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = `${stderr}${chunk.toString("utf8")}`.slice(-1_000);
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolvePromise();
      else reject(new Error(`Synthetic source generation failed: ${stderr}`));
    });
  });
}

async function generateMusicFixture(path: string): Promise<void> {
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
        "sine=frequency=261.63:sample_rate=44100:duration=36",
        "-c:a",
        "libmp3lame",
        "-b:a",
        "128k",
        "-y",
        path,
      ],
      { stdio: "ignore" },
    );
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("Synthetic music fixture generation timed out"));
    }, 30_000);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolvePromise();
      else reject(new Error("Synthetic music fixture generation failed"));
    });
  });
}

function blockExternalFetch(
  localOrigins: ReadonlySet<string>,
  getSyntheticSource: () => Uint8Array | null,
): void {
  const nativeFetch = globalThis.fetch.bind(globalThis);
  globalThis.fetch = async (input, init) => {
    const url =
      input instanceof Request
        ? new URL(input.url)
        : input instanceof URL
          ? input
          : new URL(String(input));
    if (url.href === syntheticRemoteSourceUrl) {
      const method =
        init?.method ?? (input instanceof Request ? input.method : "GET");
      const sourceBytes = getSyntheticSource();
      if (method.toUpperCase() !== "GET" || !sourceBytes) {
        throw new Error("Synthetic remote source request is not configured");
      }
      return new Response(new Uint8Array(sourceBytes), {
        headers: {
          "content-type": "video/mp4",
          "content-length": String(sourceBytes.byteLength),
        },
      });
    }
    if (!localOrigins.has(url.origin)) {
      throw new Error("External network is blocked in the local render smoke");
    }
    return nativeFetch(input, init);
  };
}

async function postJson(
  url: URL,
  cookieHeader: string,
  body: unknown,
  method: "POST" | "PATCH" = "POST",
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(url, {
    method,
    headers: { cookie: cookieHeader, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const parsed: unknown = await response.json();
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Local API returned invalid JSON (${response.status})`);
  }
  return { status: response.status, body: parsed as Record<string, unknown> };
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

async function collectStoragePaths(
  admin: SupabaseClient,
  bucketName: string,
  prefix: string,
  depth = 0,
): Promise<string[]> {
  if (depth > 4) throw new Error("Storage test cleanup exceeded safe depth");
  const storage = admin.storage.from(bucketName);
  const { data, error } = await storage.list(prefix, { limit: 1_000 });
  if (error) throw new Error("Could not inspect temporary render artifacts");

  const paths: string[] = [];
  for (const item of data ?? []) {
    if (!item.name || item.name === "." || item.name === "..") continue;
    const itemPath = `${prefix}/${item.name}`;
    if (item.id === null) {
      paths.push(
        ...(await collectStoragePaths(admin, bucketName, itemPath, depth + 1)),
      );
    } else {
      paths.push(itemPath);
    }
  }
  return paths;
}

async function removeUserStorage(
  admin: SupabaseClient,
  bucketName: string,
  userId: string,
): Promise<void> {
  const storage = admin.storage.from(bucketName);
  const paths = await collectStoragePaths(admin, bucketName, userId);
  if (paths.length === 0) return;
  const { error } = await storage.remove(paths);
  if (error) throw new Error("Could not remove temporary render artifacts");
}

async function cleanupPreviousSmokeUsers(admin: SupabaseClient): Promise<void> {
  const { data, error } = await admin.auth.admin.listUsers({
    page: 1,
    perPage: 100,
  });
  if (error) throw new Error("Could not inspect prior local smoke users");

  for (const user of data.users) {
    if (
      !user.email?.startsWith("clipsflow-shorts-render-") ||
      !user.email.endsWith("@example.invalid")
    ) {
      continue;
    }
    for (const bucketName of [SHORTS_SOURCE_BUCKET, "clip-outputs"]) {
      await removeUserStorage(admin, bucketName, user.id);
    }
    const deleted = await admin.auth.admin.deleteUser(user.id);
    if (deleted.error) {
      throw new Error("Could not remove a prior local smoke user");
    }
  }
}

async function main(): Promise<void> {
  const local = requireLocalConfiguration();
  const admin = createClient(local.supabaseUrl, local.serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const email = `clipsflow-shorts-render-${randomUUID()}@example.invalid`;
  const password = randomBytes(32).toString("base64url");
  const tempDirectory = await mkdtemp(
    join(tmpdir(), "clipsflow-shorts-render-smoke-"),
  );
  const sourcePath = join(tempDirectory, "synthetic-source.mp4");
  const musicFixturePath = join(tempDirectory, "synthetic-music.mp3");
  let userId: string | null = null;
  let syntheticSourceBytes: Uint8Array | null = null;

  try {
    blockExternalFetch(
      new Set([local.appUrl, local.supabaseUrl.replace(/\/$/u, "")]),
      () => syntheticSourceBytes,
    );
    await cleanupPreviousSmokeUsers(admin);
    const pendingRenders = await admin
      .from("jobs")
      .select("id", { count: "exact", head: true })
      .eq("type", "render")
      .eq("status", "pending");
    if (pendingRenders.error || (pendingRenders.count ?? 0) !== 0) {
      throw new Error(
        "Refusing to consume a render queue that was not empty before the smoke test",
      );
    }

    await generateSource(sourcePath);
    await generateMusicFixture(musicFixturePath);
    if ((await stat(sourcePath)).size < 1) {
      throw new Error("Synthetic render source is empty");
    }
    syntheticSourceBytes = await readFile(sourcePath);

    const { data: created, error: createError } =
      await admin.auth.admin.createUser({
        email,
        password,
        email_confirm: true,
      });
    if (createError || !created.user) {
      throw new Error("Could not create the temporary local render user");
    }
    userId = created.user.id;

    const { data: profile, error: profileError } = await admin
      .from("profiles")
      .select("id, plan")
      .eq("id", userId)
      .maybeSingle();
    if (profileError || !profile) {
      throw new Error("The local auth user did not receive its profile row");
    }

    const cookieStore = new Map<string, string>();
    const sessionClient = createServerClient(local.supabaseUrl, local.anonKey, {
      cookies: {
        getAll: () =>
          Array.from(cookieStore, ([name, value]) => ({ name, value })),
        setAll: (values) => {
          for (const { name, value } of values) cookieStore.set(name, value);
        },
      },
    });
    const { data: login, error: loginError } =
      await sessionClient.auth.signInWithPassword({ email, password });
    if (loginError || !login.session || cookieStore.size === 0) {
      throw new Error("Could not establish a local render-smoke session");
    }
    const cookieHeader = ["NEXT_LOCALE=fr"]
      .concat(Array.from(cookieStore, ([name, value]) => `${name}=${value}`))
      .join("; ");

    const words = [
      { text: "Local", start: 1, end: 1.7 },
      { text: "render", start: 2, end: 2.7 },
      { text: "reuses", start: 4, end: 4.8 },
      { text: "saved", start: 7, end: 7.6 },
      { text: "words.", start: 10, end: 10.8 },
      { text: "A", start: 18, end: 18.2 },
      { text: "second", start: 19, end: 19.8 },
      { text: "short", start: 21, end: 21.7 },
      { text: "keeps", start: 24, end: 24.7 },
      { text: "timing.", start: 27, end: 27.9 },
    ];
    const { data: episode, error: episodeError } = await admin
      .from("episodes")
      .insert({
        user_id: userId,
        title: "Temporary local Shorts render source",
        source_type: "url",
        source_url: syntheticRemoteSourceUrl,
        source_storage_path: null,
        status: "ready",
        duration_seconds: projectDurationSeconds,
        transcript_text: words.map((word) => word.text).join(" "),
        transcript_segments: words,
        transcript_language: "en",
      })
      .select("id")
      .single();
    if (episodeError || !episode) {
      throw new Error("Could not create the temporary source episode");
    }

    const projectId = randomUUID();
    const { error: projectError } = await admin.from("shorts_projects").insert({
      id: projectId,
      user_id: userId,
      episode_id: episode.id,
      analysis_mode: "audio",
      status: "ready",
      source_duration_seconds: projectDurationSeconds,
      idempotency_key: randomUUID(),
      transcript_language: "en",
      analysis_payload: { source: "local-render-smoke" },
    });
    if (projectError) {
      throw new Error("Could not seed the temporary ready Shorts project");
    }

    const candidateRows = candidateRanges.map((range) => ({
      project_id: projectId,
      user_id: userId,
      episode_id: episode.id,
      rank: range.rank,
      start_seconds: range.start_seconds,
      end_seconds: range.end_seconds,
      score: 90 - range.rank,
      hook: "Local render smoke test",
      title: `Synthetic short ${range.rank}`,
      rationale: "Temporary deterministic fixture for local rendering.",
      transcript_excerpt: words
        .filter(
          (word) =>
            word.start < range.end_seconds && word.end > range.start_seconds,
        )
        .map((word) => word.text)
        .join(" "),
      music_mood: "minimal",
      motion_direction: "Minimal static captions with a brief title card.",
      visual_summary: null,
      production_profile: {},
    }));
    const { data: candidates, error: candidateError } = await admin
      .from("shorts_candidates")
      .insert(candidateRows)
      .select("id, rank")
      .order("rank", { ascending: true });
    if (candidateError || candidates?.length !== candidateRanges.length) {
      throw new Error("Could not seed two temporary Shorts candidates");
    }
    const candidateIds = candidates.map((candidate) => candidate.id as string);
    const musicBytes = await readFile(musicFixturePath);
    for (const candidate of candidates) {
      const candidateInfo = candidateRanges.find(
        (range) => range.rank === candidate.rank,
      );
      if (!candidateInfo) throw new Error("Invalid local candidate fixture");
      const title = `Synthetic short ${candidate.rank}`;
      const hook = "Local render smoke test";
      const prompt = resolveShortsMusicPrompt(
        title,
        hook,
        "minimal-static",
        "minimal",
      );
      const promptHash = createHash("sha256").update(prompt).digest("hex");
      const musicStoragePath = `${userId}/shorts/${projectId}/${candidate.id}/music-${promptHash}.mp3`;
      const { error: musicUploadError } = await admin.storage
        .from("clip-outputs")
        .upload(musicStoragePath, musicBytes, { contentType: "audio/mpeg" });
      if (musicUploadError) {
        throw new Error(
          `Could not stage the local synthetic music fixture: ${musicUploadError.message}`,
        );
      }
      const { error: audioAssetError } = await admin
        .from("shorts_audio_assets")
        .insert({
          user_id: userId,
          project_id: projectId,
          candidate_id: candidate.id,
          provider: "elevenlabs",
          kind: "music",
          model_id: ELEVENLABS_MUSIC_MODEL,
          prompt_hash: promptHash,
          storage_path: musicStoragePath,
          duration_seconds:
            candidateInfo.end_seconds - candidateInfo.start_seconds,
          license_reference: "synthetic-local-smoke-fixture",
        });
      if (audioAssetError) {
        throw new Error("Could not stage the local cached audio asset");
      }
    }
    const productionProfile = {
      aspect_ratio: "9:16",
      subtitle_style: "minimal",
      subtitles: { synchronized: true, auto_emphasis: false },
      motion: {
        template: "minimal-static",
        reduced_motion: true,
        renderer: "deterministic",
      },
      elevenlabs: {
        enabled: true,
        explicit_consent: true,
        commercial_license_confirmed: true,
        use_cases: ["instrumental_music"],
        synthetic_voice: false,
      },
    };

    const detailUrl = new URL(
      `/api/shorts/projects/${projectId}`,
      local.appUrl,
    );
    const beforeSelection = await fetch(detailUrl, {
      headers: { cookie: cookieHeader },
    });
    if (beforeSelection.status !== 200) {
      const failure = record(await beforeSelection.json().catch(() => null));
      const failureCode =
        typeof failure?.error === "string" ? `: ${failure.error}` : "";
      const requestCookieNames = Array.from(cookieStore.keys()).join(",");
      const responseCookieNames =
        typeof beforeSelection.headers.getSetCookie === "function"
          ? beforeSelection.headers
              .getSetCookie()
              .map((cookie) => cookie.split("=", 1)[0])
              .join(",")
          : "unavailable";
      throw new Error(
        `Authenticated candidate review endpoint failed (HTTP ${beforeSelection.status}${failureCode}; sent_cookie_names=${requestCookieNames}; response_cookie_names=${responseCookieNames})`,
      );
    }
    const selection = await postJson(
      detailUrl,
      cookieHeader,
      {
        candidate_ids: candidateIds,
        production_profile: productionProfile,
      },
      "PATCH",
    );
    if (selection.status !== 200 || !record(selection.body.data)) {
      throw new Error("Authenticated candidate selection failed");
    }

    const render = await postJson(
      new URL(`/api/shorts/projects/${projectId}/render`, local.appUrl),
      cookieHeader,
      { candidate_ids: candidateIds },
    );
    const renderData = record(render.body.data);
    const renderResults = renderData?.results;
    if (
      render.status !== 202 ||
      renderData?.queued_count !== candidateIds.length ||
      !Array.isArray(renderResults) ||
      renderResults.length !== candidateIds.length
    ) {
      throw new Error(
        `Cached-transcript rendering did not queue all selected candidates (${render.status}:${String(render.body.error ?? "unknown")})`,
      );
    }
    const clipIds = renderResults.flatMap((result) => {
      const row = record(result);
      return row?.status === "queued" && typeof row.clip_id === "string"
        ? [row.clip_id]
        : [];
    });
    if (clipIds.length !== candidateIds.length) {
      throw new Error("The render queue response was missing clip IDs");
    }

    for (let index = 0; index < candidateIds.length; index += 1) {
      const result = await processOneRenderJob(admin);
      if (result.kind !== "completed") {
        throw new Error(
          `Local render worker did not complete item ${index + 1}`,
        );
      }
    }

    const { data: clips, error: clipsError } = await admin
      .from("clips")
      .select(
        "id, user_id, status, start_seconds, end_seconds, video_url, video_storage_path, captions_vtt_storage_path",
      )
      .eq("user_id", userId)
      .in("id", clipIds);
    if (
      clipsError ||
      clips?.length !== clipIds.length ||
      clips.some(
        (clip) =>
          clip.status !== "completed" ||
          typeof clip.video_storage_path !== "string" ||
          typeof clip.captions_vtt_storage_path !== "string",
      )
    ) {
      throw new Error("Rendered Shorts or synchronized captions were missing");
    }

    const downloadableClips = (await refreshClipUrls(
      admin as unknown as SupabaseClient,
      clips,
    )) as Array<(typeof clips)[number] & ClipUrlFields>;
    for (const clip of downloadableClips) {
      if (!clip.video_download_url || !clip.captions_vtt_download_url) {
        throw new Error("The individual MP4 or VTT download link was missing");
      }
      const [videoResponse, captionResponse] = await Promise.all([
        fetch(clip.video_download_url),
        fetch(clip.captions_vtt_download_url),
      ]);
      if (!videoResponse.ok || !captionResponse.ok) {
        throw new Error("An individual signed download URL did not resolve");
      }
      const video = Buffer.from(await videoResponse.arrayBuffer());
      const captions = await captionResponse.text();
      if (
        video.length < 1_000 ||
        video.toString("ascii", 4, 8) !== "ftyp" ||
        !captions.startsWith("WEBVTT") ||
        !/\d{2}:\d{2}:\d{2}\.\d{3}\s+-->\s+\d{2}:\d{2}:\d{2}\.\d{3}/u.test(
          captions,
        )
      ) {
        throw new Error("An individual MP4 or synchronized VTT was invalid");
      }
    }

    const bulkUrl = new URL("/api/clips/download/bulk", local.appUrl);
    bulkUrl.searchParams.set("clip_ids", clipIds.join(","));
    const bulkResponse = await fetch(bulkUrl, {
      headers: { cookie: cookieHeader },
    });
    const archive = Buffer.from(await bulkResponse.arrayBuffer());
    if (
      !bulkResponse.ok ||
      bulkResponse.headers.get("content-type") !== "application/zip" ||
      archive.toString("ascii", 0, 2) !== "PK" ||
      Number(bulkResponse.headers.get("content-length")) !== archive.length
    ) {
      const responsePreview = archive
        .toString("utf8", 0, Math.min(200, archive.length))
        .replace(/\s+/gu, " ");
      throw new Error(
        `Authenticated bulk ZIP download failed validation (HTTP ${bulkResponse.status}; content_type=${bulkResponse.headers.get("content-type") ?? "missing"}; declared_length=${bulkResponse.headers.get("content-length") ?? "missing"}; actual_length=${archive.length}; starts_with_zip=${archive.toString("ascii", 0, 2) === "PK"}; preview=${responsePreview})`,
      );
    }

    console.log(
      "Local authenticated Shorts render smoke test passed: two candidates selected and rendered from persisted transcripts plus cached synthetic music, individual MP4/VTT downloads resolved, and the authenticated bulk ZIP validated. External network calls were blocked.",
    );
  } finally {
    const cleanupErrors: string[] = [];
    if (userId) {
      for (const bucketName of [SHORTS_SOURCE_BUCKET, "clip-outputs"]) {
        try {
          await removeUserStorage(
            admin as unknown as SupabaseClient,
            bucketName,
            userId,
          );
        } catch {
          cleanupErrors.push(`storage:${bucketName}`);
        }
      }
      try {
        const { error } = await admin.auth.admin.deleteUser(userId);
        if (error) cleanupErrors.push("auth-user");
      } catch {
        cleanupErrors.push("auth-user");
      }
    }
    const tempRoot = resolve(tmpdir()) + sep;
    const target = resolve(tempDirectory);
    const relativeTarget = relative(tempRoot, target);
    if (!relativeTarget || relativeTarget.startsWith("..")) {
      cleanupErrors.push("temporary-directory-safety-check");
    } else {
      try {
        await rm(target, { recursive: true, force: true });
      } catch {
        cleanupErrors.push("temporary-directory");
      }
    }

    if (cleanupErrors.length > 0) {
      throw new Error(
        `Local render smoke cleanup failed: ${cleanupErrors.join(",")}`,
      );
    }
  }
}

main().catch((error: unknown) => {
  const message =
    error instanceof Error ? error.message : "unknown local render smoke error";
  console.error(`Local Shorts render smoke test failed: ${message}`);
  process.exitCode = 1;
});
