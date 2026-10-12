import { join } from 'node:path';
import { writeFile, readFile } from 'node:fs/promises';
import { chromium, type Browser, type BrowserContext, type Locator, type Page } from 'playwright';
import { createRecorder, type CaptureInfo, type RecorderKind } from './recorder.js';
import type { CalloutRecord, FailureArtifacts, Step, TimingManifest, Tutorial, TutorialAdapter } from '../types.js';
import { StepError } from '../types.js';
import { ConsoleCapture } from '../browser/console.js';
import { stepId } from '../spec.js';
import { anchorFocus, createStepContext, runTeardownChain, waitForSettle } from './step-hooks.js';
import type { TTSPhaseResult } from './tts.js';
import { CURSOR_INIT_SCRIPT } from '../browser/cursor.js';
import { CALLOUT_INIT_SCRIPT } from '../browser/callout.js';
import { RecordingClock, stepHoldUntilMs } from '../browser/timing.js';
import { instrumentPage } from '../browser/instrument.js';
import { ensureDir, removeDir } from '../util/fs.js';
import { fileSafeId } from './stills.js';
import { logger } from '../util/logger.js';

export const RAW_VIDEO_FILE = 'raw.webm';
export const MANIFEST_FILE = 'manifest.json';
/** Calibration flash duration; the post phase must never trim inside it. */
export const FLASH_MS = 120;
const FINAL_HOLD_MS = 1000;
/**
 * Wall-clock reserved inside a step's hold for the settled still capture, so
 * the shot happens *during* dead time instead of extending the step (#71 §3).
 * A `--stills` render must produce the same video as one without it; measured
 * capture cost is ~65-100ms, so this leaves healthy margin.
 */
const STILL_SHOT_BUDGET_MS = 300;
/** The callout ring self-removes this long after a click; a settled frame must be later. */
const CALLOUT_CLEAR_MS = 250;
/** Overrun past the hold that's worth telling the author about. */
const STILL_OVERRUN_WARN_MS = 20;
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
  /**
   * Keep a settled end-of-step screenshot per step (steps/<id>.png) on
   * success, for the contact sheet (#9). Implied by debug.
   */
  screenshots?: boolean;
  /**
   * Also capture the pre-action frame (steps/<id>@before.png) for the stills
   * export (#71): taken after the cursor anchors on the focus target but
   * before the action runs, so a "click this" still actually shows the control.
   * `crop` clips to the focus target plus padding.
   */
  stills?: {
    capture: 'before' | 'after' | 'both';
    crop: boolean;
    cropPaddingPx: number;
  };
}

/**
 * Phase 2 — drive the browser through the tutorial while Playwright records
 * video, pacing each step to its narration budget. Writes raw.webm and
 * manifest.json into workDir.
 */
export async function runRecordPhase<S = unknown>(
  tutorial: Tutorial<S>,
  adapter: TutorialAdapter<S>,
  tts: TTSPhaseResult,
  opts: RecordPhaseOptions,
): Promise<TimingManifest> {
  await ensureDir(opts.workDir);
  // A recording pass owns its frames. Work dirs are reused (`.forge/<id>` by
  // default), so leftovers from an earlier run would otherwise survive here —
  // and a later consumer (contact sheet, stills export) could publish a stale
  // screenshot for a step that didn't run this time.
  await removeDir(join(opts.workDir, 'steps'));
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

    // Step-registered cleanup thunks (ctx.onTeardown), run LIFO at teardown.
    const { ctx, teardownThunks } = createStepContext<S>(opts.lang);
    // Teardown, innermost-first: step thunks (LIFO) → tutorial → adapter. Runs
    // on the success, step-failure, AND setup-failure paths so data created
    // before any throw is still cleaned up (the orphan-leak #8 set out to fix).
    const runTeardown = () => runTeardownChain(page, ctx, tutorial, adapter, teardownThunks);
    logger.info(`record: setup (${adapter.baseURL})${opts.lang ? ` [${opts.lang}]` : ''}`);
    try {
      // adapter.setup's return value (if any) is the per-render state bag that
      // tutorial.setup and steps read via ctx.state (#17).
      const setupState = await adapter.setup(page, ctx);
      if (setupState != null) ctx.state = setupState as S;
      if (tutorial.setup) {
        logger.info('record: tutorial setup');
        await tutorial.setup(page, ctx);
      }
    } catch (cause) {
      // A throw in setup (flaky signIn, warm-up goto timeout) must still tear
      // down anything seeded/registered before it — otherwise ctx.onTeardown in
      // setup is a no-op on the most leak-prone path (#15).
      await runTeardown();
      await safeClose(context.close());
      throw cause;
    }
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
      // Wall-clock this step spent on still captures. Subtracted from the
      // action window when pacing, so enabling stills can't lengthen the step
      // (#71 §3) — the hold absorbs it instead.
      let captureOverheadMs = 0;
      // Hoisted: the settled capture crops against the same target as the
      // pre-action one, so a cropped set isn't half full-frame.
      let focusTarget: Locator | null = null;
      try {
        // Anchor the cursor on the step's focus control before its own action,
        // so narration about "this control" has a visual focus (#10).
        focusTarget = await anchorFocus(step, instrumented as Page, ctx, id);
        if (wantsBefore(step, opts)) {
          const t0 = clock.now();
          // The pre-action frame (#71 §1): the control is still on screen with
          // the cursor on it, which is what a "click this" screenshot needs.
          await captureStill(page, opts.workDir, `${fileSafeId(id)}@before`, focusTarget, opts);
          captureOverheadMs += clock.now() - t0;
        }
        await step.run(instrumented as Page, ctx);
        await step.waitFor?.(instrumented as Page, ctx);
        await waitForSettle(step, page, id);
      } catch (cause) {
        const artifacts = await captureFailure(page, context, opts, id, consoleLog);
        await saveManifest(tutorial, clock, manifestSteps, opts.workDir, opts.lang);
        // Clean up anything created before the failure (guarded), then bail.
        await runTeardown();
        await safeClose(context.close());
        throw new StepError(tutorial.id, id, cause, artifacts);
      }
      const actionEndMs = clock.now();
      if (opts.debug) await debugScreenshot(page, opts.workDir, `${id}-after`);

      const holdUntil = stepHoldUntilMs({
        startMs,
        leadInMs: opts.leadInMs,
        audioDurationMs: audio.audioDurationMs,
        // Pace against a capture-free action window so the step ends where it
        // would without stills; the real actionEndMs still goes in the manifest.
        actionEndMs: actionEndMs - captureOverheadMs,
        settleMs: step.settleMs ?? 400,
      });

      // The settled frame (contact sheet #9, and the 'after' still) is taken
      // *inside* the hold rather than after it: shoot with a budget to spare,
      // then wait out whatever is left, so the step still ends at holdUntil.
      const wantSettled = opts.screenshots || wantsAfter(step, opts);
      if (wantSettled) {
        // Shoot as early as the frame is actually settled (the callout ring is
        // gone ~200ms after the action), not at a fixed offset from the end —
        // that maximises the slack left to absorb a slow capture.
        const settledAt = actionEndMs + Math.min(step.settleMs ?? 400, CALLOUT_CLEAR_MS);
        const shotAt = Math.min(holdUntil - STILL_SHOT_BUDGET_MS, Math.max(settledAt, holdUntil - STILL_SHOT_BUDGET_MS));
        const untilShot = Math.max(settledAt, shotAt) - clock.now();
        if (untilShot > 0) await page.waitForTimeout(untilShot);
        await captureStill(page, opts.workDir, fileSafeId(id), focusTarget, opts);
      }
      const remaining = holdUntil - clock.now();
      if (remaining > 0) await page.waitForTimeout(remaining);
      else if (wantSettled && remaining < -STILL_OVERRUN_WARN_MS) {
        // The capture didn't fit in this step's hold, so it lengthened the
        // recording. Say so: silent drift is what made this a bug the first time.
        logger.warn(
          `stills: step "${id}" had no hold slack — its capture added ~${Math.round(-remaining)}ms to the video. ` +
            'Give the step a longer settleMs (or narration) to absorb it.',
        );
      }

      manifestSteps.push({
        id,
        narration: step.narration,
        ...(step.alt !== undefined ? { alt: step.alt } : {}),
        ...(step.still !== undefined ? { still: step.still } : {}),
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

    await runTeardown();

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
  tutorial: Pick<Tutorial, 'id'>,
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

/** Which still frame(s) this step needs: the step's own override wins over the render default. */
function stillMode(step: Pick<Step, 'still'>, opts: RecordPhaseOptions): 'before' | 'after' | 'both' | null {
  if (!opts.stills) return null;
  return step.still ?? opts.stills.capture;
}

function wantsBefore(step: Pick<Step, 'still'>, opts: RecordPhaseOptions): boolean {
  const mode = stillMode(step, opts);
  return mode === 'before' || mode === 'both';
}

function wantsAfter(step: Pick<Step, 'still'>, opts: RecordPhaseOptions): boolean {
  const mode = stillMode(step, opts);
  return mode === 'after' || mode === 'both';
}

/**
 * Applied for the duration of a still capture only. Deliberately minimal: the
 * capture now happens *inside* the recorded hold, and Playwright's `style`
 * option really does inject a <style> tag into the live page, so anything more
 * aggressive (pausing animations, killing transitions) would show up in the
 * video as a 2-3 frame stutter. Hiding the caret is safe — it blinks anyway —
 * and removes the one source of frame-to-frame churn worth removing; the rest
 * of #71 §5 is handled by comparing pixels on export rather than by freezing.
 */
const STILL_FREEZE_CSS = '*,*::before,*::after{caret-color:transparent!important}';

/**
 * Capture a still. `target`, when given and cropping is on, clips to that
 * element plus padding (#71 §2) — a full 2x viewport renders the subject small
 * in a docs column. Never throws: a diagnostic must not break the render.
 */
async function captureStill(
  page: Page,
  workDir: string,
  name: string,
  target: Locator | null,
  opts: RecordPhaseOptions,
): Promise<void> {
  try {
    await ensureDir(join(workDir, 'steps'));
    const path = join(workDir, 'steps', `${name}.png`);
    const clip = opts.stills?.crop ? await cropBox(page, target, opts.stills.cropPaddingPx) : undefined;
    await page.screenshot({ path, style: STILL_FREEZE_CSS, ...(clip ? { clip } : {}) });
  } catch (err) {
    // Never fail the render over a still, but don't hide the cause either —
    // it surfaces otherwise only as an unexplained "no frame for step X".
    logger.warn(`stills: capture failed for "${name}": ${err instanceof Error ? err.message : err}`);
  }
}

/** The focus target's box grown by padding and clamped to the viewport, or undefined when uncroppable. */
async function cropBox(
  page: Page,
  target: Locator | null,
  paddingPx: number,
): Promise<{ x: number; y: number; width: number; height: number } | undefined> {
  if (!target) return undefined;
  try {
    const box = await target.boundingBox();
    if (!box) return undefined;
    if (box.width <= 0 || box.height <= 0) return undefined;
    const view = page.viewportSize();
    // An element scrolled out of the viewport would otherwise clamp to a clip
    // over the wrong region (or a 1px one Playwright rejects) — fall back to
    // the full frame, which is at least correct.
    if (view && (box.x >= view.width || box.y >= view.height || box.x + box.width <= 0 || box.y + box.height <= 0)) {
      return undefined;
    }
    const x = Math.max(0, box.x - paddingPx);
    const y = Math.max(0, box.y - paddingPx);
    const maxW = view ? view.width - x : box.width + paddingPx * 2;
    const maxH = view ? view.height - y : box.height + paddingPx * 2;
    if (maxW <= 0 || maxH <= 0) return undefined;
    return {
      x,
      y,
      width: Math.max(1, Math.min(box.width + paddingPx * 2, maxW)),
      height: Math.max(1, Math.min(box.height + paddingPx * 2, maxH)),
    };
  } catch {
    return undefined;
  }
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
