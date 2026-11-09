# Open Audio — migration candidate, not production activation

## Scope and choice

Replace the two currently implemented ElevenLabs capabilities, not the whole ElevenLabs product: instrumental music and short nonverbal transition accents. Voice cloning/narration remain disabled and original speech stays unchanged.

- Music: self-hosted ACE-Step 1.5, `acestep-v15-turbo`, native async HTTP API.
- Motion accents: local FFmpeg DSP presets (whoosh, pop/click, impact/thud). These are not a universal text-to-SFX AI model.
- No ElevenLabs endpoint, key or paid fallback in the replacement execution path.

VoiceStudio is a desktop voice studio, not the required instrumental/SFX backend. Non-commercial audio models were not selected for this SaaS. A licensed audio catalogue is another valid approach, but does not generate custom music.

## Implementation

`open-audio.ts` implements bounded submit/poll/download calls. `open-audio-dsp.ts` synthesizes accents and normalizes/trims music to MP3. `elevenlabs.ts` keeps old export names and error codes solely for API/job compatibility. The `elevenLabs` capability and persisted `elevenlabs` profile names also remain compatibility fields, not paid-provider calls.

The new storage provider is `open-audio`; model-qualified filenames avoid confusing historical provider assets with newly generated music. Existing audio and permissions are not rewritten. New asset credits are recorded as zero; this does not mean GPU/electricity/hosting costs are zero.

## Activation checklist — do not deploy the partial PRs separately

1. Review the three stacked PRs, run `pnpm test`, `pnpm typecheck`, `pnpm lint`, `pnpm build`, `pnpm smoke:shorts:docker`, repository Prettier and ggshield checks on their combined tip.
2. Update older synthetic smoke fixtures that still insert `provider: "elevenlabs"` to `open-audio` and use the new model-qualified cache paths. Do not relabel real historic audio.
3. Validate the additive provider-constraint migration on ephemeral/staging Postgres, then apply it through the normal release procedure. It has NOT been applied in production.
4. Install a pinned ACE-Step release and model weights on a suitable host; record its commit/model revision and retain the MIT notice. Start its native API with authentication and HTTPS termination. Do not expose an unauthenticated model server.
5. Copy `.env.open-audio.example` values into the web service and rendering worker through their secret managers. Use `CLIPS_OPEN_AUDIO_COMPUTE_AUTHORIZED=true` only after explicitly accepting that host's compute cost, then `CLIPS_OPEN_AUDIO_ENABLED=true`. Configure `ACESTEP_API_KEY` on the model host to the same private token. No secret belongs in Git or client code.
6. Check `/health` and `/v1/models`, then run authorized instrumental samples and a full Short in staging. Compare quality, absence of unintended vocals, exact duration, foreground-speech audibility, concurrency and render latency. Model inference and GPU benchmarks have NOT been run in this intervention.
7. Update UI consent labels that still say ElevenLabs, then coordinate web/worker release. Remove obsolete provider secrets only after cutover. Existing unrelated AI providers remain unchanged.

Railway cannot call the localhost of a home PC. A local installation needs an authenticated reachable endpoint and a running machine; otherwise use a separate GPU host. No GPU/cloud resource was provisioned and no billing plan was changed.

## Limits and operational checks

Music request duration is 3–180 seconds. ACE-Step receives at least 10 seconds and FFmpeg trims to the selected Short. One sample only, 120-second HTTP deadline, 60 polls maximum. A slow/queued host fails instead of falling back to a commercial API. Confirm these limits against real hardware before rollout. Task IDs are not yet persisted across worker process restarts; reconcile timed-out tasks before manual retry to avoid duplicate compute.

Accents are 0.5–3 seconds and CPU-only. Cache identity includes provider/model/prompt within an owned candidate, not the audio duration; an edited candidate needs cache invalidation. A successful configuration check is not proof of a healthy remote service. Instrumental prompting is not a mathematical guarantee of no vocals: listening checks remain required.

The default FFmpeg binary comes from the existing project dependency; retain its distribution/license obligations. This work does not add model-service downloads to Vercel or the existing CPU worker.

## Evidence and references

The core PR passed the existing full GitHub CI (tests, types, lint, production build, Shorts Docker E2E). Fifteen targeted tests passed locally with native Node test execution, including real FFmpeg MP3 generation and simulated ACE-Step calls. This evidence does not validate the combined migration or real GPU inference; inspect the final PR's CI separately.

- https://github.com/ace-step/ACE-Step-1.5
- https://github.com/ace-step/ACE-Step-1.5/blob/main/LICENSE
- https://huggingface.co/ACE-Step/acestep-v15-turbo
- https://github.com/ace-step/ACE-Step-1.5/blob/main/docs/en/API.md
- https://ffmpeg.org/ffmpeg-filters.html
