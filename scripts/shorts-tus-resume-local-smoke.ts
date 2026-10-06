import { randomBytes, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";

import { createClient } from "@supabase/supabase-js";
import { Upload } from "tus-js-client";

import {
  buildShortsTusOptions,
  getShortsTusEndpoint,
  SHORTS_SOURCE_BUCKET,
  SHORTS_TUS_CHUNK_BYTES,
} from "../src/lib/shorts/source-upload";

const supabaseUrl = process.env.CLIPSFLOW_LOCAL_SUPABASE_URL;
const anonKey = process.env.CLIPSFLOW_LOCAL_SUPABASE_ANON_KEY;
const serviceRoleKey = process.env.CLIPSFLOW_LOCAL_SUPABASE_SERVICE_ROLE_KEY;

type PreviousTusUpload = {
  size: number | null;
  metadata: Record<string, string>;
  creationTime: string;
  urlStorageKey: string;
  uploadUrl: string | null;
  parallelUploadUrls: string[] | null;
};

type TusUrlStorage = {
  findAllUploads(): Promise<PreviousTusUpload[]>;
  findUploadsByFingerprint(fingerprint: string): Promise<PreviousTusUpload[]>;
  removeUpload(urlStorageKey: string): Promise<void>;
  addUpload(fingerprint: string, upload: PreviousTusUpload): Promise<string>;
};

const nodeTus = createRequire(import.meta.url)("tus-js-client") as {
  FileUrlStorage: new (filePath: string) => TusUrlStorage;
};

function requireLocalConfiguration(): {
  supabaseUrl: string;
  anonKey: string;
  serviceRoleKey: string;
  endpoint: string;
} {
  const endpoint = supabaseUrl ? getShortsTusEndpoint(supabaseUrl) : null;
  if (!supabaseUrl || !anonKey || !serviceRoleKey || !endpoint) {
    throw new Error(
      "Local Supabase URL and local anon/service keys are required",
    );
  }
  const url = new URL(supabaseUrl);
  if (
    !["localhost", "127.0.0.1", "::1"].includes(url.hostname) ||
    url.port !== "54321"
  ) {
    throw new Error("This smoke test refuses to write outside local Supabase");
  }
  return { supabaseUrl, anonKey, serviceRoleKey, endpoint };
}

function createTusUpload(
  buffer: Buffer,
  config: Parameters<typeof buildShortsTusOptions>[0],
  urlStorage: TusUrlStorage,
  onProgress?: (bytesSent: number) => void,
): Upload {
  const options = {
    ...buildShortsTusOptions(config),
    urlStorage,
    onProgress: (bytesSent) => onProgress?.(bytesSent),
  } as ConstructorParameters<typeof Upload>[1];
  return new Upload(buffer, options);
}

async function waitForUpload(
  upload: Upload,
  timeoutMs = 45_000,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      void upload.abort(true);
      reject(new Error("Local resumable TUS upload timed out"));
    }, timeoutMs);
    upload.options.onError = (error) => {
      clearTimeout(timeout);
      reject(error);
    };
    upload.options.onSuccess = () => {
      clearTimeout(timeout);
      resolve();
    };
    upload.start();
  });
}

async function main(): Promise<void> {
  const local = requireLocalConfiguration();

  const admin = createClient(local.supabaseUrl, local.serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const anonymous = createClient(local.supabaseUrl, local.anonKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const email = `clipsflow-tus-${randomUUID()}@example.invalid`;
  const password = randomBytes(32).toString("base64url");
  let userId: string | null = null;
  let storagePath: string | null = null;
  let urlStorageDirectory: string | null = null;
  let currentUpload: Upload | null = null;
  let completed = false;

  try {
    const { data: createdUser, error: createUserError } =
      await admin.auth.admin.createUser({
        email,
        password,
        email_confirm: true,
      });
    if (createUserError || !createdUser.user) {
      throw new Error("Could not create the temporary local test user");
    }
    userId = createdUser.user.id;

    const { data: login, error: loginError } =
      await anonymous.auth.signInWithPassword({ email, password });
    if (loginError || !login.session?.access_token) {
      throw new Error("Could not authenticate the temporary local test user");
    }

    storagePath = `${userId}/${randomUUID()}-resume-smoke.mp4`;
    urlStorageDirectory = await mkdtemp(
      join(tmpdir(), "clipsflow-tus-resume-"),
    );
    const urlStorage = new nodeTus.FileUrlStorage(
      join(urlStorageDirectory, "uploads.json"),
    );
    const source = Buffer.alloc(SHORTS_TUS_CHUNK_BYTES * 2 + 1024, 0x5a);
    const { data: firstSignedUpload, error: firstTokenError } =
      await admin.storage
        .from(SHORTS_SOURCE_BUCKET)
        .createSignedUploadUrl(storagePath);
    if (firstTokenError || !firstSignedUpload?.token) {
      throw new Error("Could not create the first local Storage upload token");
    }

    const firstConfig = {
      endpoint: local.endpoint,
      bucket: SHORTS_SOURCE_BUCKET,
      storagePath,
      contentType: "video/mp4" as const,
      uploadToken: firstSignedUpload.token,
      accessToken: login.session.access_token,
      apiKey: local.anonKey,
      fingerprint: `local-resume-smoke:${storagePath}`,
    };
    let interrupted = false;
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        void firstUpload.abort(true);
        reject(new Error("TUS did not reach the first resumable chunk"));
      }, 45_000);
      const firstUpload = createTusUpload(
        source,
        firstConfig,
        urlStorage,
        (bytesSent) => {
          if (bytesSent < SHORTS_TUS_CHUNK_BYTES || interrupted) return;
          interrupted = true;
          void firstUpload.abort(false).then(
            () => {
              clearTimeout(timeout);
              resolve();
            },
            (error: unknown) => {
              clearTimeout(timeout);
              reject(error);
            },
          );
        },
      );
      currentUpload = firstUpload;
      firstUpload.options.onError = (error) => {
        if (!interrupted) {
          clearTimeout(timeout);
          reject(error);
        }
      };
      firstUpload.options.onSuccess = () => {
        clearTimeout(timeout);
        reject(
          new Error("The first TUS transfer completed before it was paused"),
        );
      };
      firstUpload.start();
    });

    const { data: refreshedSignedUpload, error: refreshTokenError } =
      await admin.storage
        .from(SHORTS_SOURCE_BUCKET)
        .createSignedUploadUrl(storagePath);
    if (refreshTokenError || !refreshedSignedUpload?.token) {
      throw new Error("Could not reissue a local Storage upload token");
    }

    const resumed = createTusUpload(
      source,
      {
        ...firstConfig,
        uploadToken: refreshedSignedUpload.token,
      },
      urlStorage,
    );
    const previousUploads = await resumed.findPreviousUploads();
    const previous = previousUploads.find(
      (upload) =>
        upload.size === source.length &&
        upload.metadata.bucketName === SHORTS_SOURCE_BUCKET &&
        upload.metadata.objectName === storagePath &&
        Boolean(upload.uploadUrl),
    );
    if (!previous) {
      throw new Error(
        "The browser TUS store did not return the interrupted upload",
      );
    }

    resumed.resumeFromPreviousUpload(previous);
    currentUpload = resumed;
    await waitForUpload(resumed);

    const [ownerFolder, fileName] = storagePath.split("/");
    const { data: objects, error: listError } = await admin.storage
      .from(SHORTS_SOURCE_BUCKET)
      .list(ownerFolder, { limit: 1_000, search: fileName });
    const object = objects?.find((item) => item.name === fileName);
    const size = Number(object?.metadata?.size);
    if (listError || !object || size !== source.length) {
      throw new Error(
        "The resumed TUS upload did not produce the expected object",
      );
    }
    completed = true;
    console.log(
      "Local Supabase TUS resume smoke test passed (interrupted and resumed one 12 MiB + 1 KiB upload).",
    );
  } finally {
    if (currentUpload && !completed) {
      try {
        await currentUpload.abort(true);
      } catch {
        // Cleanup is best-effort after the assertion has already failed.
      }
    }
    if (storagePath) {
      await admin.storage.from(SHORTS_SOURCE_BUCKET).remove([storagePath]);
    }
    if (userId) await admin.auth.admin.deleteUser(userId);
    if (urlStorageDirectory) {
      const root = resolve(tmpdir());
      const target = resolve(urlStorageDirectory);
      const relativeTarget = relative(root, target);
      if (!relativeTarget || relativeTarget.startsWith("..")) {
        throw new Error(
          "Refusing to remove a TUS test path outside the temp directory",
        );
      }
      await rm(target, { recursive: true, force: true });
    }
  }
}

main().catch((error: unknown) => {
  const message =
    error instanceof Error ? error.message : "unknown local test error";
  console.error(`Local Supabase TUS resume smoke test failed: ${message}`);
  process.exitCode = 1;
});
