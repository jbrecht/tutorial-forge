import { join, dirname, basename, extname } from 'node:path';
import { writeFile } from 'node:fs/promises';
import type { TimingManifest } from '../types.js';
import { RAW_VIDEO_FILE, FLASH_MS } from './record.js';
import { buildMergeArgs, detectFlashOffsetMs, probeDurationMs, runFfmpeg } from '../post/ffmpeg.js';
import { computeCues, generateSrt } from '../post/subtitles.js';
import { DEFAULT_CAPTION_STYLE, renderCaptionImages, type CaptionImage } from '../post/captions.js';
import { buildGifArgs, resolveGifWindow, DEFAULT_GIF, type GifConfig } from '../post/gif.js';
import { buildZoomFilter, computeZoomWindows, DEFAULT_ZOOM_FACTOR } from '../post/zoom.js';
import {
  buildRetimeFilter,
  buildTimeMap,
  computeIdleSegments,
  DEFAULT_IDLE_SPEEDUP,
  type TimeMap,
} from '../post/retime.js';
import { ensureDir, exists } from '../util/fs.js';
import { logger } from '../util/logger.js';

export interface PostPhaseOptions {
  workDir: string;
  output: string;
  viewport: { width: number; height: number };
  subtitles: 'burn' | 'sidecar' | 'off';
  leadInMs: number;
  zoom?: boolean | { factor?: number };
  idleSpeedup?: boolean | { maxIdleMs?: number; speed?: number };
  /** Styling for burned-in captions (subtitles: 'burn'). */
  captionStyle?: Partial<typeof DEFAULT_CAPTION_STYLE>;
  /** Also export an animated GIF (captioned by default). */
  gif?: boolean | Partial<GifConfig>;
}

export interface PostPhaseResult {
  output: string;
  srtPath: string | null;
  gifPath: string | null;
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
  const rawFile = manifest.capture?.rawFile ?? RAW_VIDEO_FILE;
  const rawVideo = join(opts.workDir, rawFile);
  if (!(await exists(rawVideo))) {
    throw new Error(`No ${rawFile} in ${opts.workDir} — run the record phase first`);
  }

  const firstStep = manifest.steps[0];
  if (!firstStep) throw new Error('Manifest has no steps');
  // Never trim before the calibration flash has fully cleared (plus a couple
  // of frames of margin), or magenta frames leak into the output.
  const trimStartMs = Math.max(FLASH_MS + 200, firstStep.startMs - opts.leadInMs);

  let videoOffsetMs: number;
  if (manifest.capture?.clockAligned) {
    // Screencast capture: frames carry explicit timestamps; t=0 IS clock zero.
    videoOffsetMs = 0;
  } else {
    const detected = await detectFlashOffsetMs(rawVideo);
    if (detected === null) {
      logger.warn(
        'calibration flash not found in recording — assuming video starts at clock zero; audio sync may drift by the context-creation gap',
      );
      videoOffsetMs = 0;
    } else {
      videoOffsetMs = detected;
      logger.debug(`calibration flash at ${videoOffsetMs}ms into raw video`);
    }
  }
  manifest.videoClockOffsetMs = videoOffsetMs;

  await ensureDir(dirname(opts.output));

  // Idle speed-up: compress narration-free spans; everything downstream
  // (audio delays, subtitles, zoom windows) maps through the same time map.
  let timeMap: TimeMap | null = null;
  if (opts.idleSpeedup) {
    const config = {
      ...DEFAULT_IDLE_SPEEDUP,
      ...(typeof opts.idleSpeedup === 'object' ? opts.idleSpeedup : {}),
    };
    const segments = computeIdleSegments(manifest, trimStartMs, opts.leadInMs, config);
    if (segments.length > 0) {
      timeMap = buildTimeMap(segments, (manifest.totalDurationMs - trimStartMs) / 1000);
      const savedS = (manifest.totalDurationMs - trimStartMs) / 1000 - timeMap.outputDurationS;
      logger.info(
        `post: idle speed-up — ${segments.length} span(s) at ${config.speed}x, saving ${savedS.toFixed(1)}s`,
      );
    }
  }
  const mapMs = timeMap ? (ms: number) => timeMap!.mapS(ms / 1000) * 1000 : undefined;

  let srtPath: string | null = null;
  if (opts.subtitles === 'sidecar') {
    const srt = generateSrt(manifest, { leadInMs: opts.leadInMs, trimStartMs, mapMs });
    srtPath = join(dirname(opts.output), basename(opts.output, extname(opts.output)) + '.srt');
    await writeFile(srtPath, srt);
  }

  // Burned captions: browser-rendered pills composited per cue window —
  // works on every ffmpeg build (no libass needed) and styles with CSS.
  let captionImages: CaptionImage[] = [];
  if (opts.subtitles === 'burn') {
    const cues = computeCues(manifest, { leadInMs: opts.leadInMs, trimStartMs, mapMs });
    const style = { ...DEFAULT_CAPTION_STYLE, ...opts.captionStyle };
    captionImages = await renderCaptionImages(cues, style, join(opts.workDir, 'captions'), opts.viewport.width);
    logger.info(`post: burning ${captionImages.length} caption(s)`);
  }

  let zoomFilter: string | undefined;
  if (opts.zoom) {
    const factor = (typeof opts.zoom === 'object' && opts.zoom.factor) || DEFAULT_ZOOM_FACTOR;
    // With a retime active, express callouts on the retimed output timeline
    // (atMs trim-relative + mapped, trimStart 0, output duration).
    const callouts = manifest.steps
      .flatMap((s) => s.callouts)
      .map((c) => (mapMs ? { ...c, atMs: mapMs(c.atMs - trimStartMs) } : c));
    const windows = computeZoomWindows(
      callouts,
      mapMs ? 0 : trimStartMs,
      mapMs && timeMap ? timeMap.outputDurationS * 1000 : manifest.totalDurationMs,
    );
    zoomFilter = buildZoomFilter(windows, factor, opts.viewport.width, opts.viewport.height, manifest.fps) ?? undefined;
    if (zoomFilter) logger.info(`post: zooming on ${windows.length} callout(s) (factor ${factor})`);
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
    captions: captionImages.length
      ? {
          items: captionImages,
          bottomMarginPx: opts.captionStyle?.bottomMarginPx ?? DEFAULT_CAPTION_STYLE.bottomMarginPx,
        }
      : undefined,
    zoomFilter,
    retime:
      timeMap && mapMs
        ? {
            filter: buildRetimeFilter(timeMap),
            mapMs,
            outputDurationMs: timeMap.outputDurationS * 1000,
            fps: manifest.fps,
          }
        : undefined,
  });
  logger.info('post: merging audio + video (ffmpeg)');
  await runFfmpeg(args);

  const outputDurationMs = await probeDurationMs(opts.output);
  logger.info(`post: wrote ${opts.output} (${(outputDurationMs / 1000).toFixed(1)}s)`);

  let gifPath: string | null = null;
  if (opts.gif) {
    const gifConfig = { ...DEFAULT_GIF, ...(typeof opts.gif === 'object' ? opts.gif : {}) };
    const window = gifConfig.steps
      ? resolveGifWindow(manifest, trimStartMs, gifConfig.steps, mapMs)
      : undefined;
    // GIFs are silent — burn captions unless the video already has them.
    let gifCaptions: { items: CaptionImage[]; bottomMarginPx: number } | undefined;
    if (gifConfig.captions && opts.subtitles !== 'burn') {
      const cues = computeCues(manifest, { leadInMs: opts.leadInMs, trimStartMs, mapMs }).filter(
        (c) => !window || (c.endMs > window.startMs && c.startMs < window.endMs),
      );
      const style = { ...DEFAULT_CAPTION_STYLE, ...opts.captionStyle };
      gifCaptions = {
        items: await renderCaptionImages(cues, style, join(opts.workDir, 'captions-gif'), opts.viewport.width),
        bottomMarginPx: style.bottomMarginPx,
      };
    }
    gifPath = join(dirname(opts.output), basename(opts.output, extname(opts.output)) + '.gif');
    await runFfmpeg(
      buildGifArgs({
        source: opts.output,
        output: gifPath,
        widthPx: gifConfig.widthPx,
        fps: gifConfig.fps,
        window,
        captions: gifCaptions,
      }),
    );
    logger.info(`post: wrote ${gifPath}${window ? ` (steps ${gifConfig.steps})` : ''}`);
  }

  return {
    output: opts.output,
    srtPath: opts.subtitles === 'sidecar' ? srtPath : null,
    gifPath,
    videoClockOffsetMs: videoOffsetMs,
    outputDurationMs,
  };
}
