import { createHash, randomBytes, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createServerClient } from "@supabase/ssr";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { Upload } from "tus-js-client";
import ffmpegPath from "@ffmpeg-installer/ffmpeg";

import type { AnalyzeLongformCandidatesInput } from "../src/lib/shorts/longform-openai";
import {
  processOneShortsAnalysisJob,
  type ShortsAnalysisWorkerDependencies,
} from "../src/lib/shorts/analysis-worker";
import type { ShortsVisualSummary } from "../src/lib/shorts/visual-analysis";
import { processOneRenderJob } from "../src/lib/clips/render-worker";
import { ELEVENLABS_MUSIC_MODEL } from "../src/lib/clips/elevenlabs";
import {
  refreshClipUrls,
  type ClipUrlFields,
} from "../src/lib/clips/refresh-urls";
import { resolveShortsMusicPrompt } from "../src/lib/clips/elevenlabs-render";
import {
  buildShortsTusOptions,
  getShortsTusEndpoint,
  SHORTS_SOURCE_BUCKET,
} from "../src/lib/shorts/source-upload";

const appBaseUrl = process.env.CLIPSFLOW_LOCAL_SHORTS_BASE_URL;
const supabaseUrl = process.env.CLIPSFLOW_LOCAL_SUPABASE_URL;
const anonKey = process.env.CLIPSFLOW_LOCAL_SUPABASE_ANON_KEY;
const serviceRoleKey = process.env.CLIPSFLOW_LOCAL_SUPABASE_SERVICE_ROLE_KEY;
let sourceBytes = Buffer.alloc(64 * 1024 + 17, 0x43);
const sourceDurationSeconds = 1_200;
const syntheticSourceMediaSeconds = 120;
const creatorInstructions = "Prioriser les conseils pratiques et autonomes.";

async function runFfmpegFixture(
  args: string[],
  timeoutMs: number,
  label: string,
): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn(ffmpegPath.path, args, {
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`${label} timed out`));
    }, timeoutMs);
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
      else reject(new Error(`${label} failed: ${stderr}`));
    });
  });
}

async function generateSyntheticSource(path: string): Promise<void> {
  await runFfmpegFixture(
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "lavfi",
      "-i",
      `testsrc2=size=320x180:rate=12:duration=${syntheticSourceMediaSeconds}`,
      "-f",
      "lavfi",
      "-i",
      `sine=frequency=440:sample_rate=16000:duration=${syntheticSourceMediaSeconds}`,
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
    ],
    60_000,
    "Synthetic analysis source generation",
  );
}

async function generateSyntheticMusic(path: string): Promise<void> {
  await runFfmpegFixture(
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=261.63:sample_rate=44100:duration=60",
      "-c:a",
      "libmp3lame",
      "-b:a",
      "128k",
      "-y",
      path,
    ],
    30_000,
    "Synthetic instrumental generation",
  );
}

function requireLocalConfiguration() {
  if (!appBaseUrl || !supabaseUrl || !anonKey || !serviceRoleKey) {
    throw new Error("Local app URL and local Supabase keys are required");
  }

  const app = new URL(appBaseUrl);
  const supabase = new URL(supabaseUrl);
  if (
    app.protocol !== "http:" ||
    !["localhost", "127.0.0.1", "::1"].includes(app.hostname) ||
    app.port !== "3104" ||
    supabase.protocol !== "http:" ||
    !["localhost", "127.0.0.1", "::1"].includes(supabase.hostname) ||
    supabase.port !== "54321" ||
    !getShortsTusEndpoint(supabaseUrl)
  ) {
    throw new Error("This smoke test refuses to write outside local services");
  }

  return { appUrl: app.origin, supabaseUrl, anonKey, serviceRoleKey };
}

function blockExternalFetch(localOrigins: ReadonlySet<string>): () => void {
  const nativeFetch = globalThis.fetch.bind(globalThis);
  globalThis.fetch = async (input, init) => {
    const url =
      input instanceof Request
        ? new URL(input.url)
        : input instanceof URL
          ? input
          : new URL(String(input));
    if (!localOrigins.has(url.origin)) {
      throw new Error(
        "External network is blocked in the local analysis smoke",
      );
    }
    return nativeFetch(input, init);
  };
  return () => {
    globalThis.fetch = nativeFetch;
  };
}

async function uploadFile(
  options: ConstructorParameters<typeof Upload>[1],
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error("Local authenticated TUS upload timed out"));
    }, 45_000);

    const upload = new Upload(sourceBytes, {
      ...options,
      onError(error) {
        clearTimeout(timer);
        reject(error);
      },
      onSuccess() {
        clearTimeout(timer);
        resolve();
      },
    });
    upload.start();
  });
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function requireApiData(
  body: Record<string, unknown>,
): Record<string, unknown> {
  const data = record(body.data);
  if (!data) {
    const error =
      typeof body.error === "string" ? body.error : "response_data_missing";
    throw new Error(`Local Shorts API response omitted its data (${error})`);
  }
  return data;
}

function analysisDependencies(
  failTranscription: boolean,
  analysisMode: "audio" | "audio_video" = "audio",
): ShortsAnalysisWorkerDependencies {
  let analyzedCandidateIds: string[] = [];
  const transcriptWords = [
    {
      start: 10,
      words: [
        "Trois",
        "conseils",
        "simples",
        "pour",
        "mieux",
        "retenir",
        "ce",
        "que",
        "vous",
        "apprenez",
        "chaque",
        "jour.",
      ],
    },
    {
      start: 52,
      words: ["Une", "méthode", "courte", "pour", "garder", "l'essentiel."],
    },
  ].flatMap(({ start, words }) =>
    words.map((text, index) => {
      const wordStart = start + index * 0.35;
      return { text, start: wordStart, end: wordStart + 0.28 };
    }),
  );

  return {
    environment: {
      SHORTS_ANALYSIS_WORKER_ENABLED: "true",
      CLIPS_AI_BUDGET_AUTHORIZED: "true",
      OPENAI_API_KEY: "local-mock-no-network",
      GROQ_API_KEY: "local-mock-no-network",
      ...(analysisMode === "audio_video"
        ? {
            CLIPS_VISUAL_ANALYSIS_ENABLED: "true",
            CLIPS_VISUAL_ANALYSIS_PROVIDER: "gemini",
            GEMINI_API_KEY: "local-mock-no-network",
          }
        : {}),
    },
    resolveSource: async () => ({
      url: "http://127.0.0.1:54321/mock-media/source.wav",
      allowedHosts: ["127.0.0.1"],
    }),
    downloadSource: async () => ({
      path: `local-analysis-source-${randomUUID()}.wav`,
      bytes: sourceBytes.byteLength,
      contentType: "audio/wav",
    }),
    probeMedia: async () => ({
      durationSeconds: sourceDurationSeconds,
      hasVideo: analysisMode === "audio_video",
    }),
    extractAudioChunk: async (_source, startSeconds) =>
      `local-analysis-chunk-${Math.round(startSeconds)}.wav`,
    transcribe: async (_sourceUrl, audioPath) => {
      if (failTranscription) throw new Error("synthetic_transcription_failure");
      return {
        words: audioPath.endsWith("-0.wav") ? transcriptWords : [],
        detectedLanguage: "fr",
        model: "local-mock-whisper",
      };
    },
    analyzeCandidates: async (input: AnalyzeLongformCandidatesInput) => {
      const candidates = input.candidateWindows
        .filter(({ transcript }) => transcript.length > 0)
        .slice(0, 2);
      if (candidates.length !== 2) {
        throw new Error("synthetic_candidates_missing");
      }
      analyzedCandidateIds = candidates.map((candidate) => candidate.id);
      return {
        version: "longform-analysis-v1",
        summary: "Un passage de conseils pratiques identifié dans la source.",
        moments: candidates.map((candidate, index) => ({
          candidate_id: candidate.id,
          score: index === 0 ? 94 : 91,
          proposed_title:
            index === 0
              ? "Trois conseils pour mieux retenir"
              : "Une méthode pour garder l'essentiel",
          hook: candidate.transcript,
          rationale:
            "Le passage présente une idée concrète et compréhensible seul.",
          music_mood: "focused",
          motion_direction: "Faire apparaître les idées au rythme du texte.",
        })),
      };
    },
    ...(analysisMode === "audio_video"
      ? {
          extractVisualFrames: async (
            _source: string,
            windows: AnalyzeLongformCandidatesInput["candidateWindows"],
          ) =>
            windows.map((window) => ({
              candidateId: window.id,
              frames: [
                {
                  timestampSeconds: window.start_seconds,
                  bytes: new Uint8Array([1, 2, 3]),
                },
              ],
            })),
          analyzeVisualFrames: async (
            frameSets: readonly { candidateId: string }[],
          ): Promise<ShortsVisualSummary[]> =>
            frameSets.map(({ candidateId }) => ({
              candidateId,
              summary: `Local visual evidence for ${candidateId}.`,
              // Force a deterministic order change so this smoke proves the
              // visual scores reach the final candidate ranking.
              visualScore:
                analyzedCandidateIds.indexOf(candidateId) === 0 ? 0 : 100,
            })),
        }
      : {}),
  };
}

async function main(): Promise<void> {
  const local = requireLocalConfiguration();
  const previousSupabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  process.env.NEXT_PUBLIC_SUPABASE_URL = local.supabaseUrl;
  const restoreFetch = blockExternalFetch(
    new Set([local.appUrl, new URL(local.supabaseUrl).origin]),
  );
  const admin = createClient(local.supabaseUrl, local.serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const email = `clipsflow-shorts-analysis-${randomUUID()}@example.invalid`;
  const password = randomBytes(32).toString("base64url");
  let tempDirectory: string | null = null;
  let musicFixtureBytes: Buffer | null = null;
  let userId: string | null = null;
  let episodeId: string | null = null;
  let storagePath: string | null = null;
  const cachedMusicPaths = new Set<string>();

  try {
    const pendingAnalysisJobs = await admin
      .from("shorts_analysis_jobs")
      .select("id", { count: "exact", head: true })
      .in("status", ["pending", "processing"]);
    const pendingRenderJobs = await admin
      .from("jobs")
      .select("id", { count: "exact", head: true })
      .eq("type", "render")
      .in("status", ["pending", "processing"]);
    if (
      pendingAnalysisJobs.error ||
      (pendingAnalysisJobs.count ?? 0) !== 0 ||
      pendingRenderJobs.error ||
      (pendingRenderJobs.count ?? 0) !== 0
    ) {
      throw new Error(
        "Refusing to run the pipeline smoke while another local analysis or render job is active",
      );
    }

    tempDirectory = await mkdtemp(
      join(tmpdir(), "clipsflow-shorts-analysis-smoke-"),
    );
    const sourceFixturePath = join(tempDirectory, "synthetic-source.mp4");
    const musicFixturePath = join(tempDirectory, "synthetic-music.mp3");
    await generateSyntheticSource(sourceFixturePath);
    await generateSyntheticMusic(musicFixturePath);
    sourceBytes = await readFile(sourceFixturePath);
    musicFixtureBytes = await readFile(musicFixturePath);
    if (!sourceBytes.subarray(0, 12).includes(Buffer.from("ftyp"))) {
      throw new Error("Generated local source is not an MP4 fixture");
    }

    const { data: created, error: createError } =
      await admin.auth.admin.createUser({
        email,
        password,
        email_confirm: true,
      });
    if (createError || !created.user) {
      throw new Error("Could not create the temporary local analysis user");
    }
    userId = created.user.id;

    const cookies = new Map<string, string>();
    const sessionClient = createServerClient(local.supabaseUrl, local.anonKey, {
      cookies: {
        getAll: () => Array.from(cookies, ([name, value]) => ({ name, value })),
        setAll: (values) => {
          for (const { name, value } of values) cookies.set(name, value);
        },
      },
    });
    const { data: login, error: loginError } =
      await sessionClient.auth.signInWithPassword({ email, password });
    if (loginError || !login.session?.access_token || cookies.size === 0) {
      throw new Error("Could not establish a local analysis session");
    }

    const cookieHeader = ["NEXT_LOCALE=fr"]
      .concat(Array.from(cookies, ([name, value]) => `${name}=${value}`))
      .join("; ");
    const requestJson = async (
      path: string,
      method: "GET" | "POST" | "PATCH",
      body?: unknown,
    ): Promise<{ status: number; body: Record<string, unknown> }> => {
      const response = await fetch(new URL(path, local.appUrl), {
        method,
        headers: {
          cookie: cookieHeader,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const responseBody: unknown = await response.json();
      const parsed = record(responseBody);
      if (!parsed)
        throw new Error(`Local API returned invalid JSON for ${path}`);
      return { status: response.status, body: parsed };
    };

    const initialization = await requestJson("/api/shorts/uploads", "POST", {
      file_name: "synthetic-analysis-source.mp4",
      mime: "video/mp4",
      size_bytes: sourceBytes.byteLength,
      title: "Temporary Shorts analysis smoke",
    });
    const upload = record(initialization.body.data);
    if (
      initialization.status !== 200 ||
      typeof upload?.episode_id !== "string" ||
      typeof upload.upload_token !== "string" ||
      typeof upload.storage_path !== "string" ||
      typeof upload.endpoint !== "string"
    ) {
      throw new Error(
        "The authenticated local source upload did not initialize",
      );
    }
    episodeId = upload.episode_id;
    storagePath = upload.storage_path;
    if (new URL(upload.endpoint).origin !== new URL(local.supabaseUrl).origin) {
      throw new Error("The local TUS endpoint points outside Docker Supabase");
    }

    await uploadFile({
      ...buildShortsTusOptions({
        endpoint: upload.endpoint,
        bucket: SHORTS_SOURCE_BUCKET,
        storagePath,
        contentType: "video/mp4",
        uploadToken: upload.upload_token,
        accessToken: login.session.access_token,
        apiKey: local.anonKey,
        fingerprint: `local-analysis-smoke:${storagePath}`,
      }),
      onError: () => undefined,
      onSuccess: () => undefined,
    });

    const completion = await requestJson(
      `/api/shorts/uploads/${encodeURIComponent(episodeId)}/complete`,
      "POST",
      { size_bytes: sourceBytes.byteLength },
    );
    if (
      completion.status !== 200 ||
      record(completion.body.data)?.status !== "ready"
    ) {
      throw new Error("The local synthetic source did not finalize as ready");
    }

    const intent = {
      episode_id: episodeId,
      analysis_mode: "audio",
      duration_seconds: sourceDurationSeconds,
      instructions: creatorInstructions,
      jev_shadow_consent: false,
    } as const;
    const firstIdempotencyKey = randomUUID();
    const firstSubmission = await requestJson("/api/shorts/projects", "POST", {
      ...intent,
      idempotency_key: firstIdempotencyKey,
    });
    const firstData = requireApiData(firstSubmission.body);
    const failedProjectId = firstData.project_id;
    if (
      firstSubmission.status !== 202 ||
      typeof failedProjectId !== "string" ||
      firstData.status !== "queued"
    ) {
      throw new Error("The local analysis project did not enter the queue");
    }

    const failed = await processOneShortsAnalysisJob(
      admin,
      analysisDependencies(true),
    );
    if (failed.kind !== "failed") {
      throw new Error("The injected transcription failure was not terminal");
    }
    const sameRequest = await requestJson("/api/shorts/projects", "POST", {
      ...intent,
      idempotency_key: firstIdempotencyKey,
    });
    const sameRequestData = requireApiData(sameRequest.body);
    if (
      sameRequest.status !== 200 ||
      sameRequestData.project_id !== failedProjectId ||
      sameRequestData.status !== "failed"
    ) {
      throw new Error("The same idempotency key did not return its failed job");
    }

    const retrySubmission = await requestJson("/api/shorts/projects", "POST", {
      ...intent,
      idempotency_key: randomUUID(),
    });
    const retryData = requireApiData(retrySubmission.body);
    const retryProjectId = retryData.project_id;
    if (
      retrySubmission.status !== 202 ||
      typeof retryProjectId !== "string" ||
      retryProjectId === failedProjectId ||
      retryData.status !== "queued"
    ) {
      throw new Error("A fresh idempotency key did not create a retry job");
    }

    const retried = await processOneShortsAnalysisJob(
      admin,
      analysisDependencies(false),
    );
    if (retried.kind !== "completed") {
      throw new Error("The local mocked analysis worker did not complete");
    }

    const projectResponse = await requestJson(
      `/api/shorts/projects/${encodeURIComponent(retryProjectId)}`,
      "GET",
    );
    const projectData = requireApiData(projectResponse.body);
    const project = record(projectData.project);
    const candidates = Array.isArray(projectData.candidates)
      ? projectData.candidates.map(record).filter((value) => value !== null)
      : [];
    if (
      projectResponse.status !== 200 ||
      project?.status !== "ready" ||
      project.duration_seconds !== sourceDurationSeconds ||
      candidates.length !== 2 ||
      candidates[0]?.title !== "Trois conseils pour mieux retenir" ||
      candidates[1]?.title !== "Une méthode pour garder l'essentiel" ||
      typeof candidates[0]?.transcript_excerpt !== "string" ||
      !candidates[0].transcript_excerpt.includes("retenir") ||
      typeof candidates[1]?.transcript_excerpt !== "string" ||
      !candidates[1].transcript_excerpt.includes("l'essentiel") ||
      "transcript_text" in project ||
      "analysis_payload" in projectData
    ) {
      throw new Error(
        "The completed analysis was not safely exposed as a candidate",
      );
    }

    const audioVideoSubmission = await requestJson(
      "/api/shorts/projects",
      "POST",
      {
        episode_id: episodeId,
        analysis_mode: "audio_video",
        duration_seconds: sourceDurationSeconds,
        instructions: creatorInstructions,
        jev_shadow_consent: false,
        idempotency_key: randomUUID(),
      },
    );
    const audioVideoSubmissionData = requireApiData(audioVideoSubmission.body);
    const audioVideoProjectId = audioVideoSubmissionData.project_id;
    if (
      audioVideoSubmission.status !== 202 ||
      typeof audioVideoProjectId !== "string" ||
      audioVideoSubmissionData.status !== "queued"
    ) {
      throw new Error("The local audio+video analysis project did not queue");
    }

    const audioVideoResult = await processOneShortsAnalysisJob(
      admin,
      analysisDependencies(false, "audio_video"),
    );
    if (audioVideoResult.kind !== "completed") {
      throw new Error("The local mocked audio+video worker did not complete");
    }

    const audioVideoResponse = await requestJson(
      `/api/shorts/projects/${encodeURIComponent(audioVideoProjectId)}`,
      "GET",
    );
    const audioVideoData = requireApiData(audioVideoResponse.body);
    const audioVideoProject = record(audioVideoData.project);
    const audioVideoCandidates = Array.isArray(audioVideoData.candidates)
      ? audioVideoData.candidates.map(record).filter((value) => value !== null)
      : [];
    const { data: visualAnalysisRow, error: visualAnalysisError } = await admin
      .from("shorts_projects")
      .select("analysis_payload")
      .eq("id", audioVideoProjectId)
      .eq("user_id", userId)
      .maybeSingle();
    const visualAnalysisPayload = record(visualAnalysisRow?.analysis_payload);
    const visualRanking = record(visualAnalysisPayload?.visual_ranking);
    const visualRankingCandidates = Array.isArray(visualRanking?.candidates)
      ? visualRanking.candidates.map(record).filter((value) => value !== null)
      : [];
    if (
      audioVideoResponse.status !== 200 ||
      audioVideoProject?.analysis_mode !== "audio_video" ||
      audioVideoProject?.status !== "ready" ||
      audioVideoCandidates.length !== 2 ||
      audioVideoCandidates[0]?.title !==
        "Une méthode pour garder l'essentiel" ||
      audioVideoCandidates[1]?.title !== "Trois conseils pour mieux retenir" ||
      audioVideoCandidates.some(
        (candidate) =>
          typeof candidate.visual_summary !== "string" ||
          !candidate.visual_summary.startsWith("Local visual evidence for "),
      ) ||
      visualAnalysisError ||
      visualRanking?.audio_weight !== 0.8 ||
      visualRanking?.visual_weight !== 0.2 ||
      visualRankingCandidates.length !== 2 ||
      visualRankingCandidates.some(
        (candidate) => typeof candidate.visual_score !== "number",
      )
    ) {
      throw new Error(
        "Audio+video analysis did not persist visual evidence and re-rank candidates",
      );
    }

    const { data: episode, error: episodeError } = await admin
      .from("episodes")
      .select("transcript_text, transcript_segments, transcript_language")
      .eq("id", episodeId)
      .eq("user_id", userId)
      .maybeSingle();
    if (
      episodeError ||
      typeof episode?.transcript_text !== "string" ||
      !episode.transcript_text.includes("retenir") ||
      !Array.isArray(episode.transcript_segments) ||
      episode.transcript_language !== "fr"
    ) {
      throw new Error("The full timestamped transcript was not persisted");
    }

    const candidateIds = candidates
      .map((candidate) => candidate.id)
      .filter(
        (candidateId): candidateId is string => typeof candidateId === "string",
      );
    if (candidateIds.length !== 2 || new Set(candidateIds).size !== 2) {
      throw new Error("The completed analysis did not expose two candidates");
    }

    // The disposable smoke user has the normal free-plan render allowance
    // (60 seconds). Keep both real candidate windows inside that allowance.
    for (const [index, candidateId] of candidateIds.entries()) {
      const startSeconds = index === 0 ? 10 : 52;
      const { data, error } = await admin
        .from("shorts_candidates")
        .update({
          start_seconds: startSeconds,
          end_seconds: startSeconds + 15,
        })
        .eq("id", candidateId)
        .eq("user_id", userId)
        .select("id");
      if (error || data?.length !== 1) {
        throw new Error("Could not bound the local smoke clips to 15 seconds");
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
      creative_direction: { enabled: false, explicit_consent: false },
    };
    if (!musicFixtureBytes) {
      throw new Error("Synthetic local instrumental fixture is unavailable");
    }
    for (const candidate of candidates) {
      if (
        typeof candidate.id !== "string" ||
        typeof candidate.title !== "string" ||
        typeof candidate.hook !== "string" ||
        typeof candidate.music_mood !== "string"
      ) {
        throw new Error("A local analysis candidate was incomplete");
      }
      const musicPrompt = resolveShortsMusicPrompt(
        candidate.title,
        candidate.hook,
        productionProfile.motion.template,
        candidate.music_mood,
      );
      const musicPromptHash = createHash("sha256")
        .update(musicPrompt)
        .digest("hex");
      const musicPath = `${userId}/shorts/${retryProjectId}/${candidate.id}/music-${musicPromptHash}.mp3`;
      const { error: musicUploadError } = await admin.storage
        .from("clip-outputs")
        .upload(musicPath, musicFixtureBytes, {
          contentType: "audio/mpeg",
        });
      if (musicUploadError) {
        throw new Error("Could not stage the synthetic local music cache");
      }
      cachedMusicPaths.add(musicPath);
      const { error: musicAssetError } = await admin
        .from("shorts_audio_assets")
        .insert({
          user_id: userId,
          project_id: retryProjectId,
          candidate_id: candidate.id,
          provider: "elevenlabs",
          kind: "music",
          model_id: ELEVENLABS_MUSIC_MODEL,
          prompt_hash: musicPromptHash,
          storage_path: musicPath,
          duration_seconds: 60,
          license_reference: "synthetic-local-smoke-fixture",
        });
      if (musicAssetError) {
        throw new Error("Could not persist the synthetic local music cache");
      }
    }

    const selection = await requestJson(
      `/api/shorts/projects/${encodeURIComponent(retryProjectId)}`,
      "PATCH",
      {
        candidate_ids: candidateIds,
        production_profile: productionProfile,
      },
    );
    const selectionData = requireApiData(selection.body);
    if (
      selection.status !== 200 ||
      selectionData.selected_count !== candidateIds.length ||
      !Array.isArray(selectionData.selected_candidate_ids) ||
      selectionData.selected_candidate_ids.join(",") !== candidateIds.join(",")
    ) {
      throw new Error("The authenticated candidate selection did not persist");
    }

    const renderSubmission = await requestJson(
      `/api/shorts/projects/${encodeURIComponent(retryProjectId)}/render`,
      "POST",
      { candidate_ids: candidateIds },
    );
    const renderData = requireApiData(renderSubmission.body);
    const renderResults = Array.isArray(renderData.results)
      ? renderData.results.map(record).filter((value) => value !== null)
      : [];
    if (
      renderSubmission.status !== 202 ||
      renderData.queued_count !== candidateIds.length ||
      renderResults.length !== candidateIds.length ||
      renderResults.some(
        (result, index) =>
          result?.candidate_id !== candidateIds[index] ||
          result?.status !== "queued" ||
          typeof result?.clip_id !== "string" ||
          typeof result?.job_id !== "string",
      )
    ) {
      const resultSummary = renderResults
        .map((result) => `${String(result?.status)}:${String(result?.error)}`)
        .join(",");
      throw new Error(
        `The selected candidates did not enter the render queue (status=${renderSubmission.status}, queued=${String(renderData.queued_count)}, results=${resultSummary || "none"})`,
      );
    }

    const renderedClipIds = renderResults.map(
      (result) => result?.clip_id as string,
    );
    const renderJobIds = renderResults.map(
      (result) => result?.job_id as string,
    );
    const queuedRender = await admin
      .from("jobs")
      .select("id, user_id, status")
      .in("id", renderJobIds)
      .eq("user_id", userId);
    if (
      queuedRender.error ||
      !queuedRender.data ||
      queuedRender.data.length !== renderJobIds.length ||
      queuedRender.data.some((job) => job.status !== "pending")
    ) {
      throw new Error("The render job was not isolated to the smoke user");
    }

    for (const renderJobId of renderJobIds) {
      const rendered = await processOneRenderJob(admin);
      if (rendered.kind !== "completed" || rendered.jobId !== renderJobId) {
        throw new Error(
          "The render worker did not complete the analysis smoke's exact jobs",
        );
      }
    }

    const { data: renderedClips, error: renderedClipError } = await admin
      .from("clips")
      .select(
        "id, user_id, status, video_storage_path, captions_vtt_storage_path",
      )
      .in("id", renderedClipIds)
      .eq("user_id", userId);
    if (
      renderedClipError ||
      !renderedClips ||
      renderedClips.length !== renderedClipIds.length ||
      renderedClips.some(
        (clip) =>
          clip.status !== "completed" ||
          typeof clip.video_storage_path !== "string" ||
          typeof clip.captions_vtt_storage_path !== "string",
      )
    ) {
      throw new Error(
        "The selected analysis candidate did not render to MP4/VTT",
      );
    }

    const downloadableClips = (await refreshClipUrls(
      admin as unknown as SupabaseClient,
      renderedClips,
    )) as Array<(typeof renderedClips)[number] & ClipUrlFields>;
    for (const downloadableClip of downloadableClips) {
      if (
        !downloadableClip.video_download_url ||
        !downloadableClip.captions_vtt_download_url
      ) {
        throw new Error(
          "Rendered analysis output has no individual download URLs",
        );
      }
      const [videoResponse, captionsResponse] = await Promise.all([
        fetch(downloadableClip.video_download_url),
        fetch(downloadableClip.captions_vtt_download_url),
      ]);
      const videoBytes = Buffer.from(await videoResponse.arrayBuffer());
      const captionsVtt = await captionsResponse.text();
      if (
        !videoResponse.ok ||
        !captionsResponse.ok ||
        videoBytes.length < 1_000 ||
        videoBytes.toString("ascii", 4, 8) !== "ftyp" ||
        !captionsVtt.startsWith("WEBVTT") ||
        !/\d{2}:\d{2}:\d{2}\.\d{3}\s+-->\s+\d{2}:\d{2}:\d{2}\.\d{3}/u.test(
          captionsVtt,
        )
      ) {
        throw new Error(
          "Individual analysis MP4 or synchronized VTT was invalid",
        );
      }
    }

    const bulkUrl = new URL("/api/clips/download/bulk", local.appUrl);
    bulkUrl.searchParams.set("clip_ids", renderedClipIds.join(","));
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
      throw new Error("The analysis smoke MP4 did not download in a valid ZIP");
    }

    console.log(
      "Local Shorts pipeline smoke passed end to end: authenticated TUS upload, audio and audio+video analysis, analysis failure/retry/idempotency, transcript/candidate/visual-evidence persistence, audio+video re-ranking, two-candidate selection, cached synthetic music, two FFmpeg MP4/VTT renders, individual downloads, and authenticated ZIP download all completed against Docker Supabase with mocked AI providers and external network blocked.",
    );
  } finally {
    restoreFetch();
    if (previousSupabaseUrl === undefined) {
      delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    } else {
      process.env.NEXT_PUBLIC_SUPABASE_URL = previousSupabaseUrl;
    }
    const cleanupErrors: string[] = [];
    if (userId) {
      const { data: clips, error: clipsError } = await admin
        .from("clips")
        .select("video_storage_path, captions_vtt_storage_path")
        .eq("user_id", userId);
      if (clipsError) {
        cleanupErrors.push("could not inspect generated clip artifacts");
      }
      const outputPaths = new Set<string>();
      for (const musicPath of cachedMusicPaths) outputPaths.add(musicPath);
      for (const clip of clips ?? []) {
        if (typeof clip.video_storage_path === "string") {
          outputPaths.add(clip.video_storage_path);
        }
        if (typeof clip.captions_vtt_storage_path === "string") {
          outputPaths.add(clip.captions_vtt_storage_path);
        }
      }
      if (outputPaths.size > 0) {
        const { error } = await admin.storage
          .from("clip-outputs")
          .remove(Array.from(outputPaths));
        if (error)
          cleanupErrors.push("could not remove generated clip artifacts");
      }
    }
    if (storagePath) {
      const { error } = await admin.storage
        .from(SHORTS_SOURCE_BUCKET)
        .remove([storagePath]);
      if (error)
        cleanupErrors.push("could not remove the temporary source object");
    }
    if (episodeId && userId) {
      const { error } = await admin
        .from("episodes")
        .delete()
        .eq("id", episodeId)
        .eq("user_id", userId);
      if (error) cleanupErrors.push("could not remove the temporary episode");
    }
    if (userId) {
      const { error } = await admin.auth.admin.deleteUser(userId);
      if (error)
        cleanupErrors.push("could not remove the temporary local user");
    }
    if (tempDirectory) {
      await rm(tempDirectory, { recursive: true, force: true });
    }
    if (cleanupErrors.length > 0) {
      throw new Error(
        `Local analysis smoke cleanup failed: ${cleanupErrors.join(", ")}`,
      );
    }
  }
}

main().catch((error: unknown) => {
  const message =
    error instanceof Error
      ? error.message
      : "unknown local analysis smoke error";
  console.error(`Local Shorts analysis smoke failed: ${message}`);
  process.exitCode = 1;
});
