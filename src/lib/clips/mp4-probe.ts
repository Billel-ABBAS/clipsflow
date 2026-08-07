// ============================================================================
// ClipsFlow Clips — server-side MP4 probe
// ============================================================================
// Quick MP4 validation for upload paths. Accepts user-supplied bytes and
// verifies the container header + duration via ffmpeg probe mode.
//
// Three cheap checks :
//   1. `verifyMp4MagicBytes(buf)` — synchronous header sniff.
//   2. `probeMp4Duration(buf, expectedSec)` — spawn ffmpeg in probe mode
//      to parse the mvhd duration from stderr.
//   3. `probeHasVideoStream(filePath)` — spawn ffmpeg in probe mode to
//      detect whether the container carries a real video track (used by
//      the render pipeline to route audio-only episodes to the
//      audiogram branch). Added for ClipsFlow Lot 2 — no VidiaFlow
//      equivalent (ClipFlow only accepted video sources).
//
// All helpers fail closed — any error is surfaced to the caller.
//
// Ported from VidiaFlow src/lib/clipflow/mp4-probe.ts (unchanged logic).
// ============================================================================

import ffmpegPath from "@ffmpeg-installer/ffmpeg";
import { spawn } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export class Mp4ProbeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "Mp4ProbeError";
  }
}

/**
 * Synchronous header sniff. Returns true iff the buffer begins with a
 * valid ISOBMFF / MP4 container header. Never throws.
 *
 * Layout :
 *   bytes 0-3 : box size (big-endian uint32)
 *   bytes 4-7 : box type — "ftyp" for the file-type box that legal MP4
 *               files MUST place at offset 4. Also accepts "styp" for
 *               fragmented MP4 (DASH segments).
 */
export function verifyMp4MagicBytes(buf: Buffer): boolean {
  if (buf.length < 12) return false;
  const boxType = buf.slice(4, 8).toString("ascii");
  return boxType === "ftyp" || boxType === "styp";
}

/**
 * Spawn ffmpeg with the buffer staged to a tmp file, ask it to parse the
 * container without decoding (`-f null -`), and read the duration from
 * stderr. Returns the parsed duration in seconds.
 *
 * Throws `Mp4ProbeError` if :
 *  - ffmpeg cannot parse the container (corrupt / not really MP4)
 *  - duration drifts more than `toleranceSec` from `expectedSec`
 *  - duration line absent from ffmpeg output
 */
export async function probeMp4Duration(
  buf: Buffer,
  expectedSec: number,
  toleranceSec = 2,
): Promise<number> {
  if (!verifyMp4MagicBytes(buf)) {
    throw new Mp4ProbeError(
      "mp4 buffer does not begin with an ISOBMFF ftyp box",
    );
  }

  const dir = await mkdtemp(join(tmpdir(), "pcprobe-"));
  const inPath = join(dir, "in.mp4");
  try {
    await writeFile(inPath, buf);
    const stderr = await new Promise<string>((res, rej) => {
      const args = ["-hide_banner", "-i", inPath, "-f", "null", "-t", "0", "-"];
      const p = spawn(ffmpegPath.path, args);
      let stderrBuf = "";
      p.stderr?.on("data", (chunk: Buffer) => {
        stderrBuf += chunk.toString();
      });
      p.on("error", rej);
      p.on("close", () => {
        res(stderrBuf);
      });
    });
    // ffmpeg duration line :
    //   Duration: 00:00:30.04, start: 0.000000, bitrate: 1234 kb/s
    const m = stderr.match(/Duration:\s+(\d+):(\d+):(\d+\.\d+)/);
    if (!m) {
      throw new Mp4ProbeError(
        `ffmpeg could not parse duration from container (stderr=${stderr.slice(-300)})`,
      );
    }
    const hours = parseInt(m[1]!, 10);
    const minutes = parseInt(m[2]!, 10);
    const seconds = parseFloat(m[3]!);
    const total = hours * 3600 + minutes * 60 + seconds;
    if (!Number.isFinite(total) || total <= 0) {
      throw new Mp4ProbeError(`parsed duration is non-positive : ${total}`);
    }
    if (Math.abs(total - expectedSec) > toleranceSec) {
      throw new Mp4ProbeError(
        `duration drift : declared ${expectedSec}s, container reports ${total.toFixed(2)}s ` +
          `(tolerance ±${toleranceSec}s)`,
      );
    }
    return total;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * Detect whether a media file on disk carries a REAL video track.
 *
 * Spawns ffmpeg in probe mode (`-f null -t 0`) and scans stderr for
 * `Stream #x:y ...: Video:` lines. Embedded cover art (common on podcast
 * .m4a / .mp3 files) is exposed by ffmpeg as a Video stream tagged
 * `(attached pic)` — those are EXCLUDED, otherwise every podcast episode
 * with album art would be misrouted to the video burn path.
 *
 * Throws `Mp4ProbeError` if ffmpeg fails to spawn or the stderr carries
 * no stream information at all (unreadable container).
 */
export async function probeHasVideoStream(filePath: string): Promise<boolean> {
  const stderr = await new Promise<string>((res, rej) => {
    const args = ["-hide_banner", "-i", filePath, "-f", "null", "-t", "0", "-"];
    const p = spawn(ffmpegPath.path, args);
    let stderrBuf = "";
    p.stderr?.on("data", (chunk: Buffer) => {
      stderrBuf += chunk.toString();
    });
    p.on("error", rej);
    p.on("close", () => {
      res(stderrBuf);
    });
  });

  const streamLines = stderr
    .split("\n")
    .filter((l) => /^\s*Stream #\d+:\d+/.test(l));
  if (streamLines.length === 0) {
    throw new Mp4ProbeError(
      `ffmpeg reported no streams for ${filePath.slice(-80)} (stderr=${stderr.slice(-300)})`,
    );
  }
  return streamLines.some(
    (l) => /:\s*Video:/.test(l) && !l.includes("attached pic"),
  );
}
