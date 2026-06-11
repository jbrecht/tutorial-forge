import type { TimingManifest } from '../types.js';

/**
 * One SRT cue per narrated step: text = narration, range = narration playback
 * window. Cue times are relative to the trimmed video, so trimStartMs (manifest
 * clock) is subtracted.
 */
export interface Cue {
  text: string;
  /** Output-timeline ms (post trim and retime). */
  startMs: number;
  endMs: number;
}

export interface CueOptions {
  leadInMs: number;
  trimStartMs: number;
  /** Optional retime map (idle speed-up): trimmed-timeline ms → output ms. */
  mapMs?: (ms: number) => number;
}

/** One cue per narrated step, on the final output timeline. Shared by SRT and burned captions. */
export function computeCues(manifest: TimingManifest, opts: CueOptions): Cue[] {
  const mapMs = opts.mapMs ?? ((ms: number) => ms);
  const cues: Cue[] = [];
  for (const step of manifest.steps) {
    if (!step.narration.trim() || step.audioDurationMs <= 0) continue;
    const startMs = mapMs(step.startMs + opts.leadInMs - opts.trimStartMs);
    cues.push({
      text: step.narration,
      startMs,
      endMs: startMs + step.audioDurationMs, // narration spans play at 1x
    });
  }
  return cues;
}

export function generateSrt(
  manifest: TimingManifest,
  opts: CueOptions & { maxLineChars?: number },
): string {
  const max = opts.maxLineChars ?? 42;
  return computeCues(manifest, opts)
    .map((cue, i) => `${i + 1}\n${srtTime(cue.startMs)} --> ${srtTime(cue.endMs)}\n${wrapText(cue.text, max)}\n`)
    .join('\n');
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
