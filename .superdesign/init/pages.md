# Key page dependency tree

## `/[locale]/shorts-preview` — selected-excerpt read-only Studio

Entry: `src/app/[locale]/shorts-preview/page.tsx`

Dependencies (all local imports recursively traced; package imports omitted):

- `src/app/[locale]/shorts-preview/page.tsx`
  - `src/components/shorts/ShortsStudio.tsx`
    - `src/components/shorts/ShortsStudio.module.css`
    - `src/components/shorts/studio-presentation.ts`
      - type-only cycle back to `ShortsStudio.tsx`
    - `src/lib/utils.ts` → external `clsx`, `tailwind-merge`
    - `src/lib/supabase/client.ts` → external `@supabase/ssr`
    - `src/lib/shorts/source-upload.ts` → external `zod`
    - `src/lib/shorts/source-upload-resume.ts` → external `zod`
    - `src/lib/shorts/project-contract.ts` → external `zod`
    - `src/lib/shorts/project-idempotency.ts` (no local imports)
    - `src/lib/shorts/source-media-duration.ts` (no local imports)
    - `src/lib/clips/creative-director-model.ts` (no local imports)
    - `src/lib/shorts/provider-capabilities.ts`
      - `src/lib/clips/creative-director-model.ts`
      - `src/lib/clips/elevenlabs.ts` (no local imports)
- `src/app/[locale]/layout.tsx`
  - `src/app/globals.css`
  - `src/i18n/routing.ts` → external `next-intl/routing`
- `src/app/layout.tsx`

The rendered target is the default ready/selected state: topbar; source metadata and five-step rail; central analysis summary, candidate filters/cards, selected-candidate transcript/timeline and waveform; right 9:16 preview and production options. `?state=empty` is an alternate intake state, not the screenshot target. The preview is read-only and uses existing Canva-approved reference crops; do not generate or substitute imagery.
