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
  /**
   * Cap derived titles at this many characters (default 50 — Vimeo's chapter
   * title limit, the strictest of the common upload targets, so a single cap
   * keeps titles safe everywhere).
   */
  maxTitleChars?: number;
}

/**
 * Minimum chapter duration for a YouTube description chapter list to activate.
 * YouTube ignores the *entire* list if any single chapter is shorter than this,
 * so the `.chapters.txt` artifact is folded to clear it (see
 * {@link enforceMinChapterDuration}). Other targets have no such floor.
 */
export const YOUTUBE_MIN_CHAPTER_MS = 10_000;

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
  const maxTitle = opts.maxTitleChars ?? 50;

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

/** Shift every chapter by `byMs` — used to slide body chapters past a prepended intro card (#37). */
export function shiftChapters(chapters: Chapter[], byMs: number): Chapter[] {
  if (!byMs) return chapters;
  return chapters.map((c) => ({ ...c, startMs: c.startMs + byMs, endMs: c.endMs + byMs }));
}

/**
 * Fold any chapter shorter than `minMs` into a neighbor so every surviving
 * chapter clears a platform's activation floor — used for the YouTube `.txt`
 * list, which YouTube disables *in its entirety* if a single chapter is under
 * 10s ({@link YOUTUBE_MIN_CHAPTER_MS}). A too-short chapter folds into the one
 * before it (which keeps its title and extends to cover the span — a chapter is
 * named by what opens it); a too-short *first* chapter folds forward into the
 * next, whose start is pulled back so playback still opens inside a chapter.
 * Re-checks after each merge, so chains of short chapters collapse cleanly.
 * Collapsing to a single chapter is allowed — we never invent boundaries to hit
 * a count. Returns the input untouched when `minMs <= 0` or nothing is short.
 */
export function enforceMinChapterDuration(chapters: Chapter[], minMs: number): Chapter[] {
  if (minMs <= 0 || chapters.length <= 1) return chapters;
  const result = chapters.map((c) => ({ ...c }));
  let i = 0;
  while (result.length > 1 && i < result.length) {
    const c = result[i]!;
    if (c.endMs - c.startMs >= minMs) {
      i++;
      continue;
    }
    if (i > 0) {
      result[i - 1]!.endMs = c.endMs; // previous absorbs the span, keeps its title
      result.splice(i, 1);
      i--; // re-check the now-longer previous chapter
    } else {
      result[i + 1]!.startMs = c.startMs; // first chapter folds forward; next opens at its start (0)
      result.splice(i, 1); // i stays 0 to re-check the new first chapter
    }
  }
  return result;
}

/**
 * A short, human chapter title from a step's narration: its first sentence,
 * trimmed and capped. Falls back to a humanized step id for silent steps.
 */
export function deriveChapterTitle(narration: string, id: string, maxChars = 50): string {
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
 * description to get clickable chapters. YouTube activates the list only when
 * all of: the first stamp is 0:00 (`computeChapters` guarantees this), there
 * are at least three chapters, and every chapter is ≥ 10s. The caller runs the
 * list through {@link enforceMinChapterDuration} to satisfy the last rule; the
 * three-chapter minimum can't be manufactured, so a one- or two-step tutorial's
 * list won't activate on YouTube (it's still a valid timestamp index).
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
