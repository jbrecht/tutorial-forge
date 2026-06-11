import { describe, expect, it } from 'vitest';
import { buildConcatList, buildAssembleArgs } from '../src/pipeline/recorder.js';

const ZERO = 1_000_000;
const frame = (n: number, atMs: number) => ({ file: `/w/frames/frame-${n}.jpg`, tsMs: ZERO + atMs });

describe('buildConcatList', () => {
  it('places frames at their clock offsets and extends the last to the end', () => {
    const list = buildConcatList([frame(1, 0), frame(2, 500), frame(3, 1200)], ZERO, 5000);
    expect(list).toBe(
      [
        'ffconcat version 1.0',
        "file '/w/frames/frame-1.jpg'",
        'duration 0.500',
        "file '/w/frames/frame-2.jpg'",
        'duration 0.700',
        "file '/w/frames/frame-3.jpg'",
        'duration 3.800',
        "file '/w/frames/frame-3.jpg'",
        '',
      ].join('\n'),
    );
  });

  it('collapses pre-zero frames to a single t=0 frame', () => {
    const list = buildConcatList([frame(1, -900), frame(2, -100), frame(3, 700)], ZERO, 2000);
    expect(list).not.toContain('frame-1.jpg');
    const lines = list.split('\n');
    expect(lines[1]).toBe("file '/w/frames/frame-2.jpg'"); // last pre-zero frame is t=0 content
    expect(lines[2]).toBe('duration 0.700');
  });

  it('clamps a late first frame to t=0', () => {
    const list = buildConcatList([frame(1, 300), frame(2, 1000)], ZERO, 2000);
    const lines = list.split('\n');
    expect(lines[2]).toBe('duration 1.000'); // first frame stretched back to 0
  });

  it('sorts out-of-order frames', () => {
    const list = buildConcatList([frame(2, 800), frame(1, 200)], ZERO, 1000);
    expect(list.indexOf('frame-1.jpg')).toBeLessThan(list.indexOf('frame-2.jpg'));
  });

  it('throws when no frames land in the recording window', () => {
    expect(() => buildConcatList([], ZERO, 1000)).toThrow(/no screencast frames/);
  });
});

describe('buildAssembleArgs', () => {
  it('encodes the concat list to a CFR intermediate', () => {
    const args = buildAssembleArgs('/w/frames.ffconcat', 25, '/w/raw-screencast.mp4');
    expect(args.join(' ')).toBe(
      '-y -f concat -safe 0 -i /w/frames.ffconcat -vf fps=25 -c:v libx264 -preset veryfast -crf 15 -pix_fmt yuv420p /w/raw-screencast.mp4',
    );
  });
});
