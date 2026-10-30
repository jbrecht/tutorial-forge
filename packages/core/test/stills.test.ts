import { mkdtemp, mkdir, writeFile, readFile, readdir, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { deflateSync } from 'node:zlib';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  exportStills,
  pngSize,
  selectStillStepIds,
  selectStillSteps,
  stillFileName,
  stillsDir,
  stillsEntries,
  stillsIndexJson,
  stillsIndexMarkdown,
  validateStillsSelection,
  type StillsIndexMeta,
} from '../src/pipeline/stills.js';
import type { ManifestStep, TimingManifest } from '../src/types.js';

const step = (id: string, over: Partial<ManifestStep> = {}): ManifestStep => ({
  id,
  narration: `Do ${id}.`,
  audioFile: null,
  audioDurationMs: 0,
  startMs: 0,
  actionStartMs: 0,
  actionEndMs: 0,
  endMs: 0,
  callouts: [],
  ...over,
});

const manifest = (ids: Array<string | ManifestStep>): TimingManifest => ({
  tutorialId: 'run-an-event',
  fps: 25,
  recordingStartEpochMs: 0,
  steps: ids.map((s) => (typeof s === 'string' ? step(s) : s)),
  totalDurationMs: 0,
});

const meta: StillsIndexMeta = {
  tutorialId: 'run-an-event',
  title: 'Run an event',
  viewport: { width: 1920, height: 1080 },
};

/** A real, decodable PNG of a solid colour — enough for pngSize and pixel comparison. */
function pngOf(width: number, height: number, rgb: [number, number, number]): Buffer {
  const stride = width * 3;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    for (let x = 0; x < width; x++) {
      const o = y * (stride + 1) + 1 + x * 3;
      raw[o] = rgb[0];
      raw[o + 1] = rgb[1];
      raw[o + 2] = rgb[2];
    }
  }
  const chunk = (type: string, body: Buffer): Buffer => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(body.length);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), body]);
    const crc = Buffer.alloc(4); // CRC unchecked by our decoder
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: truecolour
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Build a work dir whose steps/ holds the given frames. `@before` suffix = pre-action. */
async function fixture(frames: string[], colour: [number, number, number] = [10, 20, 30]) {
  const root = await mkdtemp(join(tmpdir(), 'forge-stills-'));
  const workDir = join(root, 'work');
  await mkdir(join(workDir, 'steps'), { recursive: true });
  for (const f of frames) await writeFile(join(workDir, 'steps', `${f}.png`), pngOf(8, 4, colour));
  return { root, workDir, outDir: join(root, 'out-stills') };
}

describe('stillsDir', () => {
  it('sits next to the video, named after it', () => {
    expect(stillsDir('/out/run-an-event.mp4')).toBe('/out/run-an-event-stills');
  });

  it('gives a localized render its own directory', () => {
    expect(stillsDir('/out/run-an-event.es.mp4')).toBe('/out/run-an-event.es-stills');
  });
});

describe('stillFileName (#71 §6)', () => {
  it('names a still for its step id, so a docs link survives inserting a step', () => {
    // No position prefix: inserting a step earlier must not rename this file.
    expect(stillFileName('set-status')).toBe('set-status.png');
  });

  it('collapses characters that would break a filename or markdown link', () => {
    expect(stillFileName('save draft')).toBe('save-draft.png');
    expect(stillFileName('pick (type)?')).toBe('pick-type.png');
    expect(stillFileName('../escaped')).toBe('escaped.png');
    expect(stillFileName('a/b')).toBe('a-b.png');
    expect(stillFileName('..')).toBe('step.png');
  });

  it('leaves slug-shaped ids alone', () => {
    expect(stillFileName('step_01.v2')).toBe('step_01.v2.png');
  });
});

describe('selection parsing', () => {
  const m = manifest(['open', 'filter', 'set-status', 'save']);

  it('selects every step when no expression is given', () => {
    expect(selectStillSteps(m)).toEqual([0, 1, 2, 3]);
    expect(selectStillSteps(m, '  ')).toEqual([0, 1, 2, 3]);
  });

  it('selects ids and ranges, collapsing duplicates into tutorial order', () => {
    expect(selectStillSteps(m, 'set-status')).toEqual([2]);
    expect(selectStillSteps(m, 'filter..save')).toEqual([1, 2, 3]);
    expect(selectStillSteps(m, 'save, open..filter, open')).toEqual([0, 1, 3]);
  });

  it('throws on an unknown id, a backwards range, or a selection matching nothing', () => {
    expect(() => selectStillSteps(m, 'nope')).toThrow(/No step "nope"/);
    expect(() => selectStillSteps(m, 'save..open')).toThrow(/runs backwards/);
    for (const bad of [',', ' , ', ',,']) {
      expect(() => selectStillSteps(m, bad)).toThrow(/selected no steps/);
    }
  });

  it('pre-flights a selection against the spec, before recording', () => {
    const ids = ['open', 'save'];
    expect(() => validateStillsSelection(ids, 't', 'save')).not.toThrow();
    expect(() => validateStillsSelection(ids, 't', 'open..nope')).toThrow(/No step "nope"/);
    expect(() => validateStillsSelection(ids, 't', undefined)).not.toThrow();
    expect(selectStillStepIds(ids, 't', 'open,')).toEqual([0]);
  });
});

describe('stillsEntries — frame selection (#71 §1)', () => {
  it('publishes the pre-action frame by default', () => {
    const [e] = stillsEntries(manifest(['save']), '/work');
    // The point of §1: a "click Save" caption must not sit over the screen
    // Save led to, so the default source is the pre-action capture.
    expect(e!.source).toBe(join('/work', 'steps', 'save@before.png'));
    expect(e!.file).toBe('save.png');
  });

  it('publishes the settled frame when asked', () => {
    const [e] = stillsEntries(manifest(['save']), '/work', undefined, undefined, { capture: 'after' });
    expect(e!.source).toBe(join('/work', 'steps', 'save.png'));
    expect(e!.file).toBe('save.png');
  });

  it('lets a step override the render default — the result-is-the-point case', () => {
    const entries = stillsEntries(
      manifest([step('click-save'), step('list-updates', { still: 'after' })]),
      '/work',
      undefined,
      undefined,
      { capture: 'before' },
    );
    expect(entries.map((e) => [e.id, e.source.endsWith('@before.png')])).toEqual([
      ['click-save', true],
      ['list-updates', false],
    ]);
  });

  it('exports exactly one still per step', () => {
    expect(stillsEntries(manifest(['a', 'b', 'c']), '/w')).toHaveLength(3);
  });
});

describe('stillsEntries — captions (#71 §4)', () => {
  it('uses narration as the caption by default', () => {
    expect(stillsEntries(manifest(['save']), '/w')[0]!.narration).toBe('Do save.');
  });

  it('prefers an explicit alt over narration, since narration is spoken not shown', () => {
    const m = manifest([step('continue', { narration: 'Click Continue to go on.', alt: 'The interests form.' })]);
    expect(stillsEntries(m, '/w')[0]!.narration).toBe('The interests form.');
  });

  it('honours an empty alt as a deliberate blank', () => {
    const m = manifest([step('decorative', { alt: '' })]);
    expect(stillsEntries(m, '/w')[0]!.narration).toBe('');
  });
});

describe('stillsEntries — numbering and partial manifests', () => {
  const tutorialIds = ['open', 'filter', 'save'];

  it('keeps tutorial-order indices for the steps that recorded', () => {
    const entries = stillsEntries(manifest(['open', 'filter']), '/work', undefined, tutorialIds);
    expect(entries.map((e) => [e.index, e.id, e.recorded])).toEqual([
      [1, 'open', true],
      [2, 'filter', true],
      [3, 'save', false],
    ]);
  });

  it('does not abandon the export when a selection names a step that never ran', () => {
    const entries = stillsEntries(manifest(['open']), '/work', 'open..save', tutorialIds);
    expect(entries.map((e) => e.id)).toEqual(['open', 'filter', 'save']);
  });

  it('throws only for ids absent from the whole tutorial', () => {
    expect(() => stillsEntries(manifest(['open']), '/w', 'save', tutorialIds)).not.toThrow();
    expect(() => stillsEntries(manifest(['open']), '/w', 'typo', tutorialIds)).toThrow(/No step "typo"/);
  });

  it('rejects two steps that would collide on one filename', () => {
    expect(() => stillsEntries(manifest(['save draft', 'save-draft']), '/w')).toThrow(
      /Steps "save draft" and "save-draft" .* both produce the still "save-draft.png"/s,
    );
  });
});

describe('index documents', () => {
  it('carries id, file and caption for each still', () => {
    const entries = stillsEntries(manifest(['open', 'save']), '/work');
    const parsed = JSON.parse(stillsIndexJson(entries, meta));
    expect(parsed.tutorialId).toBe('run-an-event');
    expect(parsed.stills).toEqual([
      { index: 1, id: 'open', file: 'open.png', narration: 'Do open.' },
      { index: 2, id: 'save', file: 'save.png', narration: 'Do save.' },
    ]);
  });

  it('is deterministic and timestamp-free', () => {
    const entries = stillsEntries(manifest(['open']), '/w');
    expect(stillsIndexJson(entries, meta)).toBe(stillsIndexJson(entries, meta));
    expect(JSON.parse(stillsIndexJson(entries, meta))).not.toHaveProperty('generatedAt');
  });

  it('omits lang unless the render was localized', () => {
    const entries = stillsEntries(manifest(['open']), '/w');
    expect(JSON.parse(stillsIndexJson(entries, meta))).not.toHaveProperty('lang');
    expect(JSON.parse(stillsIndexJson(entries, { ...meta, lang: 'es' })).lang).toBe('es');
  });

  it('heads each markdown section with the caption, not the raw step id (#71 §4)', () => {
    const m = manifest([step('city-bio', { narration: 'Tell people where you live. It shows on your profile.' })]);
    const md = stillsIndexMarkdown(stillsEntries(m, '/w'), meta);
    expect(md).toContain('## 1. Tell people where you live');
    expect(md).not.toContain('## 1. city-bio');
  });

  it('falls back to the step id when there is no caption', () => {
    const md = stillsIndexMarkdown(stillsEntries(manifest([step('silent', { narration: '  ' })]), '/w'), meta);
    expect(md).toContain('## 1. silent');
    expect(md).toContain('![silent](silent.png)');
  });

  it('emits a paste-ready captioned image, escaping and encoding safely', () => {
    const m = manifest([step('pick', { narration: 'Choose [Save]\nthen wait' })]);
    const md = stillsIndexMarkdown(stillsEntries(m, '/w'), meta);
    expect(md).toContain('![Choose \\[Save\\] then wait](pick.png)');
  });
});

describe('exportStills', () => {
  it('copies the pre-action frames and writes both indexes', async () => {
    const f = await fixture(['open@before', 'save@before']);
    const result = await exportStills({
      entries: stillsEntries(manifest(['open', 'save']), f.workDir),
      outDir: f.outDir,
      meta,
    });

    expect(result.dir).toBe(f.outDir);
    expect(result.missing).toEqual([]);
    expect((await readdir(f.outDir)).sort()).toEqual(['index.json', 'index.md', 'open.png', 'save.png']);
  });

  it('reports a step whose frame is missing instead of failing', async () => {
    const f = await fixture(['open@before']);
    const result = await exportStills({
      entries: stillsEntries(manifest(['open', 'save']), f.workDir),
      outDir: f.outDir,
      meta,
    });
    expect(result.files).toHaveLength(1);
    expect(result.missing).toEqual(['save']);
    expect(JSON.parse(await readFile(join(f.outDir, 'index.json'), 'utf8')).stills).toHaveLength(1);
  });

  it('writes nothing — and destroys nothing — when this pass recorded no frames', async () => {
    const f = await fixture([]);
    const result = await exportStills({
      entries: stillsEntries(manifest(['open']), f.workDir),
      outDir: f.outDir,
      meta,
    });
    expect(result).toMatchObject({ dir: null, files: [], missing: ['open'], kept: 0, pruned: 0 });
    await expect(readdir(f.outDir)).rejects.toThrow();
  });

  it('does not publish a leftover frame for a step that did not record this pass', async () => {
    const f = await fixture(['open@before', 'filter@before', 'save@before']);
    const result = await exportStills({
      entries: stillsEntries(manifest(['open']), f.workDir, undefined, ['open', 'filter', 'save']),
      outDir: f.outDir,
      meta,
      tutorialStepIds: ['open', 'filter', 'save'],
    });
    expect(result.files.map((p) => p.split('/').pop())).toEqual(['open.png']);
    expect(result.missing).toEqual(['filter', 'save']);
  });

});

describe('exportStills — re-export reconciliation', () => {
  async function exported(tutorialIds: string[], frames = tutorialIds.map((id) => `${id}@before`)) {
    const f = await fixture(frames);
    const run = (steps?: string, ids: string[] = tutorialIds, markdown = true) =>
      exportStills({
        entries: stillsEntries(manifest(tutorialIds.filter((id) => frames.includes(`${id}@before`))), f.workDir, steps, ids),
        outDir: f.outDir,
        meta,
        config: { markdown },
        tutorialStepIds: ids,
      });
    return { ...f, run };
  }

  it("never deletes an author's own files, whatever they are named", async () => {
    const f = await exported(['open']);
    await f.run();
    await writeFile(join(f.outDir, 'open-annotated.png'), 'AUTHOR WORK');
    await writeFile(join(f.outDir, '2024-release.png'), 'AUTHOR WORK');
    await writeFile(join(f.outDir, 'notes.md'), 'mine');

    const result = await f.run();

    expect(result.pruned).toBe(0);
    for (const name of ['open-annotated.png', '2024-release.png', 'notes.md']) {
      expect(await readFile(join(f.outDir, name), 'utf8')).toMatch(/AUTHOR WORK|mine/);
    }
  });

  it('removes an orphan whose step left the tutorial', async () => {
    const f = await exported(['open', 'filter']);
    await f.run();
    expect(await readdir(f.outDir)).toContain('filter.png');

    const result = await f.run(undefined, ['open']);

    expect(result.pruned).toBe(1);
    expect(await readdir(f.outDir)).not.toContain('filter.png');
  });

  it('merges a subset re-export instead of discarding the rest', async () => {
    const f = await exported(['open', 'filter', 'save']);
    await f.run();

    const result = await f.run('save');

    expect(result.files).toHaveLength(1);
    expect(result.kept).toBe(2);
    expect((await readdir(f.outDir)).sort()).toEqual([
      'filter.png',
      'index.json',
      'index.md',
      'open.png',
      'save.png',
    ]);
    const index = JSON.parse(await readFile(join(f.outDir, 'index.json'), 'utf8'));
    expect(index.stills.map((e: { id: string }) => e.id)).toEqual(['open', 'filter', 'save']);
  });

  it('removes a stale index.md when markdown is turned off', async () => {
    const f = await exported(['open']);
    await f.run();
    const result = await f.run(undefined, ['open'], false);
    expect(result.indexMarkdownPath).toBeNull();
    expect(await readdir(f.outDir)).not.toContain('index.md');
  });

  it('drops a carried-forward entry whose file an author deleted', async () => {
    const f = await exported(['open', 'save']);
    await f.run();
    await unlink(join(f.outDir, 'open.png'));
    const result = await f.run('save');
    expect(result.kept).toBe(0);
  });
});


describe('pngSize', () => {
  it('reads dimensions out of a real PNG', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'forge-png-'));
    const file = join(dir, 'a.png');
    await writeFile(file, pngOf(64, 32, [1, 2, 3]));
    expect(await pngSize(file)).toEqual({ width: 64, height: 32 });
  });

  it('returns undefined for a missing file, a non-PNG, or a truncated one', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'forge-png-bad-'));
    await writeFile(join(dir, 'b.png'), 'this is not a png at all!!');
    await writeFile(join(dir, 'c.png'), pngOf(8, 8, [0, 0, 0]).subarray(0, 12));
    expect(await pngSize(join(dir, 'nope.png'))).toBeUndefined();
    expect(await pngSize(join(dir, 'b.png'))).toBeUndefined();
    expect(await pngSize(join(dir, 'c.png'))).toBeUndefined();
  });

  it('stamps the real exported pixel size into the index', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forge-dsf-'));
    const workDir = join(root, 'work');
    await mkdir(join(workDir, 'steps'), { recursive: true });
    await writeFile(join(workDir, 'steps', 'open@before.png'), pngOf(3840, 4, [0, 0, 0]));
    const outDir = join(root, 'out-stills');
    await exportStills({ entries: stillsEntries(manifest(['open']), workDir), outDir, meta });
    const index = JSON.parse(await readFile(join(outDir, 'index.json'), 'utf8'));
    expect(index.viewport).toEqual({ width: 1920, height: 1080 });
    expect(index.pixelSize).toEqual({ width: 3840, height: 4 });
  });
});

describe('regressions from the second review round (#71)', () => {
  const mkIds = (ids: string[]) => ids;

  it('rejects colliding filenames across the whole tutorial, not just the selection', () => {
    // Previously a subset export dodged the check and two steps silently wrote
    // onto one file with two captions in the index.
    expect(() => stillsEntries(manifest(['a b', 'a-b']), '/w', 'a b')).toThrow(/both produce the still/);
    expect(() => stillsEntries(manifest(['a b', 'a-b']), '/w', 'a-b')).toThrow(/both produce the still/);
  });


  it('validates the capture mode for programmatic callers who bypass zod', () => {
    expect(() =>
      stillsEntries(manifest(['open']), '/w', undefined, undefined, { capture: 'Before' as never }),
    ).toThrow(/Invalid stills capture mode "Before" for step "open" \(expected before \| after\)/);
    expect(() => stillsEntries(manifest([step('open', { still: 'both' as never })]), '/w')).toThrow(
      /Invalid stills capture mode "both"/,
    );
  });


  it('derives headings without splitting on abbreviations or cutting graphemes', () => {
    const abbrev = manifest([step('a', { narration: 'Open the file, e.g. report.pdf. Then click Save.' })]);
    expect(stillsIndexMarkdown(stillsEntries(abbrev, '/w'), meta)).toContain(
      '## 1. Open the file, e.g. report.pdf',
    );

    const emoji = manifest([step('b', { narration: `Pick a plan ${'😀'.repeat(40)} and continue.` })]);
    const md = stillsIndexMarkdown(stillsEntries(emoji, '/w'), meta);
    const heading = md.split('\n').find((l) => l.startsWith('## '))!;
    // No lone surrogate may reach the author's docs.
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(heading)).toBe(false);

    const cjk = manifest([step('c', { narration: 'イベントを作成します。次に保存します。' })]);
    expect(stillsIndexMarkdown(stillsEntries(cjk, '/w'), meta)).toContain('## 1. イベントを作成します');
  });

  it('strips markdown-significant characters from headings', () => {
    const m = manifest([step('d', { narration: 'Use the [Save] `button` # now. Then wait.' })]);
    const heading = stillsIndexMarkdown(stillsEntries(m, '/w'), meta)
      .split('\n')
      .find((l) => l.startsWith('## '))!
      .slice(3); // drop the "## " marker itself
    expect(heading).not.toMatch(/[\[\]`#]/);
  });


});


