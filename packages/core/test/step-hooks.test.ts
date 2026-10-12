import { describe, expect, it, vi } from 'vitest';
import type { Page } from 'playwright';
import {
  createStepContext,
  runTeardownChain,
  runStepTeardowns,
  waitForSettle, anchorFocus } from '../src/pipeline/step-hooks.js';
import type { StepContext, Tutorial, TutorialAdapter } from '../src/types.js';

// The teardown chain and ctx are browser-agnostic, so they unit-test without
// Playwright — pass a stub page the hooks never actually touch.
const fakePage = {} as Page;

describe('createStepContext', () => {
  it('defaults state to an empty bag steps can stash on', () => {
    const { ctx } = createStepContext();
    expect(ctx.state).toEqual({});
    (ctx.state as Record<string, unknown>).createdId = 'evt_1';
    expect((ctx.state as Record<string, unknown>).createdId).toBe('evt_1');
  });

  it('carries the render language', () => {
    const { ctx } = createStepContext('es');
    expect(ctx.lang).toBe('es');
  });
});

describe('runTeardownChain', () => {
  it('runs innermost-first: step thunks (LIFO) → tutorial → adapter', async () => {
    const order: string[] = [];
    const { ctx, teardownThunks } = createStepContext();
    ctx.onTeardown(() => void order.push('step.a'));
    ctx.onTeardown(() => void order.push('step.b'));
    const tutorial: Pick<Tutorial, 'teardown'> = { teardown: async () => void order.push('tutorial') };
    const adapter: Pick<TutorialAdapter, 'teardown'> = { teardown: async () => void order.push('adapter') };

    await runTeardownChain(fakePage, ctx, tutorial, adapter, teardownThunks);

    expect(order).toEqual(['step.b', 'step.a', 'tutorial', 'adapter']);
  });

  it('keeps going (and never throws) when a hook fails — a half-built teardown must not leak the rest', async () => {
    const order: string[] = [];
    const { ctx, teardownThunks } = createStepContext();
    ctx.onTeardown(() => {
      throw new Error('thunk boom');
    });
    const tutorial: Pick<Tutorial, 'teardown'> = {
      teardown: async () => {
        throw new Error('tutorial boom');
      },
    };
    const adapter: Pick<TutorialAdapter, 'teardown'> = { teardown: async () => void order.push('adapter ran') };

    await expect(runTeardownChain(fakePage, ctx, tutorial, adapter, teardownThunks)).resolves.toBeUndefined();
    expect(order).toEqual(['adapter ran']); // adapter teardown still ran despite earlier failures
  });

  it('awaits value-returning thunks (widened onTeardown type, #21)', async () => {
    const seen: number[] = [];
    const { ctx, teardownThunks } = createStepContext();
    // Returns a Promise<number[]> — would not typecheck under the old void-only signature.
    ctx.onTeardown(() => Promise.all([1, 2, 3].map(async (n) => void seen.push(n))));
    await runStepTeardowns(teardownThunks);
    expect(seen.sort()).toEqual([1, 2, 3]);
  });
});

describe('waitForSettle', () => {
  it('is a no-op when no settleUntil is set', async () => {
    const page = { waitForLoadState: vi.fn() } as unknown as Page;
    await waitForSettle({}, page, 'id');
    expect(page.waitForLoadState).not.toHaveBeenCalled();
  });

  it('never throws when the load-state never arrives', async () => {
    const page = {
      waitForLoadState: vi.fn().mockRejectedValue(new Error('timeout')),
    } as unknown as Page;
    await expect(waitForSettle({ settleUntil: 'networkidle' }, page, 'id')).resolves.toBeUndefined();
  });
});

// Keep the StepContext generic honest: the typed-state handoff must compile.
describe('typed state handoff (#17)', () => {
  it('threads an adapter state type through to ctx.state', () => {
    interface Seed {
      steward: { id: string };
    }
    const ctx: StepContext<Seed> = { state: { steward: { id: 'p1' } }, onTeardown: () => {} };
    // No `!` assertion, no module global — the field is typed.
    expect(ctx.state.steward.id).toBe('p1');
  });
});

describe('anchorFocus cursor parking (#71 §2)', () => {
  const fakeLocator = (box: { width: number; height: number } | null, opts: { hoverFails?: boolean } = {}) => {
    const hovers: Array<{ position?: { x: number; y: number } } | undefined> = [];
    return {
      hovers,
      locator: {
        boundingBox: async () => (box ? { x: 0, y: 0, ...box } : null),
        hover: async (arg?: { position?: { x: number; y: number } }) => {
          hovers.push(arg);
          // Simulate a point the hit-target check rejects.
          if (opts.hoverFails && arg?.position) throw new Error('not hittable');
        },
      },
    };
  };
  const stepWith = (locator: unknown) => ({ narration: '', run: async () => {}, focus: () => locator as never });

  it('parks toward the lower-right so the cursor stops covering the label', async () => {
    const f = fakeLocator({ width: 100, height: 40 });
    await anchorFocus(stepWith(f.locator) as never, {} as never, {} as never, 'x');
    expect(f.hovers[0]?.position?.x).toBeCloseTo(78);
    expect(f.hovers[0]?.position?.y).toBeCloseTo(28.8);
  });

  it('never computes a negative position on a hairline target', async () => {
    for (const box of [{ width: 0, height: 0 }, { width: 1, height: 1 }, { width: 2, height: 2 }]) {
      const f = fakeLocator(box);
      await anchorFocus(stepWith(f.locator) as never, {} as never, {} as never, 'x');
      const pos = f.hovers[0]?.position;
      if (pos) {
        expect(pos.x).toBeGreaterThan(0);
        expect(pos.y).toBeGreaterThan(0);
      }
    }
  });

  it('falls back to a centre hover when the offset point is not hittable', async () => {
    const f = fakeLocator({ width: 100, height: 40 }, { hoverFails: true });
    const result = await anchorFocus(stepWith(f.locator) as never, {} as never, {} as never, 'x');
    expect(f.hovers).toHaveLength(2);
    expect(f.hovers[1]).toBeUndefined(); // plain hover(), no position
    expect(result).toBe(f.locator); // anchor (and the crop target) survives
  });

  it('returns the locator so the still can crop to it, and null when there is no focus', async () => {
    const f = fakeLocator({ width: 50, height: 50 });
    expect(await anchorFocus(stepWith(f.locator) as never, {} as never, {} as never, 'x')).toBe(f.locator);
    expect(await anchorFocus({ narration: '', run: async () => {} } as never, {} as never, {} as never, 'x')).toBeNull();
  });
});
