# ClipsFlow

**Turn a 20-minute to 2-hour video or podcast into publish-ready Shorts.**

ClipsFlow is a B2C SaaS for finding and producing short-form video from long recordings. It transcribes the full source, analyzes audio or audio + video, suggests strong standalone moments using the creator's instructions, then renders selected clips with synchronized subtitles, adapted music and motion design. Creators can download MP4/VTT files individually or as a ZIP and publish to a connected YouTube account after reviewing and confirming the final upload.

## What it does

- **Long-form source**: resumable upload for video or podcast sources from 20 minutes to 2 hours (8 GiB application cap; production requires Supabase Pro or higher, a global Storage limit of at least 8 GiB, and matching worker disk capacity)
- **AI analysis**: complete transcription, audio-only or audio + video analysis, plus creator instructions to guide candidate selection
- **Shorts Studio**: review and select suggested moments, or let the system choose them, then submit selected moments for rendering
- **12 presets** tuned per platform (Viral TikTok, Hormozi Style, LinkedIn Pro, MrBeast Energy, Karaoke Hit…)
- **Word-by-word animated captions**: 15 styles, custom colors / fonts / position, emphasis cycle
- **Overlays**: title card, speaker banner, stat callout, CTA outro
- **Smart crop**: saliency-based reframing to 9:16 / 1:1 / 4:5 / 16:9
- **Rendering**: separate queued worker → Whisper/Groq or OpenAI transcription → FFmpeg subtitle burn, crop and motion overlays → private gallery
- **Sound and motion**: deterministic motion templates remain available; Opus 5.5 creative direction is fail-closed until Anthropic confirms its exact API model ID (no Opus 5 substitution); ElevenLabs creates instrumental music/SFX only after separate consent, licensing, and budget approval
- **YouTube**: OAuth connection and resumable publication queue; uploads require creator confirmation and default to private visibility
- **Existing Clips Studio**: retained as a separate short-segment workflow while the long-form Shorts flow matures
- **Free-tier watermark**, per-plan quota (seconds of render/month)

## Stack

Next.js App Router · React · TypeScript strict · Tailwind · Supabase · Railway workers · Vercel · Sentry · next-intl (en/fr) · FFmpeg · Whisper/Groq or OpenAI · configurable visual analysis · ElevenLabs · Jev/TypeSafe shadow ranking

## Getting started

```bash
pnpm install
cp .env.example .env.local   # fill in keys (never commit)
pnpm dev                     # http://localhost:3000
```

Quality gates:

```bash
pnpm typecheck && pnpm test && pnpm exec eslint src && pnpm build
```

## Repository map

| Path                     | Purpose                                                    |
| ------------------------ | ---------------------------------------------------------- |
| `src/app/[locale]/`      | Localized App Router pages (en/fr)                         |
| `src/app/api/clips/`     | Clips API (jobs, transcribe, upload-init)                  |
| `src/app/api/shorts/`    | Long-form uploads, analysis projects and render submission |
| `src/app/api/youtube/`   | YouTube OAuth, connection and confirmed publication API    |
| `src/app/api/cron/`      | Drain worker (process-clips)                               |
| `src/components/clips/`  | Studio wizard, gallery, presets, overlays UI               |
| `src/components/shorts/` | Long-form Shorts selection and production Studio           |
| `src/lib/clips/`         | Render pipeline (whisper, translate, burn, crop, overlays) |
| `src/lib/shorts/`        | Source upload, full analysis, candidates and Jev ranking   |
| `src/lib/youtube/`       | OAuth vault, YouTube API and publication worker            |
| `src/lib/supabase/`      | Browser/server/proxy Supabase clients                      |
| `supabase/migrations/`   | SQL migrations                                             |
| `docs/`                  | Architecture, roadmap, extraction map, phase reports       |

## Status

The long-form Shorts flow is implemented in the local codebase, alongside the existing Clips workflow. Local tests and a build are not evidence that separate analysis/publication workers or Supabase migrations are deployed: see [the roadmap](docs/ROADMAP.md) and [worker setup and validation requirements](docs/RAILWAY_CLIPS_WORKER.md) before treating the journey as production-ready.
