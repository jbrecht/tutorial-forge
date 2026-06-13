import { chromium, type Browser } from 'playwright';
import type { TutorialAdapter } from '../types.js';
import { createStepContext, runTeardownChain } from './step-hooks.js';

/**
 * Exercise `adapter.setup` against the live app once, then tear down whatever it
 * created. "Reachable" (a 2xx/3xx from baseURL) is necessary but not sufficient:
 * a dev server pointed at the wrong database answers fine yet fails every render
 * at sign-in, because the identity the adapter seeds into DB-A doesn't exist in
 * the DB-B the server reads. Running setup turns that 20-minute detour into one
 * clear up-front error. Used by `doctor --setup` (#19).
 *
 * Throws the setup error (so the caller can report it); always runs teardown
 * first — even when setup half-completed — so the probe itself never leaks.
 */
export async function probeAdapterSetup(
  adapter: TutorialAdapter,
  opts: { headless?: boolean } = {},
): Promise<void> {
  const browser = await launchChromium(opts.headless ?? true);
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    const { ctx, teardownThunks } = createStepContext();
    try {
      const state = await adapter.setup(page, ctx);
      if (state != null) ctx.state = state;
    } finally {
      // No tutorial in a doctor probe — just the adapter's own teardown (plus
      // any onTeardown the setup registered). Guarded, so it can't mask the
      // setup error we're about to rethrow.
      await runTeardownChain(page, ctx, {}, adapter, teardownThunks);
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
