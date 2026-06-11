import { join, dirname, basename, extname } from 'node:path';
import { writeFile } from 'node:fs/promises';
import type { TimingManifest } from '../types.js';
import { RAW_VIDEO_FILE, FLASH_MS } from './record.js';
import { buildMergeArgs, detectFlashOffsetMs, probeDurationMs, runFfmpeg } from '../post/ffmpeg.js';
import { generateSrt } from '../post/subtitles.js';
import { ensureDir, exists } from '../util/fs.js';
import { logger } from '../util/logger.js';

export interface PostPhaseOptions {
  workDir: string;
  output: string;
  viewport: { width: number; height: number };
  subtitles: 'burn' | 'sidecar' | 'off';
  leadInMs: number;
}

export interface PostPhaseResult {
  output: string;
  srtPath: string | null;
  videoClockOffsetMs: number;
  outputDurationMs: number;
}

/**
 * Phase 3 — single ffmpeg invocation: trim pre-roll/tail, lay narration over
 * silence at manifest offsets, downscale 2x→1x, transcode to H.264/AAC.
 */
export async function runPostPhase(
  manifest: TimingManifest,
  opts: PostPhaseOptions,
): Promise<PostPhaseResult> {
  const rawVideo = join(opts.workDir, RAW_VIDEO_FILE);
  if (!(await exists(rawVideo))) {
    throw new Error(`No ${RAW_VIDEO_FILE} in ${opts.workDir} — run the record phase first`);
  }

  const firstStep = manifest.steps[0];
  if (!firstStep) throw new Error('Manifest has no steps');
  // Never trim before the calibration flash has fully cleared (plus a couple
  // of frames of margin), or magenta frames leak into the output.
  const trimStartMs = Math.max(FLASH_MS + 200, firstStep.startMs - opts.leadInMs);

  let videoOffsetMs = await detectFlashOffsetMs(rawVideo);
  if (videoOffsetMs === null) {
    logger.warn(
      'calibration flash not found in recording — assuming video starts at clock zero; audio sync may drift by the context-creation gap',
    );
    videoOffsetMs = 0;
  } else {
    logger.debug(`calibration flash at ${videoOffsetMs}ms into raw video`);
  }
  manifest.videoClockOffsetMs = videoOffsetMs;

  await ensureDir(dirname(opts.output));

  let srtPath: string | null = null;
  if (opts.subtitles !== 'off') {
    const srt = generateSrt(manifest, { leadInMs: opts.leadInMs, trimStartMs });
    srtPath =
      opts.subtitles === 'sidecar'
        ? join(dirname(opts.output), basename(opts.output, extname(opts.output)) + '.srt')
        : join(opts.workDir, 'subtitles.srt');
    await writeFile(srtPath, srt);
  }

  const args = buildMergeArgs({
    rawVideo,
    manifest,
    audioFiles: manifest.steps.map((s) => s.audioFile),
    output: opts.output,
    leadInMs: opts.leadInMs,
    trimStartMs,
    videoOffsetMs,
    targetWidth: opts.viewport.width,
    targetHeight: opts.viewport.height,
    burnSrt: opts.subtitles === 'burn' && srtPath ? srtPath : undefined,
  });
  logger.info('post: merging audio + video (ffmpeg)');
  await runFfmpeg(args);

  const outputDurationMs = await probeDurationMs(opts.output);
  logger.info(`post: wrote ${opts.output} (${(outputDurationMs / 1000).toFixed(1)}s)`);
  return {
    output: opts.output,
    srtPath: opts.subtitles === 'sidecar' ? srtPath : null,
    videoClockOffsetMs: videoOffsetMs,
    outputDurationMs,
  };
}
