import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    ".next-clipsflow-local-smoke/**",
    "out/**",
    "build/**",
    ".worktrees/**",
    ".tmp-staging-render-test*/**",
    "next-env.d.ts",
    // Artefacts de coverage (déjà dans .prettierignore) :
    "coverage/**",
    // Runtime local Supabase/Docker généré par `supabase start` :
    "supabase/.temp/**",
  ]),
]);

export default eslintConfig;
