import { describe, expect, it } from 'vitest';
import { computeZoomWindows, buildZoomFilter } from '../src/post/zoom.js';
import type { CalloutRecord } from '../src/types.js';

const callout = (atMs: number, x = 1400, y = 200): CalloutRecord => ({ atMs, x, y, w: 100, h: 40 });

describe('computeZoomWindows', () => {
  it('builds a window leading the callout and holding past the click', () => {
    const [w] = computeZoomWindows([callout(10_000)], 4_000, 60_000);
    expect(w).toBeDefined();
    // callout at 6s on the trimmed timeline; lead 0.3s, hold 1.4s
    expect(w!.startS).toBeCloseTo(5.7, 3);
    expect(w!.endS).toBeCloseTo(7.4, 3);
    expect(w!.cx).toBe(1450);
    expect(w!.cy).toBe(220);
  });

  it('drops windows that would overlap the previous one', () => {
    const windows = computeZoomWindows([callout(10_000), callout(11_000), callout(20_000)], 0, 60_000);
    expect(windows).toHaveLength(2);
    expect(windows.map((w) => w.startS)).toEqual([9.7, 19.7]);
  });

  it('clamps to the start of the video', () => {
    const [w] = computeZoomWindows([callout(100)], 0, 60_000);
    expect(w!.startS).toBe(0);
  });

  it('skips callouts too close to the end to play out', () => {
    expect(computeZoomWindows([callout(59_900)], 0, 60_000)).toHaveLength(0);
  });

  it('sorts callouts by time', () => {
    const windows = computeZoomWindows([callout(20_000), callout(10_000)], 0, 60_000);
    expect(windows.map((w) => w.startS)).toEqual([9.7, 19.7]);
  });
});

describe('buildZoomFilter', () => {
  it('returns null with no windows', () => {
    expect(buildZoomFilter([], 1.35, 1920, 1080, 25)).toBeNull();
  });

  it('emits an fps-normalized zoompan stage with piecewise expressions', () => {
    const windows = computeZoomWindows([callout(10_000)], 0, 60_000);
    const filter = buildZoomFilter(windows, 1.35, 1920, 1080, 25)!;
    expect(filter).toMatch(/^fps=25,zoompan=z='/);
    expect(filter).toContain("d=1:s=1920x1080:fps=25");
    expect(filter).toContain('1+0.350*'); // factor-1 scaling
    expect(filter).toContain('between(it,9.700,10.200)'); // ramp-in window
    expect(filter).toContain('between(it,10.200,11.400)'); // hold
    expect(filter).toContain('between(it,11.400,11.900)'); // ramp-out
    expect(filter).toContain('1450.000'); // target center x
    expect(filter).toContain("x='clip((");
    expect(filter).toContain('iw-iw/zoom');
  });

  it('chains piecewise expressions for multiple windows', () => {
    const windows = computeZoomWindows([callout(10_000, 100, 100), callout(20_000, 1800, 900)], 0, 60_000);
    const filter = buildZoomFilter(windows, 1.5, 1920, 1080, 25)!;
    expect(filter).toContain('150.000'); // first center x (100 + 50)
    expect(filter).toContain('1850.000'); // second center x
    expect(filter).toContain('between(it,19.700');
  });
});
