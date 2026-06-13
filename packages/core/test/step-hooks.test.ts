import { describe, expect, it, vi } from 'vitest';
import type { Page } from 'playwright';
import {
  createStepContext,
  runTeardownChain,
  runStepTeardowns,
  waitForSettle,
} from '../src/pipeline/step-hooks.js';
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
