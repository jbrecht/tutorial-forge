import { resolve, dirname } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright';
import type { Tutorial, TutorialAdapter } from '../types.js';
import { validateTutorial, stepId } from '../spec.js';
import { localizeTutorial } from '../i18n.js';
import { CURSOR_INIT_SCRIPT } from '../browser/cursor.js';
import { CALLOUT_INIT_SCRIPT } from '../browser/callout.js';
import { instrumentPage } from '../browser/instrument.js';
import { anchorFocus, createStepContext, runTeardownChain, waitForSettle } from './step-hooks.js';
import { ensureDir } from '../util/fs.js';
import { logger } from '../util/logger.js';

/**
 * Single-step preview (#11): reach the state a step runs in by replaying
 * adapter.setup() + every prior step's run() with no TTS, no video, and no
 * encode — then run just the target step and dump a screenshot. Lets an
 * author validate one step's selectors and framing in seconds instead of
 * re-recording the whole tutorial every iteration.
 *
 * Prior-step state is reached by running each earlier run()/waitFor() back
 * to back (no narration pacing); only the target step's settle is honored.
 */
export interface PreviewOptions {
  /** Target step: 1-based index ("11") or step id ("set-status"). */
  step: string;
  /** Screenshot path. Default: <workDir>/preview-<id>.png */
  output?: string;
  workDir?: string;
  viewport?: { width: number; height: number };
  headless?: boolean;
  /** Inject the fake cursor so framing matches a real render. Default true. */
  cursor?: boolean;
  /** Highlight interactions. Default true. */
  callouts?: boolean;
  /** Extra hold after the target step before the screenshot. Default step.settleMs ?? 400. */
  settleMs?: number;
  /** Render this language (narration/ctx.lang); affects steps that branch on ctx.lang. */
  lang?: string;
  defaultLang?: string;
}

export interface PreviewResult {
  /** Resolved step id. */
  stepId: string;
  /** 0-based index of the previewed step. */
  index: number;
  /** Path to the screenshot. */
  screenshot: string;
}

/** Resolve a "step" argument (1-based index or id) to a 0-based index. */
export function resolveStepIndex<S = unknown>(tutorial: Tutorial<S>, step: string): number {
  const asNum = /^\d+$/.test(step.trim()) ? parseInt(step.trim(), 10) : null;
  if (asNum !== null) {
    if (asNum < 1 || asNum > tutorial.steps.length) {
      throw new Error(`Step ${asNum} out of range (tutorial has ${tutorial.steps.length} steps)`);
    }
    return asNum - 1;
  }
  const idx = tutorial.steps.findIndex((s, i) => stepId(s, i) === step);
  if (idx === -1) {
    const ids = tutorial.steps.map((s, i) => stepId(s, i)).join(', ');
    throw new Error(`No step with id "${step}" in tutorial "${tutorial.id}". Steps: ${ids}`);
  }
  return idx;
}

export async function previewStep<S = unknown>(
  tutorial: Tutorial<S>,
  adapter: TutorialAdapter<S>,
  opts: PreviewOptions,
): Promise<PreviewResult> {
  validateTutorial(tutorial);
  if (opts.lang) tutorial = localizeTutorial(tutorial, opts.lang, opts.defaultLang ?? 'en');

  const target = resolveStepIndex(tutorial, opts.step);
  const id = stepId(tutorial.steps[target]!, target);
  const workDir = resolve(opts.workDir ?? `.forge/preview/${tutorial.id}`);
  const output = resolve(opts.output ?? `${workDir}/preview-${id}.png`);
  const viewport = opts.viewport ?? { width: 1920, height: 1080 };
  const cursor = opts.cursor ?? true;
  const callouts = opts.callouts ?? true;
  await ensureDir(dirname(output));

  const browser = await launchChromium(opts.headless ?? true);
  try {
    const context = await browser.newContext({ viewport, deviceScaleFactor: 2 });
    if (cursor) await context.addInitScript(CURSOR_INIT_SCRIPT);
    if (callouts || cursor) await context.addInitScript(CALLOUT_INIT_SCRIPT);

    const page = await context.newPage();
    const { ctx, teardownThunks } = createStepContext<S>(opts.lang);
    // Full teardown chain (step thunks → tutorial → adapter), run on every exit
    // path. preview is the fast iterate-on-one-step tool, run repeatedly by
    // design, so leaving the adapter seed behind each run quietly fills the
    // shared test DB — exactly what a quick-iteration tool must not do (#16).
    // Hooks must tolerate the partial, mid-tutorial state preview reaches; each
    // is guarded, so a teardown that can't run logs rather than failing.
    try {
      logger.info(`preview: setup (${adapter.baseURL})${opts.lang ? ` [${opts.lang}]` : ''}`);
      const setupState = await adapter.setup(page, ctx);
      if (setupState != null) ctx.state = setupState as S;
      if (tutorial.setup) await tutorial.setup(page, ctx);

      // Replay prior steps on the RAW page (no cursor/scroll animation) — we only
      // need their state, not their framing, so replay stays fast (#11).
      for (let i = 0; i < target; i++) {
        const step = tutorial.steps[i]!;
        logger.info(`preview: replay ${i + 1}/${target} "${stepId(step, i)}"`);
        await step.run(page, ctx);
        await step.waitFor?.(page, ctx);
      }

      // The target step runs instrumented (cursor/callouts/focus), to match a
      // real render's framing — that's what the screenshot is verifying.
      const instrumented = instrumentPage(page, { cursor, callouts, nowMs: () => 0, onCallout: () => {} });
      const step = tutorial.steps[target]!;
      logger.info(`preview: step ${target + 1}/${tutorial.steps.length} "${id}"`);
      await anchorFocus(step, instrumented as Page, ctx, id);
      await step.run(instrumented as Page, ctx);
      await step.waitFor?.(instrumented as Page, ctx);
      await waitForSettle(step, page, id);
      await page.waitForTimeout(opts.settleMs ?? step.settleMs ?? 400);

      await page.screenshot({ path: output });
      logger.info(`preview: wrote ${output}`);

      return { stepId: id, index: target, screenshot: output };
    } finally {
      await runTeardownChain(page, ctx, tutorial, adapter, teardownThunks);
    }
  } finally {
    await safeClose(browser.close());
  }
}

async function launchChromium(headless: boolean): Promise<Browser> {
  try {
    return await chromium.launch({ headless, channel: 'chromium' });
  } catch {
    return chromium.launch({ headless });
  }
}

async function safeClose(p: Promise<unknown>): Promise<void> {
  try {
    await p;
  } catch {
    /* already closed */
  }
}
