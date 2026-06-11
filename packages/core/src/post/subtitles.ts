import type { TimingManifest } from '../types.js';

/**
 * One SRT cue per narrated step: text = narration, range = narration playback
 * window. Cue times are relative to the trimmed video, so trimStartMs (manifest
 * clock) is subtracted.
 */
export function generateSrt(
  manifest: TimingManifest,
  opts: {
    leadInMs: number;
    trimStartMs: number;
    maxLineChars?: number;
    /** Optional retime map (idle speed-up): trimmed-timeline ms → output ms. */
    mapMs?: (ms: number) => number;
  },
): string {
  const max = opts.maxLineChars ?? 42;
  const mapMs = opts.mapMs ?? ((ms: number) => ms);
  const cues: string[] = [];
  let n = 0;
  for (const step of manifest.steps) {
    if (!step.narration.trim() || step.audioDurationMs <= 0) continue;
    n += 1;
    const start = mapMs(step.startMs + opts.leadInMs - opts.trimStartMs);
    const end = start + step.audioDurationMs; // narration spans play at 1x
    cues.push(`${n}\n${srtTime(start)} --> ${srtTime(end)}\n${wrapText(step.narration, max)}\n`);
  }
  return cues.join('\n');
}

export function srtTime(ms: number): string {
  const clamped = Math.max(0, Math.round(ms));
  const h = Math.floor(clamped / 3_600_000);
  const m = Math.floor((clamped % 3_600_000) / 60_000);
  const s = Math.floor((clamped % 60_000) / 1000);
  const f = clamped % 1000;
  const pad = (v: number, len = 2) => String(v).padStart(len, '0');
  return `${pad(h)}:${pad(m)}:${pad(s)},${pad(f, 3)}`;
}

/** Greedy word wrap at ~max chars/line. */
export function wrapText(text: string, max: number): string {
  const words = text.trim().split(/\s+/);
  const lines: string[] = [];
  let line = '';
  for (const word of words) {
    if (line && line.length + 1 + word.length > max) {
      lines.push(line);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  if (line) lines.push(line);
  return lines.join('\n');
}
