// Types métiers — miroir du schéma Supabase (supabase/migrations/).
// Régénération automatisée (supabase gen types) prévue quand le projet
// Supabase dev existera ; en attendant, miroir manuel minimal.

export interface Profile {
  id: string;
  email: string | null;
  full_name: string | null;
  locale: string;
  // Colonnes quota clips (migration 0002_clips_schema.sql).
  clip_seconds_used_this_month: number;
  clip_quota_reset_at: string | null;
  created_at: string;
  updated_at: string;
}
