import { describe, expect, it } from 'vitest';
import { generateSrt, srtTime, wrapText } from '../src/post/subtitles.js';
import type { TimingManifest } from '../src/types.js';

describe('srtTime', () => {
  it('formats hh:mm:ss,mmm', () => {
    expect(srtTime(0)).toBe('00:00:00,000');
    expect(srtTime(61_234)).toBe('00:01:01,234');
    expect(srtTime(3_600_000 + 2 * 60_000 + 3000 + 45)).toBe('01:02:03,045');
  });

  it('clamps negatives to zero', () => {
    expect(srtTime(-50)).toBe('00:00:00,000');
  });
});

describe('wrapText', () => {
  it('wraps at ~42 chars on word boundaries', () => {
    const wrapped = wrapText(
      'From the dashboard, open the Events page using the navigation bar.',
      42,
    );
    for (const line of wrapped.split('\n')) expect(line.length).toBeLessThanOrEqual(42);
    expect(wrapped.replace(/\n/g, ' ')).toBe(
      'From the dashboard, open the Events page using the navigation bar.',
    );
  });

  it('keeps short text on one line', () => {
    expect(wrapText('Hello there', 42)).toBe('Hello there');
  });
});

const manifest: TimingManifest = {
  tutorialId: 't',
  fps: 25,
  recordingStartEpochMs: 0,
  totalDurationMs: 20_000,
  steps: [
    {
      id: 'a', narration: 'First line.', audioFile: '/x/a.wav', audioDurationMs: 2000,
      startMs: 5000, actionStartMs: 5300, actionEndMs: 5400, endMs: 7700, callouts: [],
    },
    {
      id: 'b', narration: '', audioFile: null, audioDurationMs: 0,
      startMs: 7700, actionStartMs: 8000, actionEndMs: 8100, endMs: 8500, callouts: [],
    },
    {
      id: 'c', narration: 'Second line.', audioFile: '/x/c.wav', audioDurationMs: 3000,
      startMs: 8500, actionStartMs: 8800, actionEndMs: 8900, endMs: 11_800, callouts: [],
    },
  ],
};

describe('generateSrt', () => {
  it('emits one cue per narrated step, relative to the trim point', () => {
    const srt = generateSrt(manifest, { leadInMs: 300, trimStartMs: 4700 });
    const cues = srt.trim().split('\n\n');
    expect(cues).toHaveLength(2);
    expect(cues[0]).toBe('1\n00:00:00,600 --> 00:00:02,600\nFirst line.');
    expect(cues[1]).toContain('2\n00:00:04,100 --> 00:00:07,100\nSecond line.');
  });
});
