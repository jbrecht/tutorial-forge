import { execa } from 'execa';
import type { TimingManifest } from '../types.js';
import { logger } from '../util/logger.js';

export class FfmpegError extends Error {
  constructor(cmd: string, public readonly stderr: string) {
    super(`${cmd} failed:\n${stderr.split('\n').slice(-12).join('\n')}`);
    this.name = 'FfmpegError';
  }
}

async function run(bin: 'ffmpeg' | 'ffprobe', args: string[]): Promise<string> {
  logger.debug(`${bin} ${args.join(' ')}`);
  try {
    const { stdout } = await execa(bin, args);
    return stdout;
  } catch (err) {
    const stderr = (err as { stderr?: string }).stderr ?? String(err);
    throw new FfmpegError(bin, stderr);
  }
}

export async function ffmpegVersion(bin: 'ffmpeg' | 'ffprobe' = 'ffmpeg'): Promise<string | null> {
  try {
    const { stdout } = await execa(bin, ['-version']);
    return /version\s+(\S+)/.exec(stdout)?.[1] ?? null;
  } catch {
    return null;
  }
}

/** Whether this ffmpeg build includes a filter (e.g. 'subtitles' requires libass). */
export async function ffmpegHasFilter(name: string): Promise<boolean> {
  try {
    const { stdout } = await execa('ffmpeg', ['-hide_banner', '-filters']);
    return new RegExp(`\\s${name}\\s`).test(stdout);
  } catch {
    return false;
  }
}

/** Exact media duration in milliseconds, via ffprobe. */
export async function probeDurationMs(file: string): Promise<number> {
  const out = await run('ffprobe', [
    '-v', 'error',
    '-show_entries', 'format=duration',
    '-of', 'default=noprint_wrappers=1:nokey=1',
    file,
  ]);
  const seconds = parseFloat(out.trim());
  if (!Number.isFinite(seconds)) throw new Error(`ffprobe returned no duration for ${file}`);
  return Math.round(seconds * 1000);
}

/** Re-encode any audio file to 48kHz mono 16-bit WAV. */
export async function normalizeToWav(input: string, output: string): Promise<void> {
  // -f wav: output may land at a temp path without a .wav extension.
  await run('ffmpeg', ['-y', '-i', input, '-ar', '48000', '-ac', '1', '-c:a', 'pcm_s16le', '-f', 'wav', output]);
}

/**
 * Find the calibration flash (a solid magenta frame painted at clock zero) in
 * the first seconds of the raw recording. Returns the offset in ms from the
 * start of the video file to the first flash frame, or null if not found.
 *
 * Uses the signalstats filter: magenta has extreme U and V averages
 * (both near max), which never occurs in normal page content.
 */
export async function detectFlashOffsetMs(video: string, scanSeconds = 4): Promise<number | null> {
  try {
    const { stdout } = await execa('ffmpeg', [
      '-t', String(scanSeconds),
      '-i', video,
      '-vf', 'signalstats,metadata=print:file=-',
      '-f', 'null', '-',
    ]);
    return parseFlashFromMetadata(stdout);
  } catch (err) {
    logger.warn(`flash detection failed: ${err instanceof Error ? err.message : err}`);
    return null;
  }
}

/**
 * Minimum chroma average (on the 0–255 signalstats scale, neutral = 128) that
 * BOTH U and V must clear for a frame to count as the magenta flash.
 *
 * Magenta (#ff00ff) is the only thing that pushes *both* chroma channels far
 * above neutral at once — normal UI content lifts at most one (a blue button is
 * high-U/low-V, red text low-U/high-V), so requiring both stays magenta-specific.
 * A clean full-range flash measures UAVG≈201 / VAVG≈221, but the same frame
 * decoded as **limited range** (16–235, which CI's webm pipeline often does)
 * scales toward center to ≈177 / ≈195 — straddling the old 180/170 cutoff and
 * causing intermittent misses (#46). 150 keeps a wide margin above neutral and
 * above any single-channel UI colour while absorbing range/compression drift.
 */
export const FLASH_CHROMA_MIN = 150;

/**
 * Parse signalstats metadata=print output. Frames arrive as
 *   frame:N pts:P pts_time:T
 *   lavfi.signalstats.UAVG=...
 *   lavfi.signalstats.VAVG=...
 * Returns the time of the first frame whose chroma reads as magenta (see
 * {@link FLASH_CHROMA_MIN}), i.e. the calibration flash.
 */
export function parseFlashFromMetadata(out: string): number | null {
  let ptsTime: number | null = null;
  let uavg: number | null = null;
  let vavg: number | null = null;
  for (const line of out.split('\n')) {
    const frame = /pts_time:([\d.]+)/.exec(line);
    if (frame) {
      ptsTime = parseFloat(frame[1]!);
      uavg = vavg = null;
      continue;
    }
    const u = /lavfi\.signalstats\.UAVG=([\d.]+)/.exec(line);
    if (u) uavg = parseFloat(u[1]!);
    const v = /lavfi\.signalstats\.VAVG=([\d.]+)/.exec(line);
    if (v) vavg = parseFloat(v[1]!);
    if (ptsTime !== null && uavg !== null && vavg !== null) {
      if (uavg > FLASH_CHROMA_MIN && vavg > FLASH_CHROMA_MIN) return Math.round(ptsTime * 1000);
      uavg = vavg = null;
    }
  }
  return null;
}

export interface MergeArgsInput {
  rawVideo: string;
  manifest: TimingManifest;
  /** Resolved absolute audio file per narrated step, in step order (nulls for silent steps). */
  audioFiles: Array<string | null>;
  output: string;
  leadInMs: number;
  /** ms on the manifest clock where step playback starts (pre-roll trim point). */
  trimStartMs: number;
  /** ms into the raw video where the manifest clock's zero falls (calibration flash). */
  videoOffsetMs: number;
  /** Scale to this size in post (recording runs at deviceScaleFactor 2). */
  targetWidth: number;
  targetHeight: number;
  /** Burned-in captions: pre-rendered transparent PNGs with display windows (output-timeline ms). */
  captions?: {
    items: Array<{ file: string; startMs: number; endMs: number }>;
    bottomMarginPx: number;
  };
  /** Pre-built zoom stage (fps + zoompan) to insert after the trim; see post/zoom.ts. */
  zoomFilter?: string;
  /** ffmetadata file with chapter blocks; mapped into the MP4 as a chapter track. See post/chapters.ts. */
  chaptersFile?: string;
  /**
   * Intro/recap cards (#37): still PNGs held for durationMs and concatenated
   * around the body. The body keeps body-relative timing (captions, zoom, audio
   * delays) — the concat shifts it after the intro, so only the external
   * sidecars (srt, chapters) carry the intro offset. See post/cards.ts.
   */
  cards?: {
    intro?: { file: string; durationMs: number };
    recap?: { file: string; durationMs: number };
  };
  /** Idle speed-up retiming; see post/retime.ts. */
  retime?: {
    /** setpts filter implementing the time map. */
    filter: string;
    /** Map trimmed-timeline ms → retimed output ms (for audio delays). */
    mapMs: (ms: number) => number;
    /** Duration of the retimed output (replaces totalDuration - trimStart). */
    outputDurationMs: number;
    fps: number;
  };
}

/**
 * Build the single-invocation ffmpeg arg list that trims pre-roll, lays each
 * narration clip at its manifest offset over silence, downscales, and
 * transcodes to H.264/AAC. Pure function: tested by asserting on args.
 */
export function buildMergeArgs(input: MergeArgsInput): string[] {
  const { manifest, audioFiles, leadInMs, trimStartMs, videoOffsetMs } = input;
  const args: string[] = ['-y', '-i', input.rawVideo];

  const narrated: Array<{ inputIndex: number; delayMs: number }> = [];
  manifest.steps.forEach((s, i) => {
    const file = audioFiles[i];
    if (!file) return;
    args.push('-i', file);
    // Audio offsets are relative to the *trimmed* video start; with idle
    // speed-up they map through the retime (narration spans stay at 1x).
    const rawDelay = Math.max(0, s.startMs + leadInMs - trimStartMs);
    const delayMs = input.retime ? Math.round(input.retime.mapMs(rawDelay)) : rawDelay;
    narrated.push({ inputIndex: narrated.length + 1, delayMs });
  });

  const filters: string[] = [];
  const durationS = (
    (input.retime ? input.retime.outputDurationMs : manifest.totalDurationMs - trimStartMs) / 1000
  ).toFixed(3);

  // Video chain: trim pre-roll + post-tutorial tail (manifest clock shifted
  // into video time by the flash offset), reset timestamps, downscale.
  const videoTrimStartS = ((trimStartMs + videoOffsetMs) / 1000).toFixed(3);
  const videoTrimEndS = ((manifest.totalDurationMs + videoOffsetMs) / 1000).toFixed(3);
  const vf: string[] = [
    `trim=start=${videoTrimStartS}:end=${videoTrimEndS}`,
    'setpts=PTS-STARTPTS',
  ];
  if (input.retime) {
    vf.push(input.retime.filter);
    // Re-normalize to CFR (frames bunch up inside compressed spans) unless
    // the zoom stage follows — it begins with its own fps filter.
    if (!input.zoomFilter) vf.push(`fps=${input.retime.fps}`);
  }
  if (input.zoomFilter) vf.push(input.zoomFilter);
  vf.push(`scale=${input.targetWidth}:${input.targetHeight}:flags=lanczos`);

  // With cards, the body is one segment of a concat; keep it on its own
  // intermediate labels (vbody/abody) and let the concat below emit vout/aout.
  const hasIntro = !!input.cards?.intro;
  const hasRecap = !!input.cards?.recap;
  const hasCards = hasIntro || hasRecap;
  const vBody = hasCards ? 'vbody0' : 'vout';
  const aBody = hasCards ? 'abody' : 'aout';
  const fps = input.retime?.fps ?? manifest.fps;

  // Burned captions: one overlay per cue, after scale (and after zoom — the
  // captions must not be zoomed), each enabled for its display window. Windows
  // stay body-relative even with cards — the concat shifts them.
  const captionItems = input.captions?.items ?? [];
  filters.push(`[0:v]${vf.join(',')}[${captionItems.length ? 'vbase' : vBody}]`);
  captionItems.forEach((c, k) => {
    args.push('-i', c.file);
    const inputIndex = 1 + narrated.length + k;
    const from = `[${k === 0 ? 'vbase' : `vcap${k - 1}`}]`;
    const to = k === captionItems.length - 1 ? `[${vBody}]` : `[vcap${k}]`;
    filters.push(
      `${from}[${inputIndex}:v]overlay=(W-w)/2:H-h-${input.captions!.bottomMarginPx}:enable='between(t,${(c.startMs / 1000).toFixed(3)},${(c.endMs / 1000).toFixed(3)})'${to}`,
    );
  });

  // Chapters: an ffmetadata input (after every stream input so the indices the
  // filter graph references stay stable), mapped in below as a chapter track.
  let chaptersInputIndex = -1;
  if (input.chaptersFile) {
    chaptersInputIndex = 1 + narrated.length + captionItems.length;
    args.push('-f', 'ffmetadata', '-i', input.chaptersFile);
  }

  // Audio chain: silence base + each clip delayed to its slot, mixed.
  filters.push(
    `anullsrc=channel_layout=mono:sample_rate=48000,atrim=duration=${durationS}[abase]`,
  );
  const mixInputs = ['[abase]'];
  narrated.forEach(({ inputIndex, delayMs }, n) => {
    filters.push(`[${inputIndex}:a]adelay=${delayMs}:all=1[a${n}]`);
    mixInputs.push(`[a${n}]`);
  });
  if (narrated.length > 0) {
    filters.push(
      `${mixInputs.join('')}amix=inputs=${mixInputs.length}:duration=first:normalize=0[${aBody}]`,
    );
  } else {
    filters.push(`[abase]acopy[${aBody}]`);
  }

  // Cards (#37): normalize the body for concat, build each card from a looped
  // still + matching silence, and concat [intro?] body [recap?] → vout/aout.
  if (hasCards) {
    filters.push(`[vbody0]fps=${fps},format=yuv420p,setsar=1[vbody]`);
    let cardInput = 1 + narrated.length + captionItems.length + (input.chaptersFile ? 1 : 0);
    const segV: string[] = [];
    const segA: string[] = [];
    const addCard = (card: { file: string; durationMs: number }, v: string, a: string) => {
      const durS = (card.durationMs / 1000).toFixed(3);
      args.push('-loop', '1', '-framerate', String(fps), '-t', durS, '-i', card.file);
      filters.push(
        `[${cardInput++}:v]scale=${input.targetWidth}:${input.targetHeight}:flags=lanczos,fps=${fps},format=yuv420p,setsar=1[${v}]`,
      );
      filters.push(`anullsrc=channel_layout=mono:sample_rate=48000,atrim=duration=${durS}[${a}]`);
    };
    if (input.cards!.intro) { addCard(input.cards!.intro, 'vintro', 'aintro'); segV.push('[vintro]'); segA.push('[aintro]'); }
    segV.push('[vbody]'); segA.push('[abody]');
    if (input.cards!.recap) { addCard(input.cards!.recap, 'vrecap', 'arecap'); segV.push('[vrecap]'); segA.push('[arecap]'); }
    const pairs = segV.map((v, i) => `${v}${segA[i]}`).join('');
    filters.push(`${pairs}concat=n=${segV.length}:v=1:a=1[vout][aout]`);
  }

  args.push(
    '-filter_complex', filters.join(';'),
    '-map', '[vout]',
    '-map', '[aout]',
  );
  // Pull chapters (and only chapters — streams come from the filter graph) from
  // the ffmetadata input. -map_metadata carries its chapter blocks into the MP4.
  if (chaptersInputIndex >= 0) {
    args.push('-map_metadata', String(chaptersInputIndex));
  }
  args.push(
    '-c:v', 'libx264',
    '-crf', '18',
    '-preset', 'slow',
    '-pix_fmt', 'yuv420p',
    '-c:a', 'aac',
    '-b:a', '192k',
    '-movflags', '+faststart',
    input.output,
  );
  return args;
}

export async function runFfmpeg(args: string[]): Promise<void> {
  await run('ffmpeg', args);
}
