import { join } from 'node:path';
import { writeFile, readFile } from 'node:fs/promises';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { createRecorder, type CaptureInfo, type RecorderKind } from './recorder.js';
import type { CalloutRecord, FailureArtifacts, TimingManifest, Tutorial, TutorialAdapter } from '../types.js';
import { StepError } from '../types.js';
import { ConsoleCapture } from '../browser/console.js';
import { stepId } from '../spec.js';
import type { TTSPhaseResult } from './tts.js';
import { CURSOR_INIT_SCRIPT } from '../browser/cursor.js';
import { CALLOUT_INIT_SCRIPT } from '../browser/callout.js';
import { RecordingClock, stepHoldUntilMs } from '../browser/timing.js';
import { instrumentPage } from '../browser/instrument.js';
import { ensureDir } from '../util/fs.js';
import { logger } from '../util/logger.js';

export const RAW_VIDEO_FILE = 'raw.webm';
export const MANIFEST_FILE = 'manifest.json';
/** Calibration flash duration; the post phase must never trim inside it. */
export const FLASH_MS = 120;
const FINAL_HOLD_MS = 1000;
/** Gap after the flash before setup, so the trim point can't land in the flash. */
const POST_FLASH_HOLD_MS = 400;

export interface RecordPhaseOptions {
  workDir: string;
  viewport: { width: number; height: number };
  headless: boolean;
  cursor: boolean;
  callouts: boolean;
  leadInMs: number;
  /** Language being rendered; exposed to adapter and step callbacks via ctx. */
  lang?: string;
  /** Capture implementation; default 'video'. */
  recorder?: RecorderKind;
  /** Debug mode: Playwright trace, full console log, per-step screenshots. */
  debug?: boolean;
}

/**
 * Phase 2 — drive the browser through the tutorial while Playwright records
 * video, pacing each step to its narration budget. Writes raw.webm and
 * manifest.json into workDir.
 */
export async function runRecordPhase(
  tutorial: Tutorial,
  adapter: TutorialAdapter,
  tts: TTSPhaseResult,
  opts: RecordPhaseOptions,
): Promise<TimingManifest> {
  await ensureDir(opts.workDir);
  const recorder = createRecorder(opts.recorder ?? 'video', {
    workDir: opts.workDir,
    viewport: opts.viewport,
    fps: 25,
    keepFrames: opts.debug,
  });

  const browser = await launchChromium(opts.headless);
  try {
    // Capture happens at CSS-viewport size with either recorder (Chromium
    // delivers screencast frames in DIP; recordVideo pads larger sizes).
    // deviceScaleFactor 2 still sharpens text: Chromium rasterizes at 2x and
    // downscales into the captured frame.
    const context = await browser.newContext({
      viewport: opts.viewport,
      deviceScaleFactor: 2,
      ...recorder.contextOptions(),
    });
    if (opts.cursor) await context.addInitScript(CURSOR_INIT_SCRIPT);
    if (opts.callouts || opts.cursor) await context.addInitScript(CALLOUT_INIT_SCRIPT);
    if (opts.debug) {
      await context.tracing.start({ screenshots: true, snapshots: true });
    }

    const page = await context.newPage();
    const consoleLog = new ConsoleCapture();
    consoleLog.attach(page);
    await recorder.start(page);
    const clock = new RecordingClock();

    await page.goto('about:blank');
    await page.waitForTimeout(250);
    clock.zero();
    if (recorder.needsCalibrationFlash) {
      // Calibration flash: paint a magenta frame the post phase can find to
      // align the manifest clock with the video's first frame. (Screencast
      // capture has explicit frame timestamps and skips this entirely.)
      await page.evaluate((ms) => {
        document.documentElement.style.background = '#ff00ff';
        return new Promise<void>((resolve) =>
          setTimeout(() => {
            document.documentElement.style.background = '';
            resolve();
          }, ms),
        );
      }, FLASH_MS);
      // Keep the flash clear of the trim point even when setup is instant:
      // post trims at steps[0].startMs - leadInMs, which without this hold
      // can land inside the flash and leave magenta frames in the output.
      await page.waitForTimeout(POST_FLASH_HOLD_MS);
    }

    const ctx = { lang: opts.lang };
    logger.info(`record: setup (${adapter.baseURL})${opts.lang ? ` [${opts.lang}]` : ''}`);
    await adapter.setup(page, ctx);
    // The final video begins leadInMs before step 1. Hold past that window
    // now so it shows the settled app, not the tail end of setup.
    await page.waitForTimeout(opts.leadInMs + 200);

    const callouts: CalloutRecord[][] = tutorial.steps.map(() => []);
    let currentStep = 0;
    const instrumented = instrumentPage(page, {
      cursor: opts.cursor,
      callouts: opts.callouts,
      nowMs: () => clock.now(),
      onCallout: (c) => callouts[currentStep]?.push(c),
    });

    const manifestSteps: TimingManifest['steps'] = [];
    for (let i = 0; i < tutorial.steps.length; i++) {
      currentStep = i;
      const step = tutorial.steps[i]!;
      const id = stepId(step, i);
      const audio = tts.steps[i];
      if (!audio || audio.id !== id) {
        throw new Error(`tts.json is stale (step ${i}: expected "${id}", got "${audio?.id}") — re-run the tts phase`);
      }

      const startMs = clock.now();
      logger.info(`record: step ${i + 1}/${tutorial.steps.length} "${id}"`);
      consoleLog.mark(`step ${i + 1} "${id}"`);
      await page.waitForTimeout(opts.leadInMs);

      if (opts.debug) await debugScreenshot(page, opts.workDir, `${id}-before`);
      const actionStartMs = clock.now();
      try {
        await step.run(instrumented as Page, ctx);
        await step.waitFor?.(instrumented as Page, ctx);
      } catch (cause) {
        const artifacts = await captureFailure(page, context, opts, id, consoleLog);
        await saveManifest(tutorial, clock, manifestSteps, opts.workDir, opts.lang);
        await safeClose(context.close());
        throw new StepError(tutorial.id, id, cause, artifacts);
      }
      const actionEndMs = clock.now();
      if (opts.debug) await debugScreenshot(page, opts.workDir, `${id}-after`);

      const holdUntil = stepHoldUntilMs({
        startMs,
        leadInMs: opts.leadInMs,
        audioDurationMs: audio.audioDurationMs,
        actionEndMs,
        settleMs: step.settleMs ?? 400,
      });
      const remaining = holdUntil - clock.now();
      if (remaining > 0) await page.waitForTimeout(remaining);

      manifestSteps.push({
        id,
        narration: step.narration,
        audioFile: audio.audioFile,
        audioDurationMs: audio.audioDurationMs,
        startMs,
        actionStartMs,
        actionEndMs,
        endMs: clock.now(),
        callouts: callouts[i]!,
      });
    }

    await page.waitForTimeout(FINAL_HOLD_MS);
    const totalDurationMs = clock.now();

    if (adapter.teardown) {
      try {
        await adapter.teardown(page, ctx);
      } catch (err) {
        logger.warn(`teardown failed (ignored): ${err instanceof Error ? err.message : err}`);
      }
    }

    if (opts.debug) {
      await writeFile(join(opts.workDir, 'console.log'), consoleLog.all().join('\n') + '\n');
      await stopTracing(context, join(opts.workDir, 'trace.zip'));
      logger.info(`debug: console.log and trace.zip written to ${opts.workDir}`);
    }

    const capture = await recorder.finalize(page, context, clock.zeroEpoch, totalDurationMs);
    return saveManifest(tutorial, clock, manifestSteps, opts.workDir, opts.lang, capture, totalDurationMs);
  } finally {
    await safeClose(browser.close());
  }
}

async function launchChromium(headless: boolean): Promise<Browser> {
  try {
    return await chromium.launch({ headless, channel: 'chromium' });
  } catch {
    // 'chromium' channel (new headless) not installed; default build works too.
    return chromium.launch({ headless });
  }
}

async function saveManifest(
  tutorial: Tutorial,
  clock: RecordingClock,
  steps: TimingManifest['steps'],
  workDir: string,
  lang?: string,
  capture?: CaptureInfo,
  totalDurationMs?: number,
): Promise<TimingManifest> {
  const manifest: TimingManifest = {
    tutorialId: tutorial.id,
    ...(lang ? { lang } : {}),
    ...(capture ? { capture } : {}),
    fps: 25,
    recordingStartEpochMs: clock.zeroEpoch,
    steps,
    totalDurationMs: totalDurationMs ?? clock.now(),
  };
  await writeFile(join(workDir, MANIFEST_FILE), JSON.stringify(manifest, null, 2));
  return manifest;
}

async function captureFailure(
  page: Page,
  context: BrowserContext,
  opts: RecordPhaseOptions,
  id: string,
  consoleLog: ConsoleCapture,
): Promise<FailureArtifacts> {
  const artifacts: FailureArtifacts = {
    screenshot: null,
    consoleLog: null,
    trace: null,
    workDir: opts.workDir,
  };
  try {
    const path = join(opts.workDir, `failure-${id}.png`);
    await page.screenshot({ path });
    artifacts.screenshot = path;
  } catch {
    /* page may already be unusable */
  }
  try {
    const path = join(opts.workDir, `failure-${id}-console.log`);
    await writeFile(path, consoleLog.recent().join('\n') + '\n');
    artifacts.consoleLog = path;
  } catch {
    /* best effort */
  }
  if (opts.debug) {
    const path = join(opts.workDir, 'trace.zip');
    if (await stopTracing(context, path)) artifacts.trace = path;
  }
  logger.error(`record: step "${id}" failed — artifacts in ${opts.workDir}`);
  return artifacts;
}

async function debugScreenshot(page: Page, workDir: string, name: string): Promise<void> {
  try {
    await ensureDir(join(workDir, 'steps'));
    await page.screenshot({ path: join(workDir, 'steps', `${name}.png`) });
  } catch {
    /* never let diagnostics break the render */
  }
}

async function stopTracing(context: BrowserContext, path: string): Promise<boolean> {
  try {
    await context.tracing.stop({ path });
    return true;
  } catch {
    return false;
  }
}

async function safeClose(p: Promise<unknown>): Promise<void> {
  try {
    await p;
  } catch {
    /* already closed */
  }
}

/** Load a previous run's manifest.json (for `--phase post`). */
export async function loadManifest(workDir: string): Promise<TimingManifest> {
  try {
    return JSON.parse(await readFile(join(workDir, MANIFEST_FILE), 'utf8')) as TimingManifest;
  } catch (err) {
    throw new Error(
      `No ${MANIFEST_FILE} in ${workDir} — run the record phase first (cause: ${err instanceof Error ? err.message : err})`,
    );
  }
}
