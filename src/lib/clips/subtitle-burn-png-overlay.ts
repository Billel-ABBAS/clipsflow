// ============================================================================
// ClipsFlow Clips — PNG overlay subtitle burn (CPU-only spike)
// ============================================================================
// Two-pass pipeline that splits libass rasterisation off the x264 hot loop :
//
//   PASS 1 — Subtitle raster
//     Render the libass output into a transparent PNG sequence at 30 fps.
//     No x264 encode. The frames sit on /tmp as `frame_%05d.png` files.
//     Source : a transparent canvas (`color=black@0:size=W×H:rate=30`)
//     so libass has SOMETHING to overlay on without the cost of decoding
//     the actual mp4.
//
//   PASS 2 — Composite + encode
//     ffmpeg overlays the PNG sequence on the real source via the
//     `overlay` filter, then libx264 ultrafast encodes. NO libass in this
//     pass. The PNG alpha composite is essentially memcpy.
//
// Hypothesis : pass 1 + pass 2 < single-pass libass-during-encode.
//
// Risk : 2-pass disk IO on serverless `/tmp` can REGRESS on slower lambdas
// if the PNG sequence is large. The feature flag `CLIPS_BURN_PNG_OVERLAY=1`
// (read by run-job.ts — OFF by default) ships the path opt-in so the
// founder can A/B test before flipping the default.
//
// Public API mirrors `burnSubtitles()` so the call site in `run-job.ts`
// can swap one for the other based on the env flag with no other changes.
//
// Ported from VidiaFlow src/lib/clipflow/subtitle-burn-png-overlay.ts.
// Surgical removals vs source (mirroring subtitle-burn.ts) :
//   - brand-font support (was already unsupported on this path — the
//     params field itself is gone from BurnSubtitlesParams)
//   - resolution tiers (aspectFilterFor signature is mono-1080p)
//   - fonts staged from `fonts/` at the project root (was public/fonts)
// Style preset table kept byte-for-byte in sync with the inline table in
// `subtitle-burn.ts` — drift between the two is a visual regression.
// ============================================================================

import ffmpegPath from "@ffmpeg-installer/ffmpeg";
import { spawn } from "node:child_process";
import { readdirSync } from "node:fs";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  STYLE_CRF_MAP,
  aspectFilterFor,
  buildVttFromCues,
} from "./subtitle-burn";
import type { BurnSubtitlesParams, BurnSubtitlesResult } from "./subtitle-burn";
import { hexToAss, detectScriptFont, assTime } from "./ass-format";
import { ASPECT_RATIO_DIMENSIONS } from "./types";
import type { StyleKey } from "./types";

// ---------------------------------------------------------------------------
// Style preset table (mirrors the inline table in subtitle-burn.ts)
// ---------------------------------------------------------------------------
// Kept private to this module. The values MUST stay byte-for-byte identical
// to the inline table in `subtitle-burn.ts > burnSubtitles` so the rendered
// captions look the same regardless of which path the founder flips to.
// If a preset changes, update both tables in lockstep.
type StylePreset = {
  defaultFont: string;
  fontsize: number;
  bold: 0 | -1;
  outlineWidth: number;
  shadowDepth: number;
  marginV: number;
  defaultSecondary: string;
  popInScale: number;
  popInMs: number;
  textCase: "upper" | "lower" | "natural";
  wordsPerCue: number;
  borderStyle: 1 | 3 | 4;
  inlineOverrides?: string;
};

const STYLE_PRESETS: Record<StyleKey, StylePreset> = {
  viral: {
    defaultFont: "Inter",
    fontsize: 80,
    bold: -1,
    outlineWidth: 4,
    shadowDepth: 2,
    marginV: 120,
    defaultSecondary: "#FFD700",
    popInScale: 80,
    popInMs: 200,
    textCase: "upper",
    wordsPerCue: 3,
    borderStyle: 1,
  },
  premium: {
    defaultFont: "Plus Jakarta Sans",
    fontsize: 56,
    bold: 0,
    outlineWidth: 2,
    shadowDepth: 1,
    marginV: 100,
    defaultSecondary: "#FFFFFF",
    popInScale: 90,
    popInMs: 250,
    textCase: "natural",
    wordsPerCue: 5,
    borderStyle: 1,
  },
  hormozi: {
    defaultFont: "Bebas Neue",
    fontsize: 96,
    bold: -1,
    outlineWidth: 5,
    shadowDepth: 2,
    marginV: 110,
    defaultSecondary: "#FFD700",
    popInScale: 75,
    popInMs: 200,
    textCase: "upper",
    wordsPerCue: 3,
    borderStyle: 1,
  },
  mrbeast: {
    defaultFont: "Montserrat Black",
    fontsize: 88,
    bold: -1,
    outlineWidth: 8,
    shadowDepth: 3,
    marginV: 120,
    defaultSecondary: "#34C759",
    popInScale: 70,
    popInMs: 180,
    textCase: "upper",
    wordsPerCue: 2,
    borderStyle: 1,
  },
  iman: {
    defaultFont: "Plus Jakarta Sans",
    fontsize: 64,
    bold: 0,
    outlineWidth: 0,
    shadowDepth: 1,
    marginV: 100,
    defaultSecondary: "#FFFFFF",
    popInScale: 100,
    popInMs: 0,
    textCase: "lower",
    wordsPerCue: 5,
    borderStyle: 1,
  },
  minimal: {
    defaultFont: "Inter",
    fontsize: 48,
    bold: 0,
    outlineWidth: 1,
    shadowDepth: 1,
    marginV: 90,
    defaultSecondary: "#FFFFFF",
    popInScale: 100,
    popInMs: 0,
    textCase: "natural",
    wordsPerCue: 6,
    borderStyle: 1,
  },
  neon: {
    defaultFont: "Inter",
    fontsize: 84,
    bold: -1,
    outlineWidth: 6,
    shadowDepth: 4,
    marginV: 120,
    defaultSecondary: "#FF00FF",
    popInScale: 90,
    popInMs: 200,
    textCase: "upper",
    wordsPerCue: 3,
    borderStyle: 1,
    inlineOverrides:
      "\\t(0,500,\\3a&H00&)\\t(500,1000,\\3a&H80&)\\t(1000,1500,\\3a&H00&)\\shad8",
  },
  typewriter: {
    defaultFont: "Inter",
    fontsize: 64,
    bold: 0,
    outlineWidth: 2,
    shadowDepth: 0,
    marginV: 110,
    defaultSecondary: "#FFFFFF",
    popInScale: 100,
    popInMs: 0,
    textCase: "upper",
    wordsPerCue: 4,
    borderStyle: 1,
  },
  bounce: {
    defaultFont: "Montserrat Black",
    fontsize: 90,
    bold: -1,
    outlineWidth: 5,
    shadowDepth: 2,
    marginV: 120,
    defaultSecondary: "#FFD700",
    popInScale: 50,
    popInMs: 250,
    textCase: "upper",
    wordsPerCue: 2,
    borderStyle: 1,
  },
  bar: {
    defaultFont: "Inter",
    fontsize: 56,
    bold: 0,
    outlineWidth: 0,
    shadowDepth: 0,
    marginV: 100,
    defaultSecondary: "#FFFFFF",
    popInScale: 100,
    popInMs: 0,
    textCase: "natural",
    wordsPerCue: 5,
    borderStyle: 4,
  },
  cinematic: {
    defaultFont: "DM Serif Display",
    fontsize: 56,
    bold: 0,
    outlineWidth: 1,
    shadowDepth: 1,
    marginV: 130,
    defaultSecondary: "#FFFFFF",
    popInScale: 100,
    popInMs: 0,
    textCase: "natural",
    wordsPerCue: 5,
    borderStyle: 1,
  },
  // Wave 3 mirrors of subtitle-burn.ts entries (the PNG overlay spike
  // path keeps a separate specs table — kept in sync at insert time).
  karaoke_pop: {
    defaultFont: "Inter Bold",
    fontsize: 80,
    bold: -1,
    outlineWidth: 6,
    shadowDepth: 4,
    marginV: 100,
    defaultSecondary: "#FFE600",
    popInScale: 92,
    popInMs: 160,
    textCase: "upper",
    wordsPerCue: 3,
    borderStyle: 1,
  },
  halo_glow: {
    defaultFont: "Plus Jakarta Sans Medium",
    fontsize: 64,
    bold: 0,
    outlineWidth: 0,
    shadowDepth: 8,
    marginV: 0,
    defaultSecondary: "#FFC88C",
    popInScale: 100,
    popInMs: 0,
    textCase: "natural",
    wordsPerCue: 4,
    borderStyle: 1,
  },
  trailer_inferno: {
    defaultFont: "Anton",
    fontsize: 88,
    bold: -1,
    outlineWidth: 4,
    shadowDepth: 6,
    marginV: 100,
    defaultSecondary: "#FF3B00",
    popInScale: 115,
    popInMs: 200,
    textCase: "upper",
    wordsPerCue: 3,
    borderStyle: 1,
  },
  comic_bubble: {
    defaultFont: "Poppins",
    fontsize: 64,
    bold: -1,
    outlineWidth: 0,
    shadowDepth: 0,
    marginV: 80,
    defaultSecondary: "#FF2D55",
    popInScale: 85,
    popInMs: 180,
    textCase: "natural",
    wordsPerCue: 4,
    borderStyle: 3,
  },
};

// ---------------------------------------------------------------------------
// ASS escape helper (private — mirrors subtitle-burn.ts / ass-format.ts)
// ---------------------------------------------------------------------------
function escapeAss(s: string): string {
  return s
    .replace(/\r/g, "")
    .replace(/\{/g, "\\{")
    .replace(/\}/g, "\\}")
    .replace(/\n/g, "\\N");
}

// ---------------------------------------------------------------------------
// ffmpeg arg builders (exported for unit tests)
// ---------------------------------------------------------------------------

/**
 * Build the pass 1 ffmpeg arg vector — render libass cues to a transparent
 * PNG sequence. No video decode of the source ; we synthesise a transparent
 * RGBA canvas via `lavfi color=black@0` and overlay subtitles onto it.
 *
 * Output : PNG sequence written as `<dir>/frame_%05d.png` at 30 fps. The
 * frames stay on disk for pass 2 to consume — no in-memory buffering.
 *
 * Exported for unit tests so we can assert the arg vector contains the
 * expected `image2` muxer, `format=rgba`, and `framerate=30` flags.
 */
export function buildPass1Args(params: {
  durationSec: number;
  width: number;
  height: number;
  assPath: string;
  fontsDir: string;
  outFramePattern: string;
}): string[] {
  // Path escaping — same convention as subtitle-burn.ts. ffmpeg filter
  // grammar uses `:` as a kwarg separator so absolute paths must escape
  // colons. Backslashes (Windows-style) become forward slashes.
  const escapeFilterPath = (p: string) =>
    p.replace(/\\/g, "/").replace(/:/g, "\\:");
  const assForFilter = escapeFilterPath(params.assPath);
  const fontsDirForFilter = escapeFilterPath(params.fontsDir);

  // The synthesised input is a transparent RGBA canvas at the target size,
  // 30 fps, for the clip duration. libass renders into this RGBA frame so
  // alpha is preserved after `format=rgba`. `setpts=PTS-STARTPTS` resets
  // the timeline to 0 so the subtitle filter's ASS cue timestamps line up
  // with the synthesised frame timeline.
  const lavfiSrc = `color=black@0:size=${params.width}x${params.height}:rate=30:duration=${params.durationSec.toFixed(2)}`;
  const filter = `subtitles=${assForFilter}:fontsdir=${fontsDirForFilter},format=rgba,setpts=PTS-STARTPTS`;

  return [
    "-f",
    "lavfi",
    "-i",
    lavfiSrc,
    "-vf",
    filter,
    "-an",
    "-vsync",
    "passthrough",
    "-f",
    "image2",
    "-framerate",
    "30",
    "-y",
    params.outFramePattern,
  ];
}

/**
 * Build the pass 2 ffmpeg arg vector — composite the PNG sequence onto
 * the real source and libx264-encode the output. NO libass in this pass.
 * The PNG alpha composite is essentially memcpy + planar blend.
 *
 * Audio is passthrough copy (`-c:a copy`) to avoid the ~10-15 s AAC
 * re-encode penalty on a 50 s clip.
 *
 * Exported for unit tests so we can assert the arg vector contains
 * `overlay`, `-c:v libx264`, `-preset ultrafast`.
 */
export function buildPass2Args(params: {
  sourceMp4Path: string;
  framePattern: string;
  outMp4Path: string;
  startSec: number;
  endSec: number;
  crf: number;
  aspectPrefix: string;
}): string[] {
  // Filter graph :
  //   [0:v]<aspectPrefix>[base];[base][1:v]overlay=0:0[out]
  // When aspectPrefix is empty we still need to give libavfilter a node
  // name for the source tap, so we use `null` (passthrough filter).
  const baseFilter = params.aspectPrefix || "null";
  const filterComplex = `[0:v]${baseFilter}[base];[base][1:v]overlay=0:0[out]`;

  return [
    // Input seek BEFORE -i for fast seek (same convention as buffer path).
    "-ss",
    params.startSec.toFixed(2),
    "-to",
    params.endSec.toFixed(2),
    "-i",
    params.sourceMp4Path,
    // PNG sequence input. `-framerate 30` BEFORE the input forces ffmpeg
    // to interpret the sequence at 30 fps regardless of the file mtime
    // ordering quirks.
    "-framerate",
    "30",
    "-i",
    params.framePattern,
    "-filter_complex",
    filterComplex,
    "-map",
    "[out]",
    "-map",
    "0:a?",
    "-c:v",
    "libx264",
    "-preset",
    "ultrafast",
    "-crf",
    String(params.crf),
    "-profile:v",
    "high",
    "-level",
    "4.1",
    "-pix_fmt",
    "yuv420p",
    "-g",
    "48",
    "-colorspace",
    "bt709",
    "-color_primaries",
    "bt709",
    "-color_trc",
    "bt709",
    "-color_range",
    "tv",
    "-movflags",
    "+faststart",
    "-c:a",
    "copy",
    "-y",
    params.outMp4Path,
  ];
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Render an MP4 with burned-in subtitles via the 2-pass PNG overlay path.
 *
 * Signature mirrors `burnSubtitles()` from `subtitle-burn.ts` so the call
 * site in `run-job.ts` can swap implementations behind the
 * `CLIPS_BURN_PNG_OVERLAY` env flag with zero other changes.
 *
 * Caveats vs the buffer path :
 *   - Logo overlays / Hyperframes ASS overlays are NOT supported on this
 *     path. Calls with `params.overlays` set will silently drop them — the
 *     spike is about isolating the libass cost on the simplest input shape.
 *   - Audio passthrough only (`-c:a copy`). No re-encode.
 */
export async function burnSubtitlesViaPngOverlay(
  params: BurnSubtitlesParams,
): Promise<BurnSubtitlesResult> {
  const dir = await mkdtemp(join(tmpdir(), "pcsub-png-"));
  // When the caller threads `sourcePath` (render worker — segment already
  // streamed to /tmp), ffmpeg reads directly from disk and we skip the
  // buffer load.
  const sourceMp4Path = params.sourcePath ?? join(dir, "in.mp4");
  const assPath = join(dir, "captions.ass");
  const framePattern = join(dir, "frame_%05d.png");
  const outMp4Path = join(dir, "out.mp4");

  try {
    // 1. Source acquisition. Three paths :
    //    (a) `sourcePath` provided → no fetch, no buffer, no write.
    //        Caller (render worker) owns the lifecycle (cleanup).
    //    (b) `sourceBuffer` provided → write to temp dir (legacy).
    //    (c) Neither → fetch + arrayBuffer + write (dev / test).
    if (!params.sourcePath) {
      let sourceBuf: Buffer;
      if (params.sourceBuffer) {
        sourceBuf = params.sourceBuffer;
      } else {
        const res = await fetch(params.sourceVideoUrl);
        if (!res.ok) {
          throw new Error(
            `Source download failed: HTTP ${res.status} ${res.statusText}`,
          );
        }
        sourceBuf = Buffer.from(await res.arrayBuffer());
      }
      await writeFile(sourceMp4Path, sourceBuf);
    }

    // 2. Build display cues from words / pre-translated cues. Same
    //    grouping + dedup rules as subtitle-burn.ts (bare minimum :
    //    we re-do the cue arithmetic locally rather than reach into
    //    private state of the buffer path).
    const clipDuration = params.endSec - params.startSec;
    const preset = STYLE_PRESETS[params.styleKey] ?? STYLE_PRESETS.viral;
    const wordsPerCue = preset.wordsPerCue;

    type DisplayCue = {
      text: string;
      start: number;
      end: number;
      words?: { text: string; start: number; end: number }[];
    };
    let cues: DisplayCue[];
    if (params.preTranslatedCues && params.preTranslatedCues.length > 0) {
      cues = params.preTranslatedCues
        .filter((c) => c.end > params.startSec && c.start < params.endSec)
        .map((c) => ({
          text: c.text,
          start: Math.max(0, c.start - params.startSec),
          end: Math.min(clipDuration, c.end - params.startSec),
        }));
    } else {
      const adjusted = params.words
        .filter((w) => w.end > params.startSec && w.start < params.endSec)
        .map((w) => ({
          text: w.text,
          start: Math.max(0, w.start - params.startSec),
          end: Math.min(clipDuration, w.end - params.startSec),
        }));
      cues = [];
      for (let i = 0; i < adjusted.length; i += wordsPerCue) {
        const g = adjusted.slice(i, i + wordsPerCue);
        cues.push({
          text: g.map((w) => w.text).join(" "),
          start: g[0].start,
          end: g[g.length - 1].end,
          words: g,
        });
      }
    }

    // Dedup pass — same two-pass strategy as the buffer path so the visual
    // output stays in sync (no extra repeats / no missing dedup vs current
    // production behaviour).
    const norm = (s: string): string =>
      s.trim().toLocaleLowerCase("fr-FR").replace(/\s+/g, " ");
    cues = cues.filter((c, i, arr) => {
      if (i === 0) return true;
      const prev = arr[i - 1];
      const a = norm(c.text);
      const b = norm(prev.text);
      const repeated = a === b || b.includes(a) || a.includes(b);
      const overlap = c.start < prev.end + 0.1;
      return !(repeated && overlap);
    });
    const seenWindow: { text: string; until: number }[] = [];
    cues = cues.filter((c) => {
      const key = norm(c.text);
      while (seenWindow.length && seenWindow[0].until < c.start) {
        seenWindow.shift();
      }
      if (seenWindow.some((w) => w.text === key)) return false;
      seenWindow.push({ text: key, until: c.end + 30 });
      return true;
    });
    const MAX_CUE_DURATION = 4;
    cues = cues.map((c) => ({
      ...c,
      end: Math.min(c.end, c.start + MAX_CUE_DURATION),
    }));

    // 3. Stage fonts into the temp dir so libass can resolve them via
    //    `fontsdir=` (same pattern as buffer path — catalogue at `fonts/`
    //    project root).
    const fontsSourceDir = resolve(process.cwd(), "fonts");
    let stagedCount = 0;
    try {
      const files = readdirSync(fontsSourceDir).filter((f) => {
        const lower = f.toLowerCase();
        return lower.endsWith(".ttf") || lower.endsWith(".otf");
      });
      for (const f of files) {
        try {
          const srcBuf = await readFile(join(fontsSourceDir, f));
          await writeFile(join(dir, f), srcBuf);
          stagedCount++;
        } catch {
          // best-effort
        }
      }
    } catch (err) {
      console.log(
        `[clips-burn-png] WARN font dir staging failed (${(err as Error).message.slice(0, 100)})`,
      );
    }

    // 4. Build the ASS file. Smaller copy of the buffer-path generator —
    //    same Style line, same dialogue body builder, same pop-in prefix.
    //    Overlay features intentionally dropped for the spike (see
    //    doc-comment on burnSubtitlesViaPngOverlay).
    const fontFamily = params.customizations?.font ?? preset.defaultFont;
    const fontsize = preset.fontsize;
    const bold = preset.bold;
    const outlineWidth = preset.outlineWidth;
    const shadowDepth = preset.shadowDepth;

    let alignment = 2;
    let marginV = preset.marginV;
    const posPreset = params.customizations?.position;
    if (posPreset === "top") {
      alignment = 8;
      marginV = 80;
    } else if (posPreset === "middle") {
      alignment = 5;
      marginV = 0;
    } else if (posPreset === "lower_third") {
      // Mirror of subtitle-burn.ts — lower-third sweet spot ~62 % from
      // top on PlayResY=1080. See safe-zone audit.
      alignment = 2;
      marginV = 410;
    } else if (posPreset === "bottom") {
      alignment = 2;
      marginV = 80;
    }
    const posY = params.customizations?.position_y;
    if (typeof posY === "number" && posY >= 0 && posY <= 100) {
      if (posY < 33) {
        alignment = 2;
        marginV = Math.round((posY / 33) * 200);
      } else if (posY > 66) {
        alignment = 8;
        marginV = Math.round(((100 - posY) / 34) * 200);
      } else {
        alignment = 5;
        marginV = 0;
      }
    }

    const primaryHex = params.customizations?.text_color ?? "#FFFFFF";
    const secondaryHex =
      params.customizations?.highlight_color ?? preset.defaultSecondary;
    const outlineHex = "#000000";
    const primaryAss = hexToAss(primaryHex, "FFFFFF");
    const secondaryAss = hexToAss(secondaryHex, "FFFFFF");
    const outlineAss = hexToAss(outlineHex, "000000");

    // Build ASS file. PlayRes pinned to the 1080p-equivalent OUTPUT
    // aspect (libass convention — same per-aspect PlayRes as
    // subtitle-burn.ts) :
    //   - 16:9 → 1920×1080
    //   - 9:16 → 1080×1920
    //   - 1:1  → 1080×1080
    //   - 4:5  → 1080×1350
    //
    // CAVEAT (follow-up TODO, inherited from the VidiaFlow spike) :
    // fontsize / MarginV presets were historically tuned for
    // PlayResY=1080. For PlayResY>1080 the visual size shrinks relative
    // to vertical extent — the buffer path compensates via playResScale,
    // this spike path intentionally does not (kept byte-identical to the
    // VidiaFlow spike for A/B comparability).
    const aspectForPlayRes = params.aspectRatio ?? "16:9";
    const [playResX, playResY] = ASPECT_RATIO_DIMENSIONS[aspectForPlayRes];
    const assHeader = [
      "[Script Info]",
      "ScriptType: v4.00+",
      `PlayResX: ${playResX}`,
      `PlayResY: ${playResY}`,
      "ScaledBorderAndShadow: yes",
      "WrapStyle: 0",
      "",
      "[V4+ Styles]",
      "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
      `Style: Default,${fontFamily},${fontsize},${primaryAss},${secondaryAss},${outlineAss},&H80000000&,${bold},0,0,0,100,100,2,0,${preset.borderStyle},${outlineWidth},${shadowDepth},${alignment},80,80,${marginV},1`,
      "",
      "[Events]",
      "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
    ].join("\n");

    const popInBody =
      params.styleKey === "typewriter"
        ? ""
        : preset.popInMs === 0
          ? `\\fad(150,150)`
          : `\\fad(150,150)\\fscx${preset.popInScale}\\fscy${preset.popInScale}\\t(0,${preset.popInMs},\\fscx100\\fscy100)`;
    const inlineRaw = preset.inlineOverrides ?? "";
    const inline =
      params.styleKey === "neon"
        ? `\\3c${secondaryAss}${inlineRaw}`
        : inlineRaw;
    const popInPrefix =
      popInBody.length === 0 && inline.length === 0
        ? ""
        : `{${popInBody}${inline}}`;

    const transformText = (s: string): string => {
      switch (preset.textCase) {
        case "upper":
          return s.toLocaleUpperCase("fr-FR");
        case "lower":
          return s.toLocaleLowerCase("fr-FR");
        case "natural":
        default:
          return s;
      }
    };

    const isTypewriter = params.styleKey === "typewriter";
    const cueToDialogue = (c: DisplayCue): string => {
      const start = assTime(c.start);
      const end = assTime(c.end);
      let body: string;
      if (isTypewriter) {
        const display = transformText(c.text);
        const chars = [...display];
        if (chars.length === 0) {
          body = "";
        } else {
          const totalCs = Math.max(
            chars.length,
            Math.round((c.end - c.start) * 100),
          );
          const perChar = Math.max(1, Math.floor(totalCs / chars.length));
          body = chars
            .map((ch) => {
              const ks = ch === " " ? 0 : perChar;
              return `{\\k${ks}}${escapeAss(ch)}`;
            })
            .join("");
        }
      } else if (c.words && c.words.length > 0) {
        body = c.words
          .map((w) => {
            const cs = Math.max(1, Math.round((w.end - w.start) * 100));
            return `{\\k${cs}}${escapeAss(transformText(w.text))}`;
          })
          .join(" ");
      } else {
        const tokens = c.text.split(/\s+/).filter(Boolean);
        if (tokens.length === 0) {
          body = "";
        } else {
          const totalCs = Math.max(
            tokens.length,
            Math.round((c.end - c.start) * 100),
          );
          const perWord = Math.max(1, Math.floor(totalCs / tokens.length));
          body = tokens
            .map((t) => `{\\k${perWord}}${escapeAss(transformText(t))}`)
            .join(" ");
        }
      }
      const scriptFont = detectScriptFont(c.text);
      const fontPrefix = scriptFont ? `{\\fn${scriptFont}}` : "";
      return `Dialogue: 0,${start},${end},Default,,0,0,0,,${popInPrefix}${fontPrefix}${body}`;
    };

    const assBody =
      assHeader + "\n" + cues.map(cueToDialogue).join("\n") + "\n";
    await writeFile(assPath, assBody, "utf8");

    // 5. Resolve canvas dimensions for the PNG raster pass. When the caller
    //    supplied an aspect ratio, the canvas matches the cropped output
    //    so libass renders in the final coordinate system. When no aspect
    //    is supplied, fall back to 1920x1080 (the ASS PlayResX/Y the cue
    //    sizes are already calibrated against).
    let canvasW = 1920;
    let canvasH = 1080;
    if (params.aspectRatio) {
      const [w, h] = ASPECT_RATIO_DIMENSIONS[params.aspectRatio];
      canvasW = w;
      canvasH = h;
    }

    // 6. Build the WebVTT sidecar from the FINAL cues array (same as
    //    buffer path).
    const vtt = buildVttFromCues(
      cues.map((c) => ({ text: c.text, start: c.start, end: c.end })),
    );

    // 7. Pass 1 — libass → PNG sequence.
    const pass1Args = buildPass1Args({
      durationSec: clipDuration,
      width: canvasW,
      height: canvasH,
      assPath,
      fontsDir: dir,
      outFramePattern: framePattern,
    });

    console.log(
      `[clips-burn-png] start cues=${cues.length} duration=${clipDuration.toFixed(2)}s canvas=${canvasW}x${canvasH} stagedFonts=${stagedCount} dir=${dir}`,
    );

    await runFfmpeg(pass1Args, "pass1-png-raster");

    // 8. Pass 2 — overlay + libx264 encode.
    const aspectPrefix = await aspectFilterFor(params.aspectRatio);
    const styleCrf = STYLE_CRF_MAP[params.styleKey] ?? 20;
    const pass2Args = buildPass2Args({
      sourceMp4Path,
      framePattern,
      outMp4Path,
      startSec: params.startSec,
      endSec: params.endSec,
      crf: styleCrf,
      aspectPrefix,
    });

    await runFfmpeg(pass2Args, "pass2-encode");

    const mp4 = await readFile(outMp4Path);
    return { mp4, vtt };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Run ffmpeg with the given args, capturing stderr and surfacing the
 * exit code on failure. Same minimal pattern as `subtitle-burn.ts` —
 * just enough diagnostic output to debug when a pass fails in production.
 */
function runFfmpeg(args: string[], passLabel: string): Promise<void> {
  return new Promise<void>((res, rej) => {
    const p = spawn(ffmpegPath.path, args);
    let stderrBuf = "";
    p.stderr?.on("data", (chunk: Buffer) => {
      stderrBuf += chunk.toString();
    });
    p.on("error", rej);
    p.on("close", (code) => {
      const stderrTail = stderrBuf.slice(-1500);
      const subtitleLines = stderrBuf
        .split("\n")
        .filter(
          (l) =>
            l.includes("subtitles") ||
            l.includes("libass") ||
            l.includes("Parsed_subtitles") ||
            l.includes("fontselect") ||
            l.includes("ASS") ||
            l.includes("overlay"),
        )
        .slice(0, 10)
        .join(" | ");
      console.log(
        `[clips-burn-png] ${passLabel} exit=${code} signals=${JSON.stringify(subtitleLines).slice(0, 600)}`,
      );
      if (code !== 0) {
        console.log(
          `[clips-burn-png] ${passLabel} FAIL stderr=${JSON.stringify(stderrTail).slice(0, 1200)}`,
        );
        rej(
          new Error(
            `ffmpeg ${passLabel} exited ${code}: ${stderrBuf.slice(-600)}`,
          ),
        );
      } else {
        res();
      }
    });
  });
}
