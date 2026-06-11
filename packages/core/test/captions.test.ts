import { describe, expect, it } from 'vitest';
import { captionHtml, DEFAULT_CAPTION_STYLE } from '../src/post/captions.js';
import { computeCues } from '../src/post/subtitles.js';
import type { TimingManifest } from '../src/types.js';

describe('captionHtml', () => {
  it('applies the style values', () => {
    const html = captionHtml('Hello', { fontSizePx: 40, maxWidthPx: 1200, bottomMarginPx: 24 });
    expect(html).toContain('font-size:40px');
    expect(html).toContain('max-width:1200px');
    expect(html).toContain('Hello');
  });

  it('escapes HTML in narration text', () => {
    const html = captionHtml('Use <Enter> & "quotes"', DEFAULT_CAPTION_STYLE);
    expect(html).toContain('Use &lt;Enter&gt; &amp; &quot;quotes&quot;');
    expect(html).not.toContain('<Enter>');
  });
});

describe('computeCues', () => {
  const manifest: TimingManifest = {
    tutorialId: 't',
    fps: 25,
    recordingStartEpochMs: 0,
    totalDurationMs: 20_000,
    steps: [
      {
        id: 'a', narration: 'First.', audioFile: '/a.wav', audioDurationMs: 2000,
        startMs: 5000, actionStartMs: 5300, actionEndMs: 5400, endMs: 7700, callouts: [],
      },
      {
        id: 'b', narration: '', audioFile: null, audioDurationMs: 0,
        startMs: 7700, actionStartMs: 8000, actionEndMs: 8100, endMs: 8500, callouts: [],
      },
    ],
  };

  it('emits output-timeline cues for narrated steps only', () => {
    const cues = computeCues(manifest, { leadInMs: 300, trimStartMs: 4700 });
    expect(cues).toEqual([{ text: 'First.', startMs: 600, endMs: 2600 }]);
  });

  it('maps through a retime map, keeping narration at 1x', () => {
    const cues = computeCues(manifest, { leadInMs: 300, trimStartMs: 4700, mapMs: (ms) => ms / 2 });
    expect(cues[0]).toEqual({ text: 'First.', startMs: 300, endMs: 2300 });
  });
});
