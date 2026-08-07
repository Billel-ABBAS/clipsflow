// ============================================================================
// ClipsFlow Clips — subtitle target-language options (UI dropdown)
// ============================================================================
// 30-language list matching the Submagic / Opus Clip surface. Labels use
// ENDONYMS (each language's own self-name) so the dropdown works for users
// on every locale without a translation step — pattern used by Google
// Translate, Notion, Linear, etc. A Japanese user sees "日本語" not
// "Japonais" ; an Arabic user sees "العربية" not "Arabe".
//
// Whisper auto-detects the SOURCE language ; this code is the TARGET
// language for caption rendering (translate-cues.ts handles the hop).
//
// Ported from VidiaFlow src/components/clipflow/SubtitleStudio.tsx
// (inline LOCALES_OPTIONS const) — externalised to a lib module so the
// list is importable without pulling the whole studio component.
// ============================================================================

export interface LocaleOption {
  value: string;
  label: string;
}

export const LOCALES_OPTIONS: LocaleOption[] = [
  { value: "fr", label: "Français" },
  { value: "en", label: "English" },
  { value: "es", label: "Español" },
  { value: "de", label: "Deutsch" },
  { value: "ar", label: "العربية" },
  { value: "pt-BR", label: "Português (BR)" },
  { value: "it", label: "Italiano" },
  { value: "nl", label: "Nederlands" },
  { value: "tr", label: "Türkçe" },
  { value: "ja", label: "日本語" },
  { value: "ko", label: "한국어" },
  { value: "zh-CN", label: "中文 (简体)" },
  { value: "ru", label: "Русский" },
  { value: "hi", label: "हिन्दी" },
  { value: "pl", label: "Polski" },
  { value: "ro", label: "Română" },
  { value: "sv", label: "Svenska" },
  { value: "cs", label: "Čeština" },
  { value: "el", label: "Ελληνικά" },
  { value: "hu", label: "Magyar" },
  { value: "fi", label: "Suomi" },
  { value: "da", label: "Dansk" },
  { value: "no", label: "Norsk" },
  { value: "he", label: "עברית" },
  { value: "th", label: "ไทย" },
  { value: "vi", label: "Tiếng Việt" },
  { value: "id", label: "Bahasa Indonesia" },
  { value: "ms", label: "Bahasa Melayu" },
  { value: "sw", label: "Kiswahili" },
  { value: "uk", label: "Українська" },
];
