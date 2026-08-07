// ============================================================================
// ClipsFlow — storage filename sanitizer
// ============================================================================
// Porté de VidiaFlow src/lib/utils/storage-path.ts (sanitizeFilename
// uniquement — audit H5 2026-05-13 : un sanitize regex-only laissait passer
// `..` parce que `.` et `_` étaient tous deux autorisés). Les helpers
// validateStoragePath / isOwnedStoragePath du fichier source ne sont pas
// portés en P1 : aucune route ClipsFlow n'accepte de storage path côté client
// (les chemins sont construits serveur-side).
// ============================================================================

/**
 * Réduit un nom de fichier client à un filename sûr : remplace tout ce qui
 * n'est pas ASCII alphanumérique / point / underscore / tiret, rejette `..`,
 * cap la longueur. À utiliser pour le segment *terminal* d'un chemin
 * construit serveur-side :
 *
 *   `${userId}/${randomUUID()}-${sanitizeFilename(input)}`
 */
export function sanitizeFilename(name: string): string {
  if (typeof name !== "string" || name.length === 0) return "file";
  // Remplace tout caractère hors [a-zA-Z0-9._-] par `_` (couvre les
  // séparateurs de chemin `/` et `\`, les null bytes, l'unicode exotique).
  const cleaned = name.replace(/[^a-zA-Z0-9._-]/g, "_");
  // Rejette `..` (et `.` seul — même risque côté Windows).
  if (cleaned === "." || cleaned === ".." || cleaned.includes("..")) {
    return "file";
  }
  // Cap la longueur pour garder le chemin final sous la limite Supabase
  // de 1024 caractères par clé d'objet.
  return cleaned.slice(0, 200);
}
