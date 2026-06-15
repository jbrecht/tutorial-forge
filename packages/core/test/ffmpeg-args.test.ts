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

  it('adds the chapters ffmetadata input last and maps its metadata in', () => {
    const args = argsFor({ chaptersFile: '/work/chapters.ffmeta' });
    const inputs = args.flatMap((a, i) => (a === '-i' ? [args[i + 1]] : []));
    // ffmeta input follows the raw video + two audio inputs (index 3) so the
    // filter graph's stream indices stay stable.
    expect(inputs).toEqual(['/work/raw.webm', '/audio/a.wav', '/audio/c.wav', '/work/chapters.ffmeta']);
    expect(args[args.indexOf('-f') + 1]).toBe('ffmetadata');
    expect(args[args.indexOf('-map_metadata') + 1]).toBe('3');
  });

  it('places the chapters input after burned captions so its index is correct', () => {
    const args = argsFor({
      chaptersFile: '/work/chapters.ffmeta',
      captions: { items: [{ file: '/cap/cue-01.png', startMs: 600, endMs: 2600 }], bottomMarginPx: 24 },
    });
    const inputs = args.flatMap((a, i) => (a === '-i' ? [args[i + 1]] : []));
    expect(inputs).toEqual(['/work/raw.webm', '/audio/a.wav', '/audio/c.wav', '/cap/cue-01.png', '/work/chapters.ffmeta']);
    expect(args[args.indexOf('-map_metadata') + 1]).toBe('4'); // raw+2 audio+1 caption
  });

  it('omits -map_metadata when no chapters file is given', () => {
    expect(argsFor()).not.toContain('-map_metadata');
  });

  it('handles a fully silent tutorial without amix', () => {
    const args = argsFor({ audioFiles: [null, null, null] });
    const filter = args[args.indexOf('-filter_complex') + 1]!;
    expect(filter).not.toContain('amix');
    expect(filter).toContain('acopy');
  });

  it('composites burned captions after scale with enable windows', () => {
    const args = argsFor({
      captions: {
        items: [
          { file: '/cap/cue-01.png', startMs: 600, endMs: 2600 },
          { file: '/cap/cue-02.png', startMs: 4100, endMs: 5100 },
        ],
        bottomMarginPx: 24,
      },
    });
    const inputs = args.flatMap((a, i) => (a === '-i' ? [args[i + 1]] : []));
    expect(inputs).toEqual(['/work/raw.webm', '/audio/a.wav', '/audio/c.wav', '/cap/cue-01.png', '/cap/cue-02.png']);
    const filter = args[args.indexOf('-filter_complex') + 1]!;
    // caption inputs follow the two audio inputs → indices 3 and 4
    expect(filter).toContain("[vbase][3:v]overlay=(W-w)/2:H-h-24:enable='between(t,0.600,2.600)'[vcap0]");
    expect(filter).toContain("[vcap0][4:v]overlay=(W-w)/2:H-h-24:enable='between(t,4.100,5.100)'[vout]");
    // overlays come after scale so zoom/scale never distort the captions
    expect(filter.indexOf('scale=')).toBeLessThan(filter.indexOf('overlay='));
  });

  describe('cards (#37)', () => {
    const cards = {
      intro: { file: '/c/intro.png', durationMs: 4000 },
      recap: { file: '/c/recap.png', durationMs: 5000 },
    };

    it('appends looped card image inputs after the chapters ffmetadata', () => {
      const args = argsFor({ cards, chaptersFile: '/work/chapters.ffmeta' });
      const inputs = args.flatMap((a, i) => (a === '-i' ? [args[i + 1]] : []));
      expect(inputs).toEqual([
        '/work/raw.webm', '/audio/a.wav', '/audio/c.wav', '/work/chapters.ffmeta', '/c/intro.png', '/c/recap.png',
      ]);
      // each card image is looped into a fixed-duration still
      expect(args.join(' ')).toContain('-loop 1 -framerate 25 -t 4.000 -i /c/intro.png');
      expect(args.join(' ')).toContain('-loop 1 -framerate 25 -t 5.000 -i /c/recap.png');
      // the chapters metadata index is unaffected by the trailing card inputs
      expect(args[args.indexOf('-map_metadata') + 1]).toBe('3');
    });

    it('concatenates [intro] body [recap] into vout/aout', () => {
      const filter = argsFor({ cards })[argsFor({ cards }).indexOf('-filter_complex') + 1]!;
      // body keeps its own intermediate labels, normalized for concat
      expect(filter).toContain('[0:v]trim=');
      expect(filter).toContain('[vbody0]');
      expect(filter).toContain('[vbody0]fps=25,format=yuv420p,setsar=1[vbody]');
      expect(filter).toContain('amix=inputs=3:duration=first:normalize=0[abody]');
      // card video segments scaled + normalized; card audio is matching silence
      expect(filter).toContain('[3:v]scale=1920:1080:flags=lanczos,fps=25,format=yuv420p,setsar=1[vintro]');
      expect(filter).toContain('anullsrc=channel_layout=mono:sample_rate=48000,atrim=duration=4.000[aintro]');
      expect(filter).toContain('[4:v]scale=1920:1080:flags=lanczos,fps=25,format=yuv420p,setsar=1[vrecap]');
      expect(filter).toContain('atrim=duration=5.000[arecap]');
      expect(filter).toContain('[vintro][aintro][vbody][abody][vrecap][arecap]concat=n=3:v=1:a=1[vout][aout]');
    });

    it('handles an intro-only card (concat of 2 segments)', () => {
      const filter = argsFor({ cards: { intro: cards.intro } })[
        argsFor({ cards: { intro: cards.intro } }).indexOf('-filter_complex') + 1
      ]!;
      expect(filter).toContain('[vintro][aintro][vbody][abody]concat=n=2:v=1:a=1[vout][aout]');
      expect(filter).not.toContain('vrecap');
    });

    it('keeps body-relative caption windows; concat shifts them', () => {
      const filter = argsFor({
        cards: { intro: cards.intro },
        captions: { items: [{ file: '/cap/cue-01.png', startMs: 600, endMs: 2600 }], bottomMarginPx: 24 },
      })[argsFor({ cards: { intro: cards.intro }, captions: { items: [{ file: '/cap/cue-01.png', startMs: 600, endMs: 2600 }], bottomMarginPx: 24 } }).indexOf('-filter_complex') + 1]!;
      // the last caption overlay terminates at the body label, not vout
      expect(filter).toContain("enable='between(t,0.600,2.600)'[vbody0]");
      expect(filter).toContain('concat=n=2:v=1:a=1[vout][aout]');
    });

    it('still maps vout/aout (unchanged) so downstream flags are untouched', () => {
      const args = argsFor({ cards });
      expect(args[args.indexOf('-map') + 1]).toBe('[vout]');
      expect(args.slice(args.indexOf('-map') + 2).includes('[aout]')).toBe(true);
    });

    const retime = {
      filter: 'setpts=0.5*PTS',
      mapMs: (ms: number) => ms / 2,
      outputDurationMs: 8650,
      fps: 25,
    };

    it('composes with idle-speedup retime: body normalized at the retime fps, indices unchanged', () => {
      const args = argsFor({ cards, retime });
      const filter = args[args.indexOf('-filter_complex') + 1]!;
      // retime runs inside the body chain, before the concat boundary
      expect(filter).toContain('setpts=0.5*PTS');
      expect(filter.indexOf('setpts=0.5*PTS')).toBeLessThan(filter.indexOf('[vbody0]'));
      expect(filter).toContain('[vbody0]fps=25,format=yuv420p,setsar=1[vbody]');
      // retime adds no input, so card images keep indices 3/4 and concat is intact
      const inputs = args.flatMap((a, i) => (a === '-i' ? [args[i + 1]] : []));
      expect(inputs).toEqual(['/work/raw.webm', '/audio/a.wav', '/audio/c.wav', '/c/intro.png', '/c/recap.png']);
      expect(filter).toContain('[3:v]scale=1920:1080:flags=lanczos,fps=25,format=yuv420p,setsar=1[vintro]');
      expect(filter).toContain('concat=n=3:v=1:a=1[vout][aout]');
    });

    it('composes with zoom: zoom sits in the body chain, card indices unaffected', () => {
      const args = argsFor({ cards, zoomFilter: 'zoompan=z=1.2:d=1' });
      const filter = args[args.indexOf('-filter_complex') + 1]!;
      expect(filter.indexOf('zoompan=z=1.2:d=1')).toBeLessThan(filter.indexOf('[vbody0]'));
      // zoom adds no input → cards still at 3/4
      expect(filter).toContain('[3:v]scale=1920:1080:flags=lanczos');
      expect(filter).toContain('[4:v]scale=1920:1080:flags=lanczos');
      expect(filter).toContain('concat=n=3:v=1:a=1[vout][aout]');
    });

    it('kitchen sink — cards + captions + chapters + retime: input order + map_metadata index hold', () => {
      const args = argsFor({
        cards,
        retime,
        chaptersFile: '/work/chapters.ffmeta',
        captions: { items: [{ file: '/cap/cue-01.png', startMs: 600, endMs: 2600 }], bottomMarginPx: 24 },
      });
      const inputs = args.flatMap((a, i) => (a === '-i' ? [args[i + 1]] : []));
      // raw, 2 audio, 1 caption, ffmeta, intro, recap — cards always last
      expect(inputs).toEqual([
        '/work/raw.webm', '/audio/a.wav', '/audio/c.wav', '/cap/cue-01.png', '/work/chapters.ffmeta', '/c/intro.png', '/c/recap.png',
      ]);
      // chapters metadata index = raw + 2 audio + 1 caption = 4, unaffected by the trailing cards
      expect(args[args.indexOf('-map_metadata') + 1]).toBe('4');
      const filter = args[args.indexOf('-filter_complex') + 1]!;
      // the caption overlay terminates at the body label (body-relative), then the body normalizes + concats
      expect(filter).toContain("enable='between(t,0.600,2.600)'[vbody0]");
      expect(filter).toContain('[5:v]scale=1920:1080:flags=lanczos,fps=25,format=yuv420p,setsar=1[vintro]');
      expect(filter).toContain('[6:v]scale=1920:1080:flags=lanczos,fps=25,format=yuv420p,setsar=1[vrecap]');
      expect(filter).toContain('concat=n=3:v=1:a=1[vout][aout]');
    });

    it('handles a fully silent tutorial with cards (acopy body audio feeds the concat)', () => {
      const filter = argsFor({ cards, audioFiles: [null, null, null] })[
        argsFor({ cards, audioFiles: [null, null, null] }).indexOf('-filter_complex') + 1
      ]!;
      expect(filter).toContain('[abase]acopy[abody]');
      expect(filter).not.toContain('amix');
      expect(filter).toContain('[vintro][aintro][vbody][abody][vrecap][arecap]concat=n=3:v=1:a=1[vout][aout]');
    });
  });

  it('without cards, the graph is the pre-#37 shape — no body/concat scaffolding', () => {
    const filter = argsFor()[argsFor().indexOf('-filter_complex') + 1]!;
    for (const token of ['vbody0', 'vbody', 'concat=', 'vintro', 'vrecap', 'aintro', 'arecap']) {
      expect(filter, `no-cards graph must not contain "${token}"`).not.toContain(token);
    }
    // body video flows straight to [vout]; audio mix straight to [aout]
    expect(filter).toContain('[vout]');
    expect(filter).toContain('amix=inputs=3:duration=first:normalize=0[aout]');
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

  it('detects a limited-range / compression-dimmed magenta frame (#46 regression)', () => {
    // Same flash decoded as limited range scales toward center (~177/195) and
    // straddled the old 180/170 cutoff — the intermittent CI miss this fixes.
    const out = [
      'frame:0 pts:0 pts_time:0',
      'lavfi.signalstats.UAVG=129.0',
      'lavfi.signalstats.VAVG=127.0',
      'frame:9 pts:300 pts_time:0.300',
      'lavfi.signalstats.UAVG=177.0',
      'lavfi.signalstats.VAVG=195.0',
    ].join('\n');
    expect(parseFlashFromMetadata(out)).toBe(300);
  });

  it('stays magenta-specific: a single elevated chroma channel is not a flash', () => {
    // A saturated blue (high U, low V) or red (low U, high V) UI frame must not
    // be mistaken for the flash — magenta requires BOTH channels above neutral.
    const blueish = [
      'frame:3 pts:120 pts_time:0.120',
      'lavfi.signalstats.UAVG=205.0',
      'lavfi.signalstats.VAVG=120.0',
    ].join('\n');
    const reddish = [
      'frame:3 pts:120 pts_time:0.120',
      'lavfi.signalstats.UAVG=120.0',
      'lavfi.signalstats.VAVG=210.0',
    ].join('\n');
    expect(parseFlashFromMetadata(blueish)).toBeNull();
    expect(parseFlashFromMetadata(reddish)).toBeNull();
  });
});
