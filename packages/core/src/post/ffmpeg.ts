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
 * Parse signalstats metadata=print output. Frames arrive as
 *   frame:N pts:P pts_time:T
 *   lavfi.signalstats.UAVG=...
 *   lavfi.signalstats.VAVG=...
 * A full-frame magenta (#ff00ff) flash measures UAVG≈201 / VAVG≈221 in
 * Chromium's VP8 webm; we accept anything with both chroma averages far from
 * neutral (128) in the magenta direction.
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
      if (uavg > 180 && vavg > 170) return Math.round(ptsTime * 1000);
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
  /** Burn this .srt into the video, if set. */
  burnSrt?: string;
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
    // Audio offsets are relative to the *trimmed* video start.
    const delayMs = Math.max(0, s.startMs + leadInMs - trimStartMs);
    narrated.push({ inputIndex: narrated.length + 1, delayMs });
  });

  const filters: string[] = [];
  const durationS = ((manifest.totalDurationMs - trimStartMs) / 1000).toFixed(3);

  // Video chain: trim pre-roll + post-tutorial tail (manifest clock shifted
  // into video time by the flash offset), reset timestamps, downscale.
  const videoTrimStartS = ((trimStartMs + videoOffsetMs) / 1000).toFixed(3);
  const videoTrimEndS = ((manifest.totalDurationMs + videoOffsetMs) / 1000).toFixed(3);
  const vf: string[] = [
    `trim=start=${videoTrimStartS}:end=${videoTrimEndS}`,
    'setpts=PTS-STARTPTS',
  ];
  vf.push(`scale=${input.targetWidth}:${input.targetHeight}:flags=lanczos`);
  if (input.burnSrt) {
    vf.push(`subtitles=${escapeFilterPath(input.burnSrt)}`);
  }
  filters.push(`[0:v]${vf.join(',')}[vout]`);

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
      `${mixInputs.join('')}amix=inputs=${mixInputs.length}:duration=first:normalize=0[aout]`,
    );
  } else {
    filters.push('[abase]acopy[aout]');
  }

  args.push(
    '-filter_complex', filters.join(';'),
    '-map', '[vout]',
    '-map', '[aout]',
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

/** ffmpeg filter args need ':' and '\' escaped inside path values. */
function escapeFilterPath(p: string): string {
  return `'${p.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/:/g, '\\:')}'`;
}

export async function runFfmpeg(args: string[]): Promise<void> {
  await run('ffmpeg', args);
}
