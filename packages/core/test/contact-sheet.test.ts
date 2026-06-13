import { describe, expect, it } from 'vitest';
import {
  contactSheetHtml,
  contactSheetEntries,
  contactSheetPath,
  DEFAULT_CONTACT_SHEET_STYLE,
} from '../src/pipeline/contact-sheet.js';
import type { TimingManifest } from '../src/types.js';

const cell = (over: Partial<Parameters<typeof contactSheetHtml>[0][number]> = {}) => ({
  index: 1,
  id: 'open',
  narration: 'Open the page.',
  file: '/tmp/open.png',
  dataUri: 'data:image/png;base64,AAAA',
  ...over,
});

describe('contactSheetHtml', () => {
  it('labels each cell with its index and step id', () => {
    const html = contactSheetHtml(
      [cell({ index: 2, id: 'set-status' })],
      16 / 9,
      DEFAULT_CONTACT_SHEET_STYLE,
    );
    expect(html).toContain('2. set-status');
    expect(html).toContain('Open the page.');
  });

  it('derives thumb height from the viewport aspect', () => {
    const html = contactSheetHtml([cell()], 2, { thumbWidthPx: 480, columns: 3 });
    expect(html).toContain('width="480"');
    expect(html).toContain('height="240"'); // 480 / 2
    expect(html).toContain('grid-template-columns:repeat(3,480px)');
  });

  it('embeds the data URI when present', () => {
    const html = contactSheetHtml([cell()], 16 / 9, DEFAULT_CONTACT_SHEET_STYLE);
    expect(html).toContain('src="data:image/png;base64,AAAA"');
  });

  it('renders a placeholder when a screenshot is missing', () => {
    const html = contactSheetHtml([cell({ dataUri: null })], 16 / 9, DEFAULT_CONTACT_SHEET_STYLE);
    expect(html).toContain('no screenshot');
    expect(html).not.toContain('<img');
  });

  it('escapes HTML in id and narration', () => {
    const html = contactSheetHtml(
      [cell({ id: 'a<b>', narration: 'Use <Enter> & "go"' })],
      16 / 9,
      DEFAULT_CONTACT_SHEET_STYLE,
    );
    expect(html).toContain('Use &lt;Enter&gt; &amp; &quot;go&quot;');
    expect(html).not.toContain('<Enter>');
  });

  it('marks empty narration explicitly', () => {
    const html = contactSheetHtml([cell({ narration: '' })], 16 / 9, DEFAULT_CONTACT_SHEET_STYLE);
    expect(html).toContain('(no narration)');
  });
});

describe('contactSheetEntries', () => {
  it('maps manifest steps to steps/<id>.png under the work dir', () => {
    const manifest = {
      steps: [
        { id: 'a', narration: 'First.' },
        { id: 'b', narration: 'Second.' },
      ],
    } as TimingManifest;
    const entries = contactSheetEntries(manifest, '/work');
    expect(entries).toEqual([
      { index: 1, id: 'a', narration: 'First.', file: '/work/steps/a.png' },
      { index: 2, id: 'b', narration: 'Second.', file: '/work/steps/b.png' },
    ]);
  });
});

describe('contactSheetPath', () => {
  it('sits next to the video with a -contact-sheet suffix', () => {
    expect(contactSheetPath('/out/demo.mp4')).toBe('/out/demo-contact-sheet.png');
    expect(contactSheetPath('/out/demo.es.mp4')).toBe('/out/demo.es-contact-sheet.png');
  });
});
