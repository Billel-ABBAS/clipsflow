import { spawn } from "node:child_process";

/** Short deterministic accents, not unrestricted text-to-sound generation. */
export function buildSfxFilter(prompt: string, duration: number): string {
  if (!Number.isFinite(duration) || duration < 0.5 || duration > 3) throw new Error("open_audio_input_invalid");
  const pop = /\b(pop|click)\b/i.test(prompt);
  const impact = /\b(impact|thud)\b/i.test(prompt);
  const source = pop || impact
    ? `sine=frequency=${pop ? 880 : 70}:sample_rate=44100:duration=${duration}`
    : `anoisesrc=color=pink:seed=7:sample_rate=44100:amplitude=0.25:duration=${duration},highpass=f=350,lowpass=f=7000`;
  return `${source},afade=t=in:d=0.015,afade=t=out:st=${duration * 0.15}:d=${duration * 0.85},volume=0.6`;
}

/** Decode only bytes/locally synthesized audio; never put a URL in FFmpeg. */
export async function renderOpenAudio(
  input: { prompt?: string; bytes?: Uint8Array; durationSeconds: number },
  options: { binary?: string } = {},
): Promise<Uint8Array> {
  const music = input.bytes !== undefined;
  const limit = 32 * 1024 * 1024;
  if (!Number.isFinite(input.durationSeconds) || input.durationSeconds < (music ? 3 : 0.5) ||
      input.durationSeconds > (music ? 180 : 3) || (music && (!input.bytes?.byteLength || input.bytes.byteLength > limit))) {
    throw new Error("open_audio_input_invalid");
  }
  const binary = options.binary ?? (await import("@ffmpeg-installer/ffmpeg")).default.path;
  const args = ["-nostdin", "-hide_banner", "-loglevel", "error", "-protocol_whitelist", "file,pipe",
    ...(music ? ["-i", "pipe:0"] : ["-f", "lavfi", "-i", buildSfxFilter(input.prompt ?? "", input.durationSeconds)]),
    "-map", "0:a:0", "-vn", "-af", `apad,atrim=duration=${input.durationSeconds}`,
    "-t", String(input.durationSeconds), "-ac", "2", "-ar", "44100",
    "-c:a", "libmp3lame", "-b:a", "128k", "-f", "mp3", "pipe:1"];
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    const chunks: Buffer[] = [];
    let size = 0;
    let failed = false;
    const fail = () => {
      if (failed) return;
      failed = true;
      child.kill("SIGKILL");
      clearTimeout(timer);
      reject(new Error("open_audio_ffmpeg_failed"));
    };
    const timer = setTimeout(fail, 30_000);
    child.on("error", fail);
    child.stdin.on("error", fail);
    child.stdout.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) fail();
      else if (!failed) chunks.push(chunk);
    });
    child.stderr.resume();
    child.once("close", (code) => {
      clearTimeout(timer);
      if (failed) return;
      if (code !== 0 || size < 128) { fail(); return; }
      resolve(new Uint8Array(Buffer.concat(chunks, size)));
    });
    child.stdin.end(input.bytes);
  });
}
