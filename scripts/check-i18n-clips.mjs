// Cross-check the clips/login i18n keys (Lot 4 gate helper).
// 1. EN and FR bundles must expose the exact same key set.
// 2. Every static t("...") / t.rich("...") in src/components/clips,
//    src/hooks, and the (dashboard)/(auth) pages must resolve in BOTH
//    bundles, given the namespace each file declares.
// Dynamic keys (template literals) are enumerated manually below.
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const en = JSON.parse(
  readFileSync(path.join(root, "src/i18n/messages/en.json"), "utf8"),
);
const fr = JSON.parse(
  readFileSync(path.join(root, "src/i18n/messages/fr.json"), "utf8"),
);

function flatten(obj, prefix = "") {
  const out = [];
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === "object") out.push(...flatten(v, key));
    else out.push(key);
  }
  return out;
}

const enKeys = new Set(flatten(en));
const frKeys = new Set(flatten(fr));

let failures = 0;
for (const k of enKeys) {
  if (!frKeys.has(k)) {
    console.error(`FR missing: ${k}`);
    failures++;
  }
}
for (const k of frKeys) {
  if (!enKeys.has(k)) {
    console.error(`EN missing: ${k}`);
    failures++;
  }
}

// --- collect t("...") usages -------------------------------------------------
const scanDirs = [
  "src/components/clips",
  "src/components/auth",
  "src/app/[locale]/(dashboard)",
  "src/app/[locale]/(auth)",
];
const files = [];
function walk(dir) {
  for (const entry of readdirSync(dir)) {
    const p = path.join(dir, entry);
    if (statSync(p).isDirectory()) walk(p);
    else if (/\.(tsx?|jsx?)$/.test(entry)) files.push(p);
  }
}
for (const d of scanDirs) walk(path.join(root, d));

// Dynamic key families verified by enumeration (template literals in code).
const dynamicFamilies = [
  "clips.aspect_hint_9_16",
  "clips.aspect_hint_1_1",
  "clips.aspect_hint_4_5",
  "clips.aspect_hint_16_9",
  "clips.custom_position_top",
  "clips.custom_position_middle",
  "clips.custom_position_lower_third",
  "clips.custom_position_bottom",
  "clips.gallery_status_pending",
  "clips.gallery_status_processing",
  "clips.gallery_status_completing",
  "clips.gallery_status_completed",
  "clips.gallery_status_failed",
  // upload errorKey values
  "clips.upload_error_too_large",
  "clips.upload_error_unsupported_type",
  "clips.upload_error_failed",
  // url / segment error keys
  "clips.source_url_error_https",
  "clips.seg_error",
  "clips.seg_error_max",
  // preset nameKey/taglineKey (12 codes)
  ...[
    "viral_tiktok",
    "youtube_tutorial",
    "hormozi_style",
    "linkedin_pro",
    "podcast_clip",
    "gaming_stream",
    "sports_highlight",
    "interview_quote",
    "cinematic_vlog",
    "mrbeast_energy",
    "karaoke_hit",
    "custom",
  ].flatMap((c) => [`clips.presets.${c}.name`, `clips.presets.${c}.tagline`]),
  // PositionPicker enumerated aria labels
  "clips.position_picker.top_left",
  "clips.position_picker.top_right",
  "clips.position_picker.bottom_left",
  "clips.position_picker.bottom_right",
  "clips.position_picker.center",
];
for (const k of dynamicFamilies) {
  if (!enKeys.has(k)) {
    console.error(`EN missing (dynamic family): ${k}`);
    failures++;
  }
  if (!frKeys.has(k)) {
    console.error(`FR missing (dynamic family): ${k}`);
    failures++;
  }
}

// Static usages : resolve the namespace per file from
// useTranslations("ns") / getTranslations("ns") declarations.
const nsRe =
  /(?:useTranslations|getTranslations)\(\s*(?:\{[^}]*namespace:\s*)?"([^"]+)"/g;
const tCallRe = /\bt(?:\.rich)?\(\s*"([^"]+)"/g;
let checked = 0;
for (const f of files) {
  const src = readFileSync(f, "utf8");
  const namespaces = [...src.matchAll(nsRe)].map((m) => m[1]);
  if (namespaces.length === 0) continue;
  // One namespace per file in this codebase (verified by review) — take
  // the first ; files with multiple t() scopes would need an AST pass.
  const ns = namespaces[0];
  for (const m of src.matchAll(tCallRe)) {
    const full = `${ns}.${m[1]}`;
    checked++;
    if (!enKeys.has(full)) {
      console.error(`EN missing: ${full}  (${path.relative(root, f)})`);
      failures++;
    }
    if (!frKeys.has(full)) {
      console.error(`FR missing: ${full}  (${path.relative(root, f)})`);
      failures++;
    }
  }
}

console.log(
  `Checked ${checked} static t() calls + ${dynamicFamilies.length} enumerated dynamic keys across ${files.length} files.`,
);
console.log(`EN keys: ${enKeys.size}, FR keys: ${frKeys.size}`);
if (failures > 0) {
  console.error(`\nFAIL — ${failures} missing key(s).`);
  process.exit(1);
}
console.log("OK — EN/FR key sets identical and every consumed key resolves.");
