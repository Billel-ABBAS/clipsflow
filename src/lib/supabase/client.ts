import { createBrowserClient } from "@supabase/ssr";

// Placeholders : le projet Supabase n'existe pas encore (créé hors Phase 0).
// Permet à `next build` de passer sans env vars — même pattern que VidiaFlow.
const supabaseUrl =
  process.env.NEXT_PUBLIC_SUPABASE_URL ?? "https://placeholder.supabase.co";
const supabaseAnonKey =
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "public-anon-key-placeholder";

export function createClient() {
  return createBrowserClient(supabaseUrl, supabaseAnonKey);
}
