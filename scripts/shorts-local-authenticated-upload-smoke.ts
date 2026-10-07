import { randomBytes, randomUUID } from "node:crypto";

import { createServerClient } from "@supabase/ssr";
import { createClient } from "@supabase/supabase-js";
import { Upload } from "tus-js-client";

import {
  buildShortsTusOptions,
  getShortsTusEndpoint,
  SHORTS_SOURCE_BUCKET,
} from "../src/lib/shorts/source-upload";

const baseUrl = process.env.CLIPSFLOW_LOCAL_SHORTS_BASE_URL;
const supabaseUrl = process.env.CLIPSFLOW_LOCAL_SUPABASE_URL;
const anonKey = process.env.CLIPSFLOW_LOCAL_SUPABASE_ANON_KEY;
const serviceRoleKey = process.env.CLIPSFLOW_LOCAL_SUPABASE_SERVICE_ROLE_KEY;
const testFile = Buffer.alloc(64 * 1024 + 17, 0x43);

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
    supabase.hash ||
    !getShortsTusEndpoint(supabaseUrl)
  ) {
    throw new Error("This smoke test refuses to write outside local services");
  }

  return { appUrl: app.origin, supabaseUrl, anonKey, serviceRoleKey };
}

async function uploadFile(
  options: ConstructorParameters<typeof Upload>[1],
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error("Local authenticated TUS upload timed out"));
    }, 45_000);

    const upload = new Upload(testFile, {
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

async function main(): Promise<void> {
  const local = requireLocalConfiguration();
  const admin = createClient(local.supabaseUrl, local.serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const email = `clipsflow-shorts-api-${randomUUID()}@example.invalid`;
  const password = randomBytes(32).toString("base64url");
  let userId: string | null = null;
  let episodeId: string | null = null;
  let storagePath: string | null = null;

  try {
    const { data: created, error: createError } =
      await admin.auth.admin.createUser({
        email,
        password,
        email_confirm: true,
      });
    if (createError || !created.user) {
      throw new Error("Could not create the temporary local API test user");
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
      throw new Error("Could not establish a local authenticated app session");
    }

    const cookieHeader = ["NEXT_LOCALE=fr"]
      .concat(Array.from(cookies, ([name, value]) => `${name}=${value}`))
      .join("; ");

    const studioPage = await fetch(new URL("/fr/shorts", local.appUrl), {
      headers: {
        cookie: cookieHeader,
        "accept-language": "fr",
      },
      redirect: "manual",
    });
    const studioMarkup = await studioPage.text();
    const missingStudioMarkers = [
      "STUDIO SHORTS",
      "Importer une vidéo ou un podcast",
    ].filter((marker) => !studioMarkup.includes(marker));
    if (studioPage.status !== 200 || missingStudioMarkers.length > 0) {
      const location = studioPage.headers.get("location");
      throw new Error(
        `The authenticated French Shorts Studio did not render its selection header and import controls (status ${studioPage.status}; missing markers: ${missingStudioMarkers.join(", ") || "none"}; redirect: ${location ?? "none"})`,
      );
    }

    const postJson = async (
      path: string,
      body: unknown,
    ): Promise<{ status: number; body: Record<string, unknown> }> => {
      const response = await fetch(new URL(path, local.appUrl), {
        method: "POST",
        headers: {
          cookie: cookieHeader,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      });
      const responseBody: unknown = await response.json();
      if (
        !responseBody ||
        typeof responseBody !== "object" ||
        Array.isArray(responseBody)
      ) {
        throw new Error(`Local app returned invalid JSON for ${path}`);
      }
      return {
        status: response.status,
        body: responseBody as Record<string, unknown>,
      };
    };

    const unauthorized = await fetch(
      new URL("/api/shorts/uploads", local.appUrl),
      { method: "POST" },
    );
    if (unauthorized.status !== 401) {
      throw new Error(
        "The Shorts upload endpoint did not reject anonymous access",
      );
    }

    const initialization = await postJson("/api/shorts/uploads", {
      file_name: "local-api-smoke.mp4",
      mime: "video/mp4",
      size_bytes: testFile.byteLength,
      title: "Temporary local API smoke test",
    });
    const data = initialization.body.data;
    if (
      initialization.status !== 200 ||
      !data ||
      typeof data !== "object" ||
      Array.isArray(data)
    ) {
      throw new Error("The authenticated Shorts upload initialization failed");
    }
    const upload = data as Record<string, unknown>;
    if (
      typeof upload.episode_id !== "string" ||
      typeof upload.upload_token !== "string" ||
      typeof upload.storage_path !== "string" ||
      typeof upload.endpoint !== "string"
    ) {
      throw new Error("The upload initialization response was incomplete");
    }
    const uploadEndpoint = new URL(upload.endpoint);
    if (uploadEndpoint.origin !== new URL(local.supabaseUrl).origin) {
      throw new Error("The local TUS endpoint points outside local Supabase");
    }
    episodeId = upload.episode_id;
    storagePath = upload.storage_path;

    const tusConfig = {
      endpoint: upload.endpoint,
      bucket: SHORTS_SOURCE_BUCKET,
      storagePath,
      contentType: "video/mp4" as const,
      uploadToken: upload.upload_token,
      accessToken: login.session.access_token,
      apiKey: local.anonKey,
      fingerprint: `local-auth-smoke:${storagePath}`,
    };
    const tusOptions = {
      ...buildShortsTusOptions(tusConfig),
      onError: () => undefined,
      onSuccess: () => undefined,
    } as ConstructorParameters<typeof Upload>[1];
    await uploadFile(tusOptions);

    const completion = await postJson(
      `/api/shorts/uploads/${encodeURIComponent(episodeId)}/complete`,
      { size_bytes: testFile.byteLength },
    );
    if (
      completion.status !== 200 ||
      completion.body.data === null ||
      typeof completion.body.data !== "object" ||
      (completion.body.data as Record<string, unknown>).status !== "ready"
    ) {
      throw new Error("The authenticated Shorts upload did not finalize");
    }

    const paidAnalysisGate = await postJson("/api/shorts/projects", {});
    if (
      paidAnalysisGate.status !== 503 ||
      paidAnalysisGate.body.error !== "analysis_temporarily_unavailable"
    ) {
      throw new Error("The local paid-AI budget gate did not fail closed");
    }

    console.log(
      "Local authenticated Shorts Studio smoke test passed: authenticated French Studio rendered its import controls, anonymous request rejected, authenticated TUS upload finalized, paid-AI analysis remained blocked without budget authorization.",
    );
  } finally {
    if (storagePath) {
      const { error } = await admin.storage
        .from(SHORTS_SOURCE_BUCKET)
        .remove([storagePath]);
      if (error)
        throw new Error("Could not remove the temporary Storage object");
    }
    if (episodeId && userId) {
      const { error } = await admin
        .from("episodes")
        .delete()
        .eq("id", episodeId)
        .eq("user_id", userId);
      if (error) throw new Error("Could not remove the temporary episode row");
    }
    if (userId) {
      const { error } = await admin.auth.admin.deleteUser(userId);
      if (error) throw new Error("Could not remove the temporary local user");
    }
  }
}

main().catch((error: unknown) => {
  const message =
    error instanceof Error ? error.message : "unknown local API smoke error";
  console.error(`Local authenticated Shorts API smoke test failed: ${message}`);
  process.exitCode = 1;
});
