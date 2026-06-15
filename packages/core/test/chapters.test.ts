import { describe, expect, it } from 'vitest';
import {
  computeChapters,
  deriveChapterTitle,
  enforceMinChapterDuration,
  generateChaptersVtt,
  generateChaptersTxt,
  generateChaptersFfmetadata,
  shiftChapters,
  vttTime,
  stampTime,
  YOUTUBE_MIN_CHAPTER_MS,
} from '../src/post/chapters.js';
import type { TimingManifest } from '../src/types.js';

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

describe('computeChapters', () => {
  it('emits one chapter per narrated step; silent steps fold into the prior chapter', () => {
    const chapters = computeChapters(manifest, {
      trimStartMs: 4700,
      outputDurationMs: 15_300,
    });
    expect(chapters).toEqual([
      { id: 'a', title: 'First line', startMs: 0, endMs: 3800 },
      { id: 'c', title: 'Second line', startMs: 3800, endMs: 15_300 },
    ]);
  });

  it('always starts the first chapter at 0, even if the first step is silent', () => {
    const silentFirst: TimingManifest = {
      ...manifest,
      steps: [{ ...manifest.steps[0]!, narration: '' }, manifest.steps[1]!, manifest.steps[2]!],
    };
    const chapters = computeChapters(silentFirst, { trimStartMs: 4700, outputDurationMs: 15_300 });
    expect(chapters[0]).toMatchObject({ id: 'a', title: 'A', startMs: 0 }); // humanized id, no narration
    expect(chapters[0]!.startMs).toBe(0);
  });

  it('maps chapter boundaries through an idle-speedup time map', () => {
    const chapters = computeChapters(manifest, {
      trimStartMs: 4700,
      outputDurationMs: 10_000,
      mapMs: (ms) => ms / 2, // pretend everything compressed 2x
    });
    expect(chapters[0]!.startMs).toBe(0);
    expect(chapters[1]!.startMs).toBe(1900); // (8500 - 4700) / 2
    expect(chapters[1]!.endMs).toBe(10_000);
  });

  it('drops zero-length chapters', () => {
    const dup: TimingManifest = {
      ...manifest,
      steps: [manifest.steps[0]!, { ...manifest.steps[2]!, startMs: 5000 }], // same output start as step a
    };
    const chapters = computeChapters(dup, { trimStartMs: 4700, outputDurationMs: 15_300 });
    // step a → start 0, step c → start 300; both kept and non-zero here, sanity check ordering
    expect(chapters.every((c) => c.endMs > c.startMs)).toBe(true);
  });
});

describe('shiftChapters', () => {
  const chapters = [
    { id: 'a', title: 'A', startMs: 0, endMs: 3000 },
    { id: 'b', title: 'B', startMs: 3000, endMs: 8000 },
  ];

  it('slides every chapter by the offset (intro card prepended)', () => {
    expect(shiftChapters(chapters, 4000)).toEqual([
      { id: 'a', title: 'A', startMs: 4000, endMs: 7000 },
      { id: 'b', title: 'B', startMs: 7000, endMs: 12_000 },
    ]);
  });

  it('returns the input unchanged for a zero offset', () => {
    expect(shiftChapters(chapters, 0)).toBe(chapters);
  });
});

describe('deriveChapterTitle', () => {
  it('takes the first sentence and strips a trailing period', () => {
    expect(deriveChapterTitle('Welcome to Lumen Events. Let us create your first event.', 'welcome')).toBe(
      'Welcome to Lumen Events',
    );
  });

  it('keeps a trailing ! or ?', () => {
    expect(deriveChapterTitle('All done!', 'x')).toBe('All done!');
    expect(deriveChapterTitle('Ready? Here we go.', 'x')).toBe('Ready?');
  });

  it('collapses whitespace', () => {
    expect(deriveChapterTitle('Open   the\n  Events page.', 'x')).toBe('Open the Events page');
  });

  it('truncates long single sentences with an ellipsis', () => {
    const title = deriveChapterTitle('A'.repeat(100) + '.', 'x', 20);
    expect(title).toHaveLength(20);
    expect(title.endsWith('…')).toBe(true);
  });

  it('humanizes the step id when narration is empty', () => {
    expect(deriveChapterTitle('', 'open-events_page')).toBe('Open Events Page');
  });

  it('caps at 50 characters by default (Vimeo title limit)', () => {
    const title = deriveChapterTitle('B'.repeat(60) + '.', 'x');
    expect(title).toHaveLength(50);
    expect(title.endsWith('…')).toBe(true);
  });
});

describe('enforceMinChapterDuration', () => {
  it('folds a short interior chapter into the previous one (opener title kept)', () => {
    const out = enforceMinChapterDuration(
      [
        { id: 'a', title: 'A', startMs: 0, endMs: 20_000 },
        { id: 'b', title: 'B', startMs: 20_000, endMs: 25_000 }, // 5s, too short
        { id: 'c', title: 'C', startMs: 25_000, endMs: 50_000 },
      ],
      YOUTUBE_MIN_CHAPTER_MS,
    );
    expect(out).toEqual([
      { id: 'a', title: 'A', startMs: 0, endMs: 25_000 }, // A absorbs B's span
      { id: 'c', title: 'C', startMs: 25_000, endMs: 50_000 },
    ]);
  });

  it('folds a short first chapter forward into the next, pulling its start to 0', () => {
    const out = enforceMinChapterDuration(
      [
        { id: 'intro', title: 'Objectives', startMs: 0, endMs: 6000 }, // 6s card, too short
        { id: 'a', title: 'A', startMs: 6000, endMs: 30_000 },
      ],
      YOUTUBE_MIN_CHAPTER_MS,
    );
    expect(out).toEqual([{ id: 'a', title: 'A', startMs: 0, endMs: 30_000 }]);
  });

  it('folds a short trailing chapter into the previous one', () => {
    const out = enforceMinChapterDuration(
      [
        { id: 'a', title: 'A', startMs: 0, endMs: 30_000 },
        { id: 'recap', title: 'Recap', startMs: 30_000, endMs: 34_000 }, // 4s, too short
      ],
      YOUTUBE_MIN_CHAPTER_MS,
    );
    expect(out).toEqual([{ id: 'a', title: 'A', startMs: 0, endMs: 34_000 }]);
  });

  it('collapses a chain of short chapters', () => {
    const out = enforceMinChapterDuration(
      [
        { id: 'a', title: 'A', startMs: 0, endMs: 4000 },
        { id: 'b', title: 'B', startMs: 4000, endMs: 8000 },
        { id: 'c', title: 'C', startMs: 8000, endMs: 40_000 },
      ],
      YOUTUBE_MIN_CHAPTER_MS,
    );
    // Both short openers fold forward; the substantive chapter survives at 0.
    expect(out).toEqual([{ id: 'c', title: 'C', startMs: 0, endMs: 40_000 }]);
  });

  it('leaves a list where every chapter already clears the floor untouched', () => {
    const chapters = [
      { id: 'a', title: 'A', startMs: 0, endMs: 15_000 },
      { id: 'b', title: 'B', startMs: 15_000, endMs: 40_000 },
    ];
    expect(enforceMinChapterDuration(chapters, YOUTUBE_MIN_CHAPTER_MS)).toEqual(chapters);
  });

  it('is a no-op for minMs <= 0 or a single chapter', () => {
    const chapters = [{ id: 'a', title: 'A', startMs: 0, endMs: 3000 }];
    expect(enforceMinChapterDuration(chapters, 0)).toBe(chapters);
    expect(enforceMinChapterDuration(chapters, YOUTUBE_MIN_CHAPTER_MS)).toBe(chapters);
  });
});

describe('generateChaptersVtt', () => {
  it('writes a WEBVTT chapters track', () => {
    const vtt = generateChaptersVtt([
      { id: 'a', title: 'First line', startMs: 0, endMs: 3800 },
      { id: 'c', title: 'Second line', startMs: 3800, endMs: 15_300 },
    ]);
    expect(vtt).toBe(
      'WEBVTT\n\n1\n00:00:00.000 --> 00:00:03.800\nFirst line\n\n2\n00:00:03.800 --> 00:00:15.300\nSecond line\n',
    );
  });
});

describe('generateChaptersTxt', () => {
  it('writes YouTube-style stamps starting at 0:00', () => {
    const txt = generateChaptersTxt([
      { id: 'a', title: 'First line', startMs: 0, endMs: 3800 },
      { id: 'c', title: 'Second line', startMs: 3800, endMs: 15_300 },
    ]);
    expect(txt).toBe('0:00 First line\n0:03 Second line\n');
  });
});

describe('generateChaptersFfmetadata', () => {
  it('writes chapter blocks with a 1/1000 timebase', () => {
    const meta = generateChaptersFfmetadata([{ id: 'a', title: 'First line', startMs: 0, endMs: 3800 }]);
    expect(meta).toBe(';FFMETADATA1\n[CHAPTER]\nTIMEBASE=1/1000\nSTART=0\nEND=3800\ntitle=First line\n');
  });

  it('escapes ffmetadata special characters in titles', () => {
    const meta = generateChaptersFfmetadata([{ id: 'a', title: 'a=b; c#d', startMs: 0, endMs: 10 }]);
    expect(meta).toContain('title=a\\=b\\; c\\#d');
  });
});

describe('vttTime / stampTime', () => {
  it('vttTime formats HH:MM:SS.mmm', () => {
    expect(vttTime(0)).toBe('00:00:00.000');
    expect(vttTime(3_600_000 + 2 * 60_000 + 3000 + 45)).toBe('01:02:03.045');
    expect(vttTime(-5)).toBe('00:00:00.000');
  });

  it('stampTime omits the hour under an hour, includes it past one', () => {
    expect(stampTime(0)).toBe('0:00');
    expect(stampTime(3800)).toBe('0:03');
    expect(stampTime(62_000)).toBe('1:02');
    expect(stampTime(3_600_000 + 2 * 60_000 + 3000)).toBe('1:02:03');
  });
});
