import type { Page } from 'playwright';
import type { Step, StepContext } from '../types.js';
import { logger } from '../util/logger.js';

/**
 * Shared step/tutorial-hook primitives used by both the record and preview
 * phases, so the StepContext shape, the focus-anchor contract, and the
 * "cleanup must never throw" rule live in one place.
 */

/** A cleanup callback registered via ctx.onTeardown(). */
export type TeardownThunk = () => void | Promise<void>;

/** Cap on a step's settleUntil wait — bounded so a never-idle page (websockets, polling) can't stall the render. */
export const SETTLE_TIMEOUT_MS = 5000;

/**
 * Wait for a real load-state signal (step.settleUntil) instead of a fixed
 * settleMs guess — e.g. 'networkidle' to let a router.refresh()'s fetches
 * quiesce (#14). Best-effort: bounded and never throws, so a page that never
 * reaches the state (persistent connections) logs and proceeds rather than
 * failing the render.
 */
export async function waitForSettle(step: Step, page: Page, id: string): Promise<void> {
  if (!step.settleUntil) return;
  try {
    await page.waitForLoadState(step.settleUntil, { timeout: SETTLE_TIMEOUT_MS });
  } catch (err) {
    logger.debug(
      `settleUntil '${step.settleUntil}' not reached within ${SETTLE_TIMEOUT_MS}ms for "${id}" — proceeding: ${err instanceof Error ? err.message : err}`,
    );
  }
}

/** Build a StepContext and the array its onTeardown() pushes into. */
export function createStepContext(lang?: string): { ctx: StepContext; teardownThunks: TeardownThunk[] } {
  const teardownThunks: TeardownThunk[] = [];
  const ctx: StepContext = { lang, onTeardown: (fn) => teardownThunks.push(fn) };
  return { ctx, teardownThunks };
}

/** Run a teardown callback, logging (never throwing) on failure — cleanup must not fail the render. */
export async function safeTeardown(label: string, fn: TeardownThunk): Promise<void> {
  try {
    await fn();
  } catch (err) {
    logger.warn(`${label} failed (ignored): ${err instanceof Error ? err.message : err}`);
  }
}

/** Run step-registered onTeardown thunks in reverse (LIFO) registration order. Never throws. */
export async function runStepTeardowns(thunks: TeardownThunk[]): Promise<void> {
  for (const fn of [...thunks].reverse()) await safeTeardown('step teardown', fn);
}

/**
 * Anchor the cursor on a step's focus control (decorative #10): smooth-scroll
 * the control into frame + move the fake cursor there via the instrumented
 * hover. The focus callback may be sync or async. Never throws — a failure
 * here is logged and skipped, so the render is unaffected.
 */
export async function anchorFocus(step: Step, page: Page, ctx: StepContext, id: string): Promise<void> {
  if (!step.focus) return;
  try {
    const locator = await step.focus(page, ctx);
    await locator.hover();
  } catch (err) {
    logger.debug(`focus anchor skipped for "${id}": ${err instanceof Error ? err.message : err}`);
  }
}
