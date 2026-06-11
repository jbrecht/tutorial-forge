import { describe, expect, it } from 'vitest';
import { buildGifArgs, resolveGifWindow } from '../src/post/gif.js';
import type { TimingManifest } from '../src/types.js';

const manifest: TimingManifest = {
  tutorialId: 't',
  fps: 25,
  recordingStartEpochMs: 0,
  totalDurationMs: 30_000,
  steps: [
    {
      id: 'intro', narration: 'a', audioFile: '/a.wav', audioDurationMs: 2000,
      startMs: 3000, actionStartMs: 3300, actionEndMs: 3400, endMs: 6000, callouts: [],
    },
    {
      id: 'modal', narration: 'b', audioFile: '/b.wav', audioDurationMs: 2000,
      startMs: 6000, actionStartMs: 6300, actionEndMs: 6400, endMs: 9000, callouts: [],
    },
    {
      id: 'outro', narration: 'c', audioFile: '/c.wav', audioDurationMs: 2000,
      startMs: 9000, actionStartMs: 9300, actionEndMs: 9400, endMs: 12_000, callouts: [],
    },
  ],
};

describe('resolveGifWindow', () => {
  it('resolves a from..to range on the trimmed timeline', () => {
    expect(resolveGifWindow(manifest, 2700, 'modal..outro')).toEqual({
      startMs: 3300,
      endMs: 9300,
    });
  });

  it('treats a single id as a one-step window', () => {
    expect(resolveGifWindow(manifest, 2700, 'modal')).toEqual({ startMs: 3300, endMs: 6300 });
  });

  it('applies the retime map', () => {
    const window = resolveGifWindow(manifest, 2700, 'modal', (ms) => ms / 2);
    expect(window).toEqual({ startMs: 1650, endMs: 3150 });
  });

  it('throws on unknown step ids and backwards ranges', () => {
    expect(() => resolveGifWindow(manifest, 0, 'nope')).toThrow(/No step "nope"/);
    expect(() => resolveGifWindow(manifest, 0, 'outro..intro')).toThrow(/backwards/);
  });
});

describe('buildGifArgs', () => {
  it('builds the two-pass palette chain', () => {
    const args = buildGifArgs({ source: '/out/t.mp4', output: '/out/t.gif', widthPx: 720, fps: 10 });
    const filter = args[args.indexOf('-filter_complex') + 1]!;
    expect(filter).toContain('fps=10,scale=720:-1:flags=lanczos,split[ga][gb]');
    expect(filter).toContain('[ga]palettegen=stats_mode=diff[gp]');
    expect(filter).toContain('[gb][gp]paletteuse=dither=bayer:bayer_scale=4[gout]');
    expect(args.at(-1)).toBe('/out/t.gif');
    expect(args).not.toContain('-ss');
  });

  it('overlays captions before downscaling, with source-time enable windows', () => {
    const args = buildGifArgs({
      source: '/out/t.mp4',
      output: '/out/t.gif',
      widthPx: 720,
      fps: 10,
      window: { startMs: 3300, endMs: 9300 },
      captions: { items: [{ file: '/cap/c1.png', startMs: 3600, endMs: 5600 }], bottomMarginPx: 24 },
    });
    const filter = args[args.indexOf('-filter_complex') + 1]!;
    expect(filter).toContain("[0:v][1:v]overlay=(W-w)/2:H-h-24:enable='between(t,3.600,5.600)'[gc0]");
    expect(filter.indexOf('overlay')).toBeLessThan(filter.indexOf('scale='));
    // window trim is an output option so enable times stay on the source clock
    expect(args[args.indexOf('-ss') + 1]).toBe('3.300');
    expect(args[args.indexOf('-t') + 1]).toBe('6.000');
    expect(args.indexOf('-ss')).toBeGreaterThan(args.indexOf('-filter_complex'));
  });
});
