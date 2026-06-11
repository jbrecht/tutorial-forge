import { join } from 'node:path';
import { writeFile, rename, rm } from 'node:fs/promises';
import type { BrowserContext, CDPSession, Page } from 'playwright';
import { ensureDir } from '../util/fs.js';
import { runFfmpeg } from '../post/ffmpeg.js';
import { logger } from '../util/logger.js';

export type RecorderKind = 'video' | 'screencast';

/** What a recorder produced; stored in the manifest for the post phase. */
export interface CaptureInfo {
  recorder: RecorderKind;
  /** Raw video filename inside workDir. */
  rawFile: string;
  width: number;
  height: number;
  /**
   * True when the raw video's t=0 IS the recording clock's zero (screencast:
   * frames carry explicit timestamps). False → post must detect the
   * calibration flash to find the offset.
   */
  clockAligned: boolean;
}

export interface Recorder {
  readonly kind: RecorderKind;
  /** True if the record phase should paint the calibration flash. */
  readonly needsCalibrationFlash: boolean;
  /** Extra options for browser.newContext(). */
  contextOptions(): Record<string, unknown>;
  /** Attach capture to the page (no-op for recordVideo). */
  start(page: Page): Promise<void>;
  /** Stop capture, close the context, write the raw file into workDir. */
  finalize(
    page: Page,
    context: BrowserContext,
    clockZeroEpochMs: number,
    totalDurationMs: number,
  ): Promise<CaptureInfo>;
}

export interface RecorderOptions {
  workDir: string;
  viewport: { width: number; height: number };
  fps: number;
  /** Keep intermediate frames (debug). */
  keepFrames?: boolean;
}

export function createRecorder(kind: RecorderKind, opts: RecorderOptions): Recorder {
  return kind === 'screencast' ? new ScreencastRecorder(opts) : new VideoRecorder(opts);
}

/** Playwright recordVideo capture (the original path; needs flash calibration). */
class VideoRecorder implements Recorder {
  readonly kind = 'video' as const;
  readonly needsCalibrationFlash = true;
  constructor(private readonly opts: RecorderOptions) {}

  contextOptions(): Record<string, unknown> {
    return {
      recordVideo: { dir: join(this.opts.workDir, 'video'), size: this.opts.viewport },
    };
  }

  async start(): Promise<void> {
    /* capture starts with the context */
  }

  async finalize(page: Page, context: BrowserContext): Promise<CaptureInfo> {
    const video = page.video();
    await context.close(); // flushes the webm
    if (!video) throw new Error('Playwright returned no video — recordVideo was not active');
    const rawFile = 'raw.webm';
    await rename(await video.path(), join(this.opts.workDir, rawFile));
    return {
      recorder: 'video',
      rawFile,
      width: this.opts.viewport.width,
      height: this.opts.viewport.height,
      clockAligned: false,
    };
  }
}

/**
 * CDP screencast capture: every frame carries an explicit epoch timestamp, so
 * the assembled video starts exactly at the recording clock's zero — no
 * calibration flash needed. Frames arrive only when content changes (VFR);
 * assembly extends each frame to the next timestamp via the concat demuxer.
 *
 * Note: Chromium delivers screencast frames at CSS-viewport size regardless
 * of deviceScaleFactor (verified empirically), so this recorder does not (yet)
 * provide high-DPI capture. Playwright 1.60 also has a public page.screencast
 * API, but its onFrame callback omits timestamps — CDP is used instead.
 */
class ScreencastRecorder implements Recorder {
  readonly kind = 'screencast' as const;
  readonly needsCalibrationFlash = false;
  private session: CDPSession | null = null;
  private frames: Array<{ file: string; tsMs: number }> = [];
  private writes: Promise<unknown>[] = [];
  private framesDir: string;

  constructor(private readonly opts: RecorderOptions) {
    this.framesDir = join(opts.workDir, 'frames');
  }

  contextOptions(): Record<string, unknown> {
    return {};
  }

  async start(page: Page): Promise<void> {
    await ensureDir(this.framesDir);
    this.session = await page.context().newCDPSession(page);
    this.session.on('Page.screencastFrame', (event) => {
      if (event.metadata.timestamp === undefined) return; // unusable without a timestamp
      const seq = this.frames.length + 1;
      const file = join(this.framesDir, `frame-${String(seq).padStart(5, '0')}.jpg`);
      this.frames.push({ file, tsMs: event.metadata.timestamp * 1000 });
      this.writes.push(writeFile(file, Buffer.from(event.data, 'base64')));
      this.session?.send('Page.screencastFrameAck', { sessionId: event.sessionId }).catch(() => {});
    });
    await this.session.send('Page.startScreencast', {
      format: 'jpeg',
      quality: 90,
      maxWidth: this.opts.viewport.width,
      maxHeight: this.opts.viewport.height,
      everyNthFrame: 1,
    });
  }

  async finalize(
    _page: Page,
    context: BrowserContext,
    clockZeroEpochMs: number,
    totalDurationMs: number,
  ): Promise<CaptureInfo> {
    try {
      await this.session?.send('Page.stopScreencast');
    } catch {
      /* session may be gone */
    }
    await Promise.all(this.writes);
    await context.close();
    if (this.frames.length === 0) throw new Error('screencast produced no frames');

    const list = buildConcatList(this.frames, clockZeroEpochMs, totalDurationMs);
    const listFile = join(this.opts.workDir, 'frames.ffconcat');
    await writeFile(listFile, list);

    const rawFile = 'raw-screencast.mp4';
    logger.debug(`screencast: assembling ${this.frames.length} frames`);
    await runFfmpeg(buildAssembleArgs(listFile, this.opts.fps, join(this.opts.workDir, rawFile)));
    if (!this.opts.keepFrames) await rm(this.framesDir, { recursive: true, force: true });

    return {
      recorder: 'screencast',
      rawFile,
      width: this.opts.viewport.width,
      height: this.opts.viewport.height,
      clockAligned: true,
    };
  }
}

/**
 * Build the ffconcat list placing each frame at its clock offset. Frames
 * before clock zero collapse to the t=0 frame; the last frame extends to the
 * end of the recording. Pure function.
 */
export function buildConcatList(
  frames: Array<{ file: string; tsMs: number }>,
  clockZeroEpochMs: number,
  totalDurationMs: number,
): string {
  const rel = frames
    .map((f) => ({ file: f.file, atMs: f.tsMs - clockZeroEpochMs }))
    .sort((a, b) => a.atMs - b.atMs);
  // Keep only the last pre-zero frame; it becomes the content at t=0.
  const lastPreZero = rel.filter((f) => f.atMs <= 0).pop();
  const visible = [...(lastPreZero ? [{ ...lastPreZero, atMs: 0 }] : []), ...rel.filter((f) => f.atMs > 0)];
  if (visible.length === 0) throw new Error('no screencast frames after clock zero');
  // First visible frame defines t=0 even if captured later.
  visible[0] = { ...visible[0]!, atMs: 0 };

  const lines = ['ffconcat version 1.0'];
  for (let i = 0; i < visible.length; i++) {
    const cur = visible[i]!;
    const endMs = i + 1 < visible.length ? visible[i + 1]!.atMs : Math.max(totalDurationMs, cur.atMs + 40);
    lines.push(`file '${cur.file}'`);
    lines.push(`duration ${((endMs - cur.atMs) / 1000).toFixed(3)}`);
  }
  // concat demuxer quirk: repeat the last file so its duration is honored.
  lines.push(`file '${visible[visible.length - 1]!.file}'`);
  return lines.join('\n') + '\n';
}

/** ffmpeg invocation assembling the concat list into a CFR intermediate. */
export function buildAssembleArgs(listFile: string, fps: number, output: string): string[] {
  return [
    '-y',
    '-f', 'concat',
    '-safe', '0',
    '-i', listFile,
    '-vf', `fps=${fps}`,
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-crf', '15',
    '-pix_fmt', 'yuv420p',
    output,
  ];
}
