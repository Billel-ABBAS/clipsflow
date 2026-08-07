# ClipsFlow

**Turn any episode or video into ready-to-post subtitled clips.**

ClipsFlow is a B2C SaaS that cuts long-form audio/video into viral Shorts, Reels and TikTok clips — burned-in animated subtitles in 15 styles, vertical/square/landscape formats, direct MP4 + VTT download. No editing app, no timeline, no freelance editor.

## What it does

- **Source**: upload a file (≤ 500 MB), paste a direct HTTPS URL, or reuse an existing episode
- **Studio 4 steps**: source → segment → subtitle style → customization & overlays
- **12 presets** tuned per platform (Viral TikTok, Hormozi Style, LinkedIn Pro, MrBeast Energy, Karaoke Hit…)
- **Word-by-word animated captions**: 15 styles, custom colors / fonts / position, emphasis cycle
- **Overlays**: title card, speaker banner, stat callout, CTA outro
- **Smart crop**: saliency-based reframing to 9:16 / 1:1 / 4:5 / 16:9
- **Pipeline**: Whisper transcription → Claude cue translation → ffmpeg burn → realtime gallery
- **Free-tier watermark**, per-plan quota (seconds of render/month)

## Stack

Next.js 16.2 (App Router) · React 19 · TypeScript strict · Tailwind v4 · shadcn/ui v4 · Supabase (eu-west) · Vercel · Sentry · next-intl (en/fr) · ffmpeg · Whisper · Claude

## Getting started

```bash
pnpm install
cp .env.example .env.local   # fill in keys (never commit)
pnpm dev                     # http://localhost:3000
```

Quality gates:

```bash
pnpm typecheck && pnpm lint && pnpm test && pnpm build
```

## Repository map

| Path                        | Purpose                                                     |
| --------------------------- | ----------------------------------------------------------- |
| `src/app/[locale]/`         | Localized App Router pages (en/fr)                          |
| `src/app/api/clips/`        | Clips API (jobs, transcribe, upload-init)                   |
| `src/app/api/cron/`         | Drain worker (process-clips)                                 |
| `src/components/clips/`     | Studio wizard, gallery, presets, overlays UI                |
| `src/lib/clips/`            | Render pipeline (whisper, translate, burn, crop, overlays)  |
| `src/lib/supabase/`         | Browser/server/proxy Supabase clients                       |
| `supabase/migrations/`      | SQL migrations                                              |
| `docs/`                     | Architecture, roadmap, extraction map, phase reports        |

## Status

Clips-only product extracted from the ClipFlow module. Phase 1 (clips port) delivered on the render pipeline: upload/URL → Whisper → ffmpeg burn → realtime gallery, Studio 4 steps, quota RPC, cron worker.
