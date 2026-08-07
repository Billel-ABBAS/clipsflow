import path from "node:path";
import { fileURLToPath } from "node:url";

import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

const rootDir = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "node",
    include: ["src/**/*.test.{ts,tsx}"],
    coverage: {
      provider: "v8",
      include: ["src/lib/clips/**"],
      // Modules exclus du périmètre de coverage unitaire : tous font appel à
      // des I/O lourdes (ffmpeg spawn, Supabase storage download, Groq API,
      // fs.writeFile, sharp). Couverts par le smoke test E2E fondateur
      // (docs/phase-1-smoke-test.md). Les tester en unit nécessiterait des
      // mocks de binaires ou de fichiers tmp — fragilité disproportionnée
      // au bénéfice (faux-positifs si ffmpeg path change en CI).
      exclude: [
        "src/lib/clips/run-job.ts",
        "src/lib/clips/subtitle-burn.ts",
        "src/lib/clips/subtitle-burn-png-overlay.ts",
        "src/lib/clips/render-audiogram.ts",
        "src/lib/clips/watermark.ts",
        "src/lib/clips/smart-crop.ts",
        "src/lib/clips/mp4-probe.ts",
        "src/lib/clips/refresh-urls.ts",
        "src/lib/clips/whisper.ts",
        "src/lib/clips/translate-cues.ts",
        "src/lib/clips/locales.ts",
        "src/lib/clips/types.ts",
      ],
      thresholds: {
        statements: 50,
      },
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(rootDir, "src"),
    },
  },
});
