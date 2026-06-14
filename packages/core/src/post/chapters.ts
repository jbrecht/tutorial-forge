import type { TimingManifest } from '../types.js';

/**
 * A chapter on the final output timeline. One per step that opens a new
 * segment (see {@link computeChapters}); start/end are output-timeline ms
 * (post trim and any idle-speedup retime), so they line up with the rendered
 * video, the SRT, and burned captions.
 */
export interface Chapter {
  /** Id of the step that opens the chapter. */
  id: string;
  title: string;
  startMs: number;
  endMs: number;
}

export interface ChapterOptions {
  /** ms on the manifest clock where step playback starts (pre-roll trim point). */
  trimStartMs: number;
  /** Optional retime map (idle speed-up): trimmed-timeline ms → output ms. */
  mapMs?: (ms: number) => number;
  /** Total length of the output video on its own timeline (post trim/retime). */
  outputDurationMs: number;
  /** Cap derived titles at this many characters (default 60). */
  maxTitleChars?: number;
}

/**
 * One chapter per step with spoken narration; silent steps (empty narration)
 * fold into the chapter that precedes them rather than littering the timeline
 * with click-by-click markers — chapters mark *concepts*, the segmenting
 * principle. The first step always opens chapter 1 so playback starts inside a
 * chapter even if it opens on a silent beat.
 *
 * Per-step is the first cut; author-defined section grouping (chapters that map
 * to named concepts spanning several steps) is a planned fast-follow — see #35.
 */
export function computeChapters(manifest: TimingManifest, opts: ChapterOptions): Chapter[] {
  const mapMs = opts.mapMs ?? ((ms: number) => ms);
  const toOutput = (clockMs: number) => Math.max(0, Math.round(mapMs(clockMs - opts.trimStartMs)));
  const maxTitle = opts.maxTitleChars ?? 60;

  const chapters: Chapter[] = [];
  for (const step of manifest.steps) {
    const isFirst = chapters.length === 0;
    if (!isFirst && !step.narration.trim()) continue; // silent step folds into the prior chapter
    chapters.push({
      id: step.id,
      title: deriveChapterTitle(step.narration, step.id, maxTitle),
      // The first chapter always starts at 0 so there's no gap before playback.
      startMs: isFirst ? 0 : toOutput(step.startMs),
      endMs: 0, // filled below
    });
  }

  for (let i = 0; i < chapters.length; i++) {
    chapters[i]!.endMs = i + 1 < chapters.length ? chapters[i + 1]!.startMs : opts.outputDurationMs;
  }
  // Drop any zero-/negative-length chapters (e.g. two narrated steps mapping to
  // the same output ms under aggressive retiming).
  return chapters.filter((c) => c.endMs > c.startMs);
}

/**
 * A short, human chapter title from a step's narration: its first sentence,
 * trimmed and capped. Falls back to a humanized step id for silent steps.
 */
export function deriveChapterTitle(narration: string, id: string, maxChars = 60): string {
  const text = narration.replace(/\s+/g, ' ').trim();
  if (!text) return humanizeId(id);
  const firstSentence = /^(.*?[.!?])(\s|$)/.exec(text)?.[1] ?? text;
  let title = firstSentence.trim().replace(/\.$/, ''); // drop a single trailing period; keep ! and ?
  if (title.length > maxChars) title = title.slice(0, maxChars - 1).trimEnd() + '…';
  return title;
}

function humanizeId(id: string): string {
  return id.replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

/** WebVTT chapters track (`<id>.chapters.vtt`) for web players. */
export function generateChaptersVtt(chapters: Chapter[]): string {
  const cues = chapters.map(
    (c, i) => `${i + 1}\n${vttTime(c.startMs)} --> ${vttTime(c.endMs)}\n${c.title}`,
  );
  return `WEBVTT\n\n${cues.join('\n\n')}\n`;
}

/**
 * YouTube-style timestamp list (`<id>.chapters.txt`) — paste into a video
 * description to get clickable chapters. `computeChapters` always starts the
 * first stamp at 0:00 as YouTube requires; note YouTube only renders chapters
 * when there are at least three, so a one- or two-step tutorial's list won't
 * activate there (it's still a valid timestamp index).
 */
export function generateChaptersTxt(chapters: Chapter[]): string {
  return chapters.map((c) => `${stampTime(c.startMs)} ${c.title}`).join('\n') + '\n';
}

/**
 * ffmetadata chapter block, fed to ffmpeg as a second input (`-f ffmetadata`)
 * with `-map_metadata` so the MP4 carries a chapter track readable by
 * QuickTime / VLC. Times are milliseconds with a 1/1000 timebase.
 */
export function generateChaptersFfmetadata(chapters: Chapter[]): string {
  const blocks = chapters.map(
    (c) =>
      `[CHAPTER]\nTIMEBASE=1/1000\nSTART=${Math.round(c.startMs)}\nEND=${Math.round(c.endMs)}\ntitle=${escapeFfmeta(c.title)}`,
  );
  return `;FFMETADATA1\n${blocks.join('\n')}\n`;
}

/** ffmetadata reserves =, ;, #, \ and newline — escape with a backslash. */
function escapeFfmeta(value: string): string {
  return value.replace(/([=;#\\\n])/g, '\\$1');
}

/** WebVTT timestamp: HH:MM:SS.mmm */
export function vttTime(ms: number): string {
  const clamped = Math.max(0, Math.round(ms));
  const h = Math.floor(clamped / 3_600_000);
  const m = Math.floor((clamped % 3_600_000) / 60_000);
  const s = Math.floor((clamped % 60_000) / 1000);
  const f = clamped % 1000;
  const pad = (v: number, len = 2) => String(v).padStart(len, '0');
  return `${pad(h)}:${pad(m)}:${pad(s)}.${pad(f, 3)}`;
}

/** Description-style stamp: M:SS, or H:MM:SS past an hour (YouTube convention). */
export function stampTime(ms: number): string {
  const clamped = Math.max(0, Math.round(ms));
  const h = Math.floor(clamped / 3_600_000);
  const m = Math.floor((clamped % 3_600_000) / 60_000);
  const s = Math.floor((clamped % 60_000) / 1000);
  const pad = (v: number) => String(v).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}
