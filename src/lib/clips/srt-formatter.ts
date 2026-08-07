// ============================================================================
// ClipsFlow Clips — SRT / WebVTT formatter
// ============================================================================
// Ported from VidiaFlow src/lib/utils/srt-formatter.ts.
// Adaptation : import path adapted; TranscriptSegment type inlined since the
// ClipsFlow types module does not yet export it (it lives in
// `episodes.transcript_segments` jsonb column, not a named TS type yet).
// ============================================================================

export interface TranscriptSegment {
  start: number;
  duration: number;
  text: string;
}

function formatTimeSrt(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const ms = Math.round((seconds % 1) * 1000);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")},${String(ms).padStart(3, "0")}`;
}

function formatTimeVtt(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const ms = Math.round((seconds % 1) * 1000);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(ms).padStart(3, "0")}`;
}

export function toSrt(segments: TranscriptSegment[]): string {
  return segments
    .map((seg, i) => {
      const start = formatTimeSrt(seg.start);
      const end = formatTimeSrt(seg.start + seg.duration);
      return `${i + 1}\n${start} --> ${end}\n${seg.text}\n`;
    })
    .join("\n");
}

export function toVtt(segments: TranscriptSegment[]): string {
  const header = "WEBVTT\n\n";
  const body = segments
    .map((seg) => {
      const start = formatTimeVtt(seg.start);
      const end = formatTimeVtt(seg.start + seg.duration);
      return `${start} --> ${end}\n${seg.text}\n`;
    })
    .join("\n");
  return header + body;
}
