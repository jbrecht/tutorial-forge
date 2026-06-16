import { describe, expect, it } from 'vitest';
import { mapLimit } from '../src/util/fs.js';

const tick = () => new Promise((r) => setTimeout(r, 1));

describe('mapLimit', () => {
  it('runs every item and preserves result order', async () => {
    const out = await mapLimit([1, 2, 3, 4, 5], 2, async (n) => {
      await tick();
      return n * 10;
    });
    expect(out).toEqual([10, 20, 30, 40, 50]);
  });

  it('never exceeds the concurrency cap', async () => {
    let inFlight = 0;
    let peak = 0;
    await mapLimit(Array.from({ length: 12 }, (_, i) => i), 3, async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await tick();
      inFlight--;
    });
    expect(peak).toBe(3);
  });

  it('limit 1 runs strictly sequentially (today\'s serial behavior)', async () => {
    const order: number[] = [];
    await mapLimit([0, 1, 2], 1, async (n) => {
      order.push(n); // start
      await tick();
      order.push(n + 100); // end — must finish before the next starts
    });
    expect(order).toEqual([0, 100, 1, 101, 2, 102]);
  });

  it('limit 1 is fail-fast: a throw stops before later items run (matches the old for-loop)', async () => {
    const seen: number[] = [];
    await expect(
      mapLimit([0, 1, 2], 1, async (n) => {
        seen.push(n);
        if (n === 1) throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(seen).toEqual([0, 1]); // item 2 never started
  });

  it('rejects when a job throws under concurrency > 1', async () => {
    await expect(
      mapLimit([0, 1, 2, 3], 2, async (n) => {
        await tick();
        if (n === 2) throw new Error('kaboom');
      }),
    ).rejects.toThrow('kaboom');
  });

  it('on a throw, stops scheduling new items but lets in-flight ones finish (concurrency > 1)', async () => {
    const started: number[] = [];
    const finished: number[] = [];
    await expect(
      mapLimit([0, 1, 2, 3, 4], 2, async (n) => {
        started.push(n);
        await tick();
        if (n === 0) throw new Error('stop');
        finished.push(n);
      }),
    ).rejects.toThrow('stop');
    // Two workers start 0 and 1; 0 throws, 1 (already in flight) finishes.
    // The abort flag prevents 2, 3, 4 from ever starting.
    expect(started.sort()).toEqual([0, 1]);
    expect(finished).toEqual([1]);
  });

  it('returns [] for empty input at any limit', async () => {
    expect(await mapLimit([], 4, async () => 1)).toEqual([]);
  });
});
