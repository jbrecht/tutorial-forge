import { describe, expect, it } from 'vitest';
import { buildMergeArgs, parseFlashFromMetadata } from '../src/post/ffmpeg.js';
import type { TimingManifest } from '../src/types.js';

const manifest: TimingManifest = {
  tutorialId: 't',
  fps: 25,
  recordingStartEpochMs: 0,
  totalDurationMs: 20_000,
  steps: [
    {
      id: 'a', narration: 'one', audioFile: '/audio/a.wav', audioDurationMs: 2000,
      startMs: 3000, actionStartMs: 3300, actionEndMs: 3400, endMs: 5700, callouts: [],
    },
    {
      id: 'b', narration: '', audioFile: null, audioDurationMs: 0,
      startMs: 5700, actionStartMs: 6000, actionEndMs: 6100, endMs: 6500, callouts: [],
    },
    {
      id: 'c', narration: 'two', audioFile: '/audio/c.wav', audioDurationMs: 1000,
      startMs: 6500, actionStartMs: 6800, actionEndMs: 6900, endMs: 8200, callouts: [],
    },
  ],
};

function argsFor(overrides: Partial<Parameters<typeof buildMergeArgs>[0]> = {}) {
  return buildMergeArgs({
    rawVideo: '/work/raw.webm',
    manifest,
    audioFiles: manifest.steps.map((s) => s.audioFile),
    output: '/out/t.mp4',
    leadInMs: 300,
    trimStartMs: 2700, // steps[0].startMs - leadIn
    videoOffsetMs: 450, // calibration flash offset
    targetWidth: 1920,
    targetHeight: 1080,
    ...overrides,
  });
}

describe('buildMergeArgs', () => {
  it('lists video first, then only narrated audio inputs', () => {
    const args = argsFor();
    const inputs = args.flatMap((a, i) => (a === '-i' ? [args[i + 1]] : []));
    expect(inputs).toEqual(['/work/raw.webm', '/audio/a.wav', '/audio/c.wav']);
  });

  it('trims video in raw-video time (manifest clock + flash offset)', () => {
    const filter = argsFor()[argsFor().indexOf('-filter_complex') + 1]!;
    expect(filter).toContain('trim=start=3.150:end=20.450'); // 2700+450, 20000+450
    expect(filter).toContain('setpts=PTS-STARTPTS');
  });

  it('delays each clip relative to the trimmed start, in manifest time', () => {
    const filter = argsFor()[argsFor().indexOf('-filter_complex') + 1]!;
    expect(filter).toContain('[1:a]adelay=600:all=1[a0]'); // 3000+300-2700
    expect(filter).toContain('[2:a]adelay=4100:all=1[a1]'); // 6500+300-2700
    expect(filter).toContain('amix=inputs=3:duration=first:normalize=0');
    expect(filter).toContain('atrim=duration=17.300'); // 20000-2700
  });

  it('downscales to the target viewport and transcodes per spec', () => {
    const args = argsFor();
    const filter = args[args.indexOf('-filter_complex') + 1]!;
    expect(filter).toContain('scale=1920:1080:flags=lanczos');
    for (const expected of [['-c:v', 'libx264'], ['-crf', '18'], ['-preset', 'slow'], ['-pix_fmt', 'yuv420p'], ['-c:a', 'aac'], ['-b:a', '192k'], ['-movflags', '+faststart']]) {
      const i = args.indexOf(expected[0]!);
      expect(i, expected[0]).toBeGreaterThan(-1);
      expect(args[i + 1]).toBe(expected[1]);
    }
    expect(args.at(-1)).toBe('/out/t.mp4');
  });

  it('handles a fully silent tutorial without amix', () => {
    const args = argsFor({ audioFiles: [null, null, null] });
    const filter = args[args.indexOf('-filter_complex') + 1]!;
    expect(filter).not.toContain('amix');
    expect(filter).toContain('acopy');
  });

  it('burns subtitles when requested, with escaped path', () => {
    const args = argsFor({ burnSrt: '/out/t.srt' });
    const filter = args[args.indexOf('-filter_complex') + 1]!;
    expect(filter).toContain("subtitles='/out/t.srt'");
  });
});

describe('parseFlashFromMetadata', () => {
  it('finds the first magenta frame', () => {
    const out = [
      'frame:0 pts:0 pts_time:0',
      'lavfi.signalstats.UAVG=128.1',
      'lavfi.signalstats.VAVG=127.9',
      'frame:11 pts:367 pts_time:0.367',
      'lavfi.signalstats.UAVG=201.0',
      'lavfi.signalstats.VAVG=221.2',
      'frame:12 pts:400 pts_time:0.400',
      'lavfi.signalstats.UAVG=201.0',
      'lavfi.signalstats.VAVG=221.2',
    ].join('\n');
    expect(parseFlashFromMetadata(out)).toBe(367);
  });

  it('returns null when no flash is present', () => {
    const out = [
      'frame:0 pts:0 pts_time:0',
      'lavfi.signalstats.UAVG=128.0',
      'lavfi.signalstats.VAVG=128.0',
    ].join('\n');
    expect(parseFlashFromMetadata(out)).toBeNull();
  });
});
