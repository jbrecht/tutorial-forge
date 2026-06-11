import { join } from 'node:path';
import { writeFile, readFile, rename } from 'node:fs/promises';
import { chromium, type Browser, type Page } from 'playwright';
import type { CalloutRecord, TimingManifest, Tutorial, TutorialAdapter } from '../types.js';
import { StepError } from '../types.js';
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
  const videoDir = join(opts.workDir, 'video');
  await ensureDir(videoDir);

  const browser = await launchChromium(opts.headless);
  try {
    // Playwright's screencast captures at CSS-viewport size and pads (never
    // scales up) when recordVideo.size is larger, so record at viewport size.
    // deviceScaleFactor 2 still sharpens text: Chromium rasterizes at 2x and
    // downscales into the captured frame.
    const context = await browser.newContext({
      viewport: opts.viewport,
      deviceScaleFactor: 2,
      recordVideo: { dir: videoDir, size: opts.viewport },
    });
    if (opts.cursor) await context.addInitScript(CURSOR_INIT_SCRIPT);
    if (opts.callouts || opts.cursor) await context.addInitScript(CALLOUT_INIT_SCRIPT);

    const page = await context.newPage();
    const clock = new RecordingClock();

    // Clock zero + calibration flash: paint a magenta frame the post phase
    // can find to align the manifest clock with the video's first frame.
    await page.goto('about:blank');
    await page.waitForTimeout(250);
    clock.zero();
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
    // post trims at steps[0].startMs - leadInMs, which without this hold can
    // land inside the flash and leave magenta frames in the output.
    await page.waitForTimeout(POST_FLASH_HOLD_MS);

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
      await page.waitForTimeout(opts.leadInMs);

      const actionStartMs = clock.now();
      try {
        await step.run(instrumented as Page, ctx);
        await step.waitFor?.(instrumented as Page, ctx);
      } catch (cause) {
        await captureFailure(page, opts.workDir, id);
        await saveManifest(tutorial, clock, manifestSteps, opts.workDir, opts.lang);
        await safeClose(context.close());
        throw new StepError(tutorial.id, id, cause);
      }
      const actionEndMs = clock.now();

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
    const manifest = await saveManifest(tutorial, clock, manifestSteps, opts.workDir, opts.lang);

    if (adapter.teardown) {
      try {
        await adapter.teardown(page, ctx);
      } catch (err) {
        logger.warn(`teardown failed (ignored): ${err instanceof Error ? err.message : err}`);
      }
    }

    const video = page.video();
    await context.close(); // flushes the webm
    if (!video) throw new Error('Playwright returned no video — recordVideo was not active');
    await rename(await video.path(), join(opts.workDir, RAW_VIDEO_FILE));

    return manifest;
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
): Promise<TimingManifest> {
  const manifest: TimingManifest = {
    tutorialId: tutorial.id,
    ...(lang ? { lang } : {}),
    fps: 25,
    recordingStartEpochMs: clock.zeroEpoch,
    steps,
    totalDurationMs: clock.now(),
  };
  await writeFile(join(workDir, MANIFEST_FILE), JSON.stringify(manifest, null, 2));
  return manifest;
}

async function captureFailure(page: Page, workDir: string, id: string): Promise<void> {
  try {
    await page.screenshot({ path: join(workDir, `failure-${id}.png`) });
    logger.error(`record: step "${id}" failed — screenshot at ${join(workDir, `failure-${id}.png`)}`);
  } catch {
    /* page may already be unusable */
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
