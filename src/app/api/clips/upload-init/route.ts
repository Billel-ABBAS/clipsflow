// ============================================================================
// ClipsFlow Clips — POST /api/clips/upload-init (signed upload + episode stub)
// ============================================================================
// Retourne une signed upload URL Supabase pour le PUT direct client-side du
// média source (bucket `clip-sources`), et crée la row `episodes` stub
// (source_type 'upload') que POST /api/clips/jobs référencera ensuite via
// episode_id.
//
// Porté de VidiaFlow /api/clipflow/sources/upload-init. Adaptations :
//   - MIME élargi aux 7 types du bucket clip-sources (audio podcast inclus)
//   - création de la row episodes ici (VidiaFlow n'avait pas d'entité
//     épisode — le path brut repartait au client)
//   - signed URL mintée via service_role (spec Lot 3 ; la source utilisait
//     le client cookie)
//
// NOTE magic-bytes : la vérification du contenu réel NE PEUT PAS se faire
// ici — le fichier n'est pas encore uploadé au moment de ce POST. Elle est
// faite par le pipeline render (run-job.ts, étape 2.5 : sniff 16 octets
// après download, throw `invalid_source_file:` si le contenu ne matche pas
// une famille média supportée).
//
// Status codes : 200 / 400 / 401 / 403 / 500.
// ============================================================================

import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { isClipsEnabled } from "@/lib/clips/feature-flag";
import { sanitizeFilename } from "@/lib/utils/storage-path";
import { routing } from "@/i18n/routing";

export const runtime = "nodejs";
export const maxDuration = 30;

const BUCKET = "clip-sources";

// Les 7 MIME types autorisés par le bucket clip-sources (migration
// 0002_clips_schema.sql, allowed_mime_types). Garder les deux listes en sync.
const ALLOWED_MIME_TYPES = [
  "video/mp4",
  "video/quicktime",
  "video/webm",
  "audio/mpeg",
  "audio/mp4",
  "audio/x-m4a",
  "audio/wav",
] as const;

const bodySchema = z.strictObject({
  file_name: z.string().min(1).max(180),
  mime: z.enum(ALLOWED_MIME_TYPES),
  title: z.string().min(1).max(200),
});

export async function POST(request: Request): Promise<Response> {
  // 1. Cookie auth.
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  // 2. Feature flag (miroir /api/clips/jobs).
  const cookieStore = await cookies();
  const locale = cookieStore.get("NEXT_LOCALE")?.value ?? routing.defaultLocale;
  if (
    // Wrapper env (défaut dev = all quand CLIPS_ENABLED est vide) — review L3 E1.
    !isClipsEnabled({ locale, userId: user.id })
  ) {
    return NextResponse.json({ error: "not_yet_available" }, { status: 403 });
  }

  // 3. Parse + validation.
  let parsed;
  try {
    const body = await request.json();
    parsed = bodySchema.safeParse(body);
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  if (!parsed.success) {
    return NextResponse.json(
      { error: "validation_error", issues: parsed.error.issues },
      { status: 400 },
    );
  }
  // `mime` est validé par le schema (rejet hors liste bucket) mais pas
  // consommé ici : le client le pose sur son PUT et le bucket
  // `allowed_mime_types` l'enforce à l'upload.
  const { file_name, title } = parsed.data;

  // 4. Path scopé user : strip des séparateurs de chemin + caractères
  // dangereux (audit VidiaFlow H5 : `..` survivait au sanitize regex-only),
  // UUID préfixé pour l'unicité.
  const safeName = sanitizeFilename(file_name);
  const path = `${user.id}/${randomUUID()}-${safeName}`;

  // 5. Signed upload URL (client service_role — spec Lot 3).
  const admin = createAdminClient();
  const { data: uploadData, error: uploadErr } = await admin.storage
    .from(BUCKET)
    .createSignedUploadUrl(path);
  if (uploadErr || !uploadData) {
    console.error(
      JSON.stringify({
        level: "error",
        source: "api-clips-upload-init",
        message: "createSignedUploadUrl failed",
        error: uploadErr?.message?.slice(0, 300),
      }),
    );
    return NextResponse.json(
      { error: "signed_upload_url_failed" },
      { status: 500 },
    );
  }

  // 6. Row episodes stub via service_role. Authenticated browser sessions
  // have no direct INSERT privilege on lifecycle tables.
  // le render signe une read URL sur source_storage_path au claim ; si le
  // PUT client n'a jamais eu lieu, le job échoue proprement en
  // `source_download_failed:` (refundé).
  const { data: episode, error: epErr } = await admin
    .from("episodes")
    .insert({
      user_id: user.id,
      title,
      source_type: "upload",
      source_url: null,
      source_storage_path: path,
      status: "ready",
    })
    .select("id")
    .single();
  if (epErr || !episode) {
    console.error(
      JSON.stringify({
        level: "error",
        source: "api-clips-upload-init",
        message: "episodes insert failed",
        error: epErr?.message?.slice(0, 300),
      }),
    );
    return NextResponse.json(
      { error: "episode_create_failed" },
      { status: 500 },
    );
  }

  // 7. 200 — le client PUT le fichier sur upload_url (ou via
  // uploadToSignedUrl(path, token, file)), puis POST /api/clips/jobs avec
  // episode_id.
  return NextResponse.json({
    data: {
      episode_id: episode.id as string,
      upload_url: uploadData.signedUrl,
      token: uploadData.token,
      storage_path: path,
    },
  });
}
