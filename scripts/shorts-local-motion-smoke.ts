import { spawn } from "node:child_process";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";

import ffmpegPath from "@ffmpeg-installer/ffmpeg";

import { buildOverlays } from "../src/lib/clips/overlays";
import { shortsTitleCardOverlay } from "../src/lib/shorts/render-submission";

const CLIP_DURATION_SECONDS = 10;
const MOTION_TEMPLATES = [
  "punchy-cuts",
  "kinetic-captions",
  "editorial-focus",
  "calm-focus",
] as const;

function runFfmpeg(args: string[], label: string): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(ffmpegPath.path, args, {
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`${label}: FFmpeg render timed out`));
    }, 60_000);

    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = `${stderr}${chunk.toString("utf8")}`.slice(-2_000);
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolvePromise();
      else reject(new Error(`${label}: FFmpeg exited ${code}: ${stderr}`));
    });
  });
}

function buildAssFile(dialogues: readonly string[]): string {
  return [
    "[Script Info]",
    "ScriptType: v4.00+",
    "PlayResX: 270",
    "PlayResY: 480",
    "ScaledBorderAndShadow: yes",
    "WrapStyle: 0",
    "",
    "[V4+ Styles]",
    "Format: Name,Fontname,Fontsize,PrimaryColour,SecondaryColour,OutlineColour,BackColour,Bold,Italic,Underline,StrikeOut,ScaleX,ScaleY,Spacing,Angle,BorderStyle,Outline,Shadow,Alignment,MarginL,MarginR,MarginV,Encoding",
    "Style: Default,Inter,32,&H00FFFFFF,&H000000FF,&H00000000,&H80000000,1,0,0,0,100,100,0,0,1,2,1,2,20,20,60,1",
    "",
    "[Events]",
    "Format: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text",
    ...dialogues,
    "",
  ].join("\n");
}

function assFilterPath(path: string): string {
  return path.replaceAll("\\", "/").replaceAll(":", "\\:");
}

async function renderOverlay(
  sourcePath: string,
  assPath: string,
  outputPath: string,
  label: string,
): Promise<void> {
  await runFfmpeg(
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-i",
      sourcePath,
      "-vf",
      `ass=filename='${assFilterPath(assPath)}'`,
      "-an",
      "-c:v",
      "mpeg4",
      "-q:v",
      "6",
      "-movflags",
      "+faststart",
      "-y",
      outputPath,
    ],
    label,
  );
  if ((await stat(outputPath)).size < 1_000) {
    throw new Error(`${label}: rendered MP4 is unexpectedly small`);
  }
}

async function main(): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "clipsflow-motion-smoke-"));
  const sourcePath = join(directory, "synthetic-source.mp4");
  const title = "A useful idea";
  const hook = "One clear point, in ten seconds.";

  try {
    await runFfmpeg(
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-f",
        "lavfi",
        "-i",
        `color=c=0x182235:s=270x480:r=12:d=${CLIP_DURATION_SECONDS}`,
        "-an",
        "-c:v",
        "mpeg4",
        "-q:v",
        "6",
        "-pix_fmt",
        "yuv420p",
        "-y",
        sourcePath,
      ],
      "synthetic source",
    );

    for (const template of MOTION_TEMPLATES) {
      const titleCard = shortsTitleCardOverlay(
        title,
        hook,
        CLIP_DURATION_SECONDS,
        template,
      );
      if (!titleCard) throw new Error(`${template}: title card was omitted`);
      const overlays = buildOverlays([titleCard], CLIP_DURATION_SECONDS);
      const assPath = join(directory, `${template}.ass`);
      const outputPath = join(directory, `${template}.mp4`);
      await writeFile(assPath, buildAssFile(overlays.assDialogues), "utf8");
      await renderOverlay(sourcePath, assPath, outputPath, template);
    }

    const punchTitleCard = shortsTitleCardOverlay(
      title,
      hook,
      CLIP_DURATION_SECONDS,
      "punchy-cuts",
    );
    if (!punchTitleCard) throw new Error("reduced-motion title card missing");
    const reducedMotion = buildOverlays(
      [punchTitleCard],
      CLIP_DURATION_SECONDS,
      "Inter",
      true,
    );
    if (
      reducedMotion.assDialogues.some((dialogue) =>
        /\\(?:fad|move|t)\(/u.test(dialogue),
      )
    ) {
      throw new Error(
        "reduced-motion title card still contains animation tags",
      );
    }
    const reducedAssPath = join(directory, "reduced-motion.ass");
    const reducedOutputPath = join(directory, "reduced-motion.mp4");
    await writeFile(
      reducedAssPath,
      buildAssFile(reducedMotion.assDialogues),
      "utf8",
    );
    await renderOverlay(
      sourcePath,
      reducedAssPath,
      reducedOutputPath,
      "reduced-motion",
    );

    console.log(
      "Local Shorts motion smoke passed: FFmpeg rendered four distinct animated title-card presets and one reduced-motion variant. No AI provider was called.",
    );
  } finally {
    const tempRoot = resolve(tmpdir()) + sep;
    const target = resolve(directory);
    const relativeTarget = relative(tempRoot, target);
    if (!relativeTarget || relativeTarget.startsWith("..")) {
      throw new Error("Refusing to remove motion smoke files outside temp");
    }
    await rm(target, { recursive: true, force: true });
  }
}

main().catch((error: unknown) => {
  const message =
    error instanceof Error ? error.message : "unknown local motion smoke error";
  console.error(`Local Shorts motion smoke failed: ${message}`);
  process.exitCode = 1;
});
