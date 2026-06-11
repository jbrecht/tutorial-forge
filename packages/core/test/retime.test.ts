import { describe, expect, it } from 'vitest';
import { computeIdleSegments, buildTimeMap, buildRetimeFilter } from '../src/post/retime.js';
import type { TimingManifest } from '../src/types.js';

const CONFIG = { maxIdleMs: 2000, speed: 3 };

function manifest(steps: TimingManifest['steps'], totalDurationMs: number): TimingManifest {
  return { tutorialId: 't', fps: 25, recordingStartEpochMs: 0, steps, totalDurationMs };
}

const step = (
  startMs: number,
  audioDurationMs: number,
  endMs: number,
  callouts: Array<{ atMs: number }> = [],
): TimingManifest['steps'][number] => ({
  id: `s${startMs}`,
  narration: audioDurationMs ? 'x' : '',
  audioFile: audioDurationMs ? '/a.wav' : null,
  audioDurationMs,
  startMs,
  actionStartMs: startMs + 300,
  actionEndMs: startMs + 400,
  endMs,
  callouts: callouts.map((c) => ({ ...c, x: 0, y: 0, w: 10, h: 10 })),
});

describe('computeIdleSegments', () => {
  it('compresses a long narration-free span with margins', () => {
    // narration [1.3s..3.3s], then silence until 10s
    const m = manifest([step(1000, 2000, 10_000)], 10_000);
    const segs = computeIdleSegments(m, 0, 300, CONFIG);
    // leading gap (0..1.3s) is under maxIdle; only the trailing gap compresses
    expect(segs).toHaveLength(1);
    expect(segs[0]!.startS).toBeCloseTo(3.8, 3); // 3.3 + 0.5 margin
    expect(segs[0]!.endS).toBeCloseTo(9.5, 3); // 10 - 0.5 margin
    expect(segs[0]!.speed).toBe(3);
  });

  it('leaves short gaps alone', () => {
    // narration ends 3.3s, next starts 4.8s → 1.5s gap < 2s
    const m = manifest([step(1000, 2000, 4500), step(4500, 2000, 8000)], 8000);
    expect(computeIdleSegments(m, 0, 300, CONFIG)).toHaveLength(0);
  });

  it('protects callout choreography inside gaps', () => {
    // silent step: gap would be 0..12s, but a callout at 6s splits it
    const m = manifest([step(0, 0, 12_000, [{ atMs: 6000 }])], 12_000);
    const segs = computeIdleSegments(m, 0, 300, CONFIG);
    expect(segs).toHaveLength(2);
    expect(segs[0]!.endS).toBeLessThanOrEqual(5.7 - 0.5 + 0.001); // ends ≥ margin before callout-0.3
    expect(segs[1]!.startS).toBeGreaterThanOrEqual(7.5 + 0.5 - 0.001); // resumes after callout+1.5 + margin
  });

  it('is relative to the trim start', () => {
    const m = manifest([step(5000, 1000, 20_000)], 20_000);
    const segs = computeIdleSegments(m, 4000, 300, CONFIG);
    // narration [1.3..2.3] on trimmed timeline; trailing gap 2.3..16
    expect(segs[0]!.startS).toBeCloseTo(2.8, 3);
    expect(segs[0]!.endS).toBeCloseTo(15.5, 3);
  });
});

describe('buildTimeMap', () => {
  const map = buildTimeMap([{ startS: 4, endS: 10, speed: 3 }], 20);

  it('is identity before the segment', () => {
    expect(map.mapS(0)).toBe(0);
    expect(map.mapS(4)).toBe(4);
  });

  it('compresses inside the segment', () => {
    expect(map.mapS(7)).toBeCloseTo(5, 6); // 4 + 3/3
    expect(map.mapS(10)).toBeCloseTo(6, 6); // 4 + 6/3
  });

  it('shifts but does not compress after the segment', () => {
    expect(map.mapS(15)).toBeCloseTo(11, 6); // 6 + 5
  });

  it('computes the output duration', () => {
    expect(map.outputDurationS).toBeCloseTo(16, 6); // 20 - 6 + 2
  });

  it('handles multiple segments', () => {
    const m2 = buildTimeMap(
      [
        { startS: 2, endS: 4, speed: 2 },
        { startS: 10, endS: 16, speed: 3 },
      ],
      20,
    );
    expect(m2.mapS(4)).toBeCloseTo(3, 6);
    expect(m2.mapS(10)).toBeCloseTo(9, 6);
    expect(m2.mapS(16)).toBeCloseTo(11, 6);
    expect(m2.outputDurationS).toBeCloseTo(15, 6);
  });
});

describe('buildRetimeFilter', () => {
  it('emits a piecewise setpts expression matching the map', () => {
    const map = buildTimeMap([{ startS: 4, endS: 10, speed: 3 }], 20);
    const filter = buildRetimeFilter(map);
    expect(filter).toMatch(/^setpts='\(/);
    expect(filter).toContain('if(lt(T,4.000),0.000+T');
    expect(filter).toContain('if(lt(T,10.000),4.000+(T-4.000)/3.000');
    expect(filter).toContain('-4.000+T'); // tail: out = T - 4
    expect(filter).toContain("/TB'");
  });
});
