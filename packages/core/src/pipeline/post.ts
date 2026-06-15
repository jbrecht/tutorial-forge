import { join, dirname, basename, extname } from 'node:path';
import { writeFile } from 'node:fs/promises';
import type { TimingManifest } from '../types.js';
import { RAW_VIDEO_FILE, FLASH_MS } from './record.js';
import { buildMergeArgs, detectFlashOffsetMs, probeDurationMs, runFfmpeg } from '../post/ffmpeg.js';
import { computeCues, generateSrt } from '../post/subtitles.js';
import {
  computeChapters,
  enforceMinChapterDuration,
  generateChaptersVtt,
  generateChaptersTxt,
  generateChaptersFfmetadata,
  shiftChapters,
  YOUTUBE_MIN_CHAPTER_MS,
  type Chapter,
} from '../post/chapters.js';
import { DEFAULT_CAPTION_STYLE, renderCaptionImages, type CaptionImage } from '../post/captions.js';
import { cardContentsFor, renderCards, type RenderedCard } from '../post/cards.js';
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
  /** Emit chapter markers (MP4 chapter track + .chapters.vtt/.txt sidecars). Default true. */
  chapters?: boolean;
  /**
   * Intro/recap card text (#37). When present (and not disabled), cards are
   * composited around the body and their durations fold into the timeline.
   */
  cards?: { title: string; objectives?: string[]; summary?: string };
}

export interface PostPhaseResult {
  output: string;
  srtPath: string | null;
  gifPath: string | null;
  chaptersVttPath: string | null;
  chaptersTxtPath: string | null;
  videoClockOffsetMs: number;
  outputDurationMs: number;
  /** Total ms of intro+recap cards composited into the output (#37); 0 when none. */
  cardsDurationMs: number;
}

/** Resolved card files + durations passed to the ffmpeg merge (#37). */
type PostMergeCards = {
  intro?: { file: string; durationMs: number };
  recap?: { file: string; durationMs: number };
};

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
  // Sidecar paths share the output's directory and base name (foo.mp4 → foo.srt).
  const base = (ext: string) => join(dirname(opts.output), basename(opts.output, extname(opts.output)) + ext);

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
    } else {
      logger.info(`post: idle speed-up — no spans over ${config.maxIdleMs}ms`);
    }
  }
  const mapMs = timeMap ? (ms: number) => timeMap!.mapS(ms / 1000) * 1000 : undefined;

  // Cards (#37): render the intro/recap slates first so their durations are
  // known before laying out the sidecars. An intro card slides the whole body
  // forward inside the final file, so every final-file timestamp (SRT, chapters,
  // any GIF excerpt) is offset by introDurationMs. The body sub-graph itself
  // stays body-relative — the ffmpeg concat does the shifting.
  let mergeCards: PostMergeCards | undefined;
  let introDurationMs = 0;
  let recapDurationMs = 0;
  if (opts.cards) {
    const contents = cardContentsFor(opts.cards);
    if (contents) {
      const toRender = [contents.intro, contents.recap].filter(
        (c): c is NonNullable<typeof c> => !!c,
      );
      const rendered: RenderedCard[] = await renderCards(toRender, join(opts.workDir, 'cards'), opts.viewport);
      const intro = rendered.find((c) => c.kind === 'intro');
      const recap = rendered.find((c) => c.kind === 'recap');
      introDurationMs = intro?.durationMs ?? 0;
      recapDurationMs = recap?.durationMs ?? 0;
      mergeCards = {
        intro: intro && { file: intro.file, durationMs: intro.durationMs },
        recap: recap && { file: recap.file, durationMs: recap.durationMs },
      };
      logger.info(
        `post: cards — ${[intro && 'intro', recap && 'recap'].filter(Boolean).join(' + ')} (${((introDurationMs + recapDurationMs) / 1000).toFixed(1)}s)`,
      );
    }
  }
  const cardsDurationMs = introDurationMs + recapDurationMs;

  let srtPath: string | null = null;
  if (opts.subtitles === 'sidecar') {
    const srt = generateSrt(manifest, { leadInMs: opts.leadInMs, trimStartMs, mapMs, offsetMs: introDurationMs });
    srtPath = base('.srt');
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

  // Chapters: a new consumer of the manifest's per-step boundaries, on the same
  // (trimmed, retimed) output timeline as cues. Emits an MP4 chapter track plus
  // web (.vtt) and paste-into-description (.txt) sidecars. Segmenting principle.
  let chaptersVttPath: string | null = null;
  let chaptersTxtPath: string | null = null;
  let chaptersFile: string | undefined;
  if (opts.chapters ?? true) {
    const timelineDurationMs = timeMap
      ? timeMap.outputDurationS * 1000
      : manifest.totalDurationMs - trimStartMs;
    const bodyChapters = computeChapters(manifest, {
      trimStartMs,
      mapMs,
      outputDurationMs: timelineDurationMs,
    });
    // Slide body chapters past the intro card and bookend with card chapters so
    // markers land on the composed final-file timeline (#37).
    const chapters: Chapter[] = [];
    if (mergeCards?.intro) {
      chapters.push({ id: '__intro__', title: 'Objectives', startMs: 0, endMs: introDurationMs });
    }
    chapters.push(...shiftChapters(bodyChapters, introDurationMs));
    if (mergeCards?.recap) {
      const recapStartMs = introDurationMs + timelineDurationMs;
      chapters.push({ id: '__recap__', title: 'Recap', startMs: recapStartMs, endMs: recapStartMs + recapDurationMs });
    }
    if (chapters.length > 0) {
      chaptersVttPath = base('.chapters.vtt');
      chaptersTxtPath = base('.chapters.txt');
      // The MP4 track and the .vtt (Vimeo/web) keep the full per-step list —
      // those players have no minimum-chapter rule. The YouTube .txt is folded
      // to clear YouTube's ≥10s floor, which otherwise silently disables the
      // whole description chapter list (including the Objectives/Recap cards).
      await writeFile(chaptersVttPath, generateChaptersVtt(chapters));
      await writeFile(
        chaptersTxtPath,
        generateChaptersTxt(enforceMinChapterDuration(chapters, YOUTUBE_MIN_CHAPTER_MS)),
      );
      chaptersFile = join(opts.workDir, 'chapters.ffmeta');
      await writeFile(chaptersFile, generateChaptersFfmetadata(chapters));
      logger.info(`post: ${chapters.length} chapter(s) → ${basename(chaptersVttPath)} + MP4 markers`);
    }
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
    chaptersFile,
    cards: mergeCards,
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
    // The GIF reads the composed final file, so a step excerpt and its captions
    // carry the same intro-card offset as everything else on that timeline (#37).
    let window = gifConfig.steps ? resolveGifWindow(manifest, trimStartMs, gifConfig.steps, mapMs) : undefined;
    if (window && introDurationMs) {
      window = { startMs: window.startMs + introDurationMs, endMs: window.endMs + introDurationMs };
    }
    // GIFs are silent — burn captions unless the video already has them.
    let gifCaptions: { items: CaptionImage[]; bottomMarginPx: number } | undefined;
    if (gifConfig.captions && opts.subtitles !== 'burn') {
      const cues = computeCues(manifest, {
        leadInMs: opts.leadInMs,
        trimStartMs,
        mapMs,
        offsetMs: introDurationMs,
      }).filter((c) => !window || (c.endMs > window.startMs && c.startMs < window.endMs));
      const style = { ...DEFAULT_CAPTION_STYLE, ...opts.captionStyle };
      gifCaptions = {
        items: await renderCaptionImages(cues, style, join(opts.workDir, 'captions-gif'), opts.viewport.width),
        bottomMarginPx: style.bottomMarginPx,
      };
    }
    gifPath = base('.gif');
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
    chaptersVttPath,
    chaptersTxtPath,
    videoClockOffsetMs: videoOffsetMs,
    outputDurationMs,
    cardsDurationMs,
  };
}
