import { mkdtemp, mkdir, writeFile, readFile, readdir, unlink, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import {
  exportStills,
  pngSize,
  selectStillStepIds,
  selectStillSteps,
  stillFileName,
  stillsDir,
  stillsEntries,
  stillsEquivalent,
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
  it('defaults to the step id alone, so a docs link survives inserting a step', () => {
    expect(stillFileName(3, 'set-status', 9)).toBe('set-status.png');
    // The same step at a different position keeps the same name.
    expect(stillFileName(7, 'set-status', 9)).toBe('set-status.png');
  });

  it('prefixes the tutorial position under the indexed scheme', () => {
    expect(stillFileName(3, 'set-status', 9, 'indexed')).toBe('03-set-status.png');
    expect(stillFileName(7, 'open', 120, 'indexed')).toBe('007-open.png');
  });

  it('suffixes the settled frame so both variants can coexist', () => {
    expect(stillFileName(3, 'save', 9, 'id', 'after')).toBe('save-after.png');
    expect(stillFileName(3, 'save', 9, 'indexed', 'after')).toBe('03-save-after.png');
  });

  it('collapses characters that would break a filename or markdown link', () => {
    expect(stillFileName(1, 'save draft', 8)).toBe('save-draft.png');
    expect(stillFileName(1, 'pick (type)?', 8)).toBe('pick-type.png');
    expect(stillFileName(1, '../escaped', 8)).toBe('escaped.png');
    expect(stillFileName(1, 'a/b', 8)).toBe('a-b.png');
    expect(stillFileName(1, '..', 8)).toBe('step.png');
  });

  it('leaves slug-shaped ids alone', () => {
    expect(stillFileName(3, 'step_01.v2', 8)).toBe('step_01.v2.png');
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
    expect(e!.variant).toBe('before');
    expect(e!.source).toBe(join('/work', 'steps', 'save@before.png'));
    expect(e!.file).toBe('save.png');
  });

  it('publishes the settled frame when asked', () => {
    const [e] = stillsEntries(manifest(['save']), '/work', undefined, undefined, { capture: 'after' });
    expect(e!.variant).toBe('after');
    expect(e!.source).toBe(join('/work', 'steps', 'save.png'));
    expect(e!.file).toBe('save.png');
  });

  it("emits both frames under capture: 'both', with distinct filenames", () => {
    const entries = stillsEntries(manifest(['save']), '/work', undefined, undefined, { capture: 'both' });
    expect(entries.map((e) => [e.variant, e.file])).toEqual([
      ['before', 'save.png'],
      ['after', 'save-after.png'],
    ]);
  });

  it('lets a step override the render default — the result-is-the-point case', () => {
    const entries = stillsEntries(
      manifest([step('click-save'), step('list-updates', { still: 'after' })]),
      '/work',
      undefined,
      undefined,
      { capture: 'before' },
    );
    expect(entries.map((e) => [e.id, e.variant])).toEqual([
      ['click-save', 'before'],
      ['list-updates', 'after'],
    ]);
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
      /both produce the still "save-draft.png".*filenames to "indexed"/s,
    );
    // The indexed scheme disambiguates by position, so it is allowed.
    expect(() =>
      stillsEntries(manifest(['save draft', 'save-draft']), '/w', undefined, undefined, {
        filenames: 'indexed',
      }),
    ).not.toThrow();
  });
});

describe('index documents', () => {
  it('carries id, file, variant-aware name and caption for each still', () => {
    const entries = stillsEntries(manifest(['open', 'save']), '/work');
    const parsed = JSON.parse(stillsIndexJson(entries, meta));
    expect(parsed.tutorialId).toBe('run-an-event');
    expect(parsed.stills).toEqual([
      { index: 1, id: 'open', file: 'open.png', narration: 'Do open.', variant: 'before' },
      { index: 2, id: 'save', file: 'save.png', narration: 'Do save.', variant: 'before' },
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

  it('exports both variants when asked', async () => {
    const f = await fixture(['save@before', 'save']);
    await exportStills({
      entries: stillsEntries(manifest(['save']), f.workDir, undefined, undefined, { capture: 'both' }),
      outDir: f.outDir,
      meta,
      config: { capture: 'both' },
    });
    expect((await readdir(f.outDir)).sort()).toEqual(['index.json', 'index.md', 'save-after.png', 'save.png']);
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

describe('re-render byte stability (#71 §5)', () => {
  it('treats a visually identical frame as unchanged and leaves the file alone', async () => {
    const f = await fixture(['open@before'], [100, 100, 100]);
    await exportStills({ entries: stillsEntries(manifest(['open']), f.workDir), outDir: f.outDir, meta });
    const before = await stat(join(f.outDir, 'open.png'));

    // Re-record the same screen, a few least-significant bits different —
    // what antialiasing/font rasterisation actually produces between runs.
    await writeFile(join(f.workDir, 'steps', 'open@before.png'), pngOf(8, 4, [104, 103, 97]));
    const result = await exportStills({
      entries: stillsEntries(manifest(['open']), f.workDir),
      outDir: f.outDir,
      meta,
    });

    expect(result.unchanged).toBe(1);
    const after = await stat(join(f.outDir, 'open.png'));
    expect(after.mtimeMs).toBe(before.mtimeMs);
  });

  it('does rewrite when the screen genuinely changed', async () => {
    const f = await fixture(['open@before'], [10, 10, 10]);
    await exportStills({ entries: stillsEntries(manifest(['open']), f.workDir), outDir: f.outDir, meta });

    await writeFile(join(f.workDir, 'steps', 'open@before.png'), pngOf(8, 4, [200, 30, 30]));
    const result = await exportStills({
      entries: stillsEntries(manifest(['open']), f.workDir),
      outDir: f.outDir,
      meta,
    });

    expect(result.unchanged).toBe(0);
  });

  it('compares pixels, not bytes, and treats a size change as different', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'forge-eq-'));
    const a = join(dir, 'a.png');
    const b = join(dir, 'b.png');
    const c = join(dir, 'c.png');
    await writeFile(a, pngOf(8, 4, [100, 100, 100]));
    await writeFile(b, pngOf(8, 4, [103, 97, 104])); // within tolerance
    await writeFile(c, pngOf(16, 4, [100, 100, 100])); // different dimensions

    expect(await stillsEquivalent(a, b)).toBe(true);
    expect(await stillsEquivalent(a, c)).toBe(false);
    expect(await stillsEquivalent(a, join(dir, 'missing.png'))).toBe(false);
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

  it('catches a step id that would collide with another step\'s -after frame', () => {
    expect(() => stillsEntries(manifest(['save', 'save-after']), '/w')).toThrow(
      /Steps "save" and "save-after" in tutorial "run-an-event" both produce the still "save-after.png"/,
    );
  });

  it('validates the capture mode for programmatic callers who bypass zod', () => {
    expect(() =>
      stillsEntries(manifest(['open']), '/w', undefined, undefined, { capture: 'Before' as never }),
    ).toThrow(/Invalid stills capture mode "Before" for step "open"/);
    expect(() => stillsEntries(manifest([step('open', { still: 'Both' as never })]), '/w')).toThrow(
      /Invalid stills capture mode "Both"/,
    );
  });

  it('distinguishes the two frames in the index and in markdown headings', () => {
    const entries = stillsEntries(manifest(['open']), '/w', undefined, undefined, { capture: 'both' });
    const parsed = JSON.parse(stillsIndexJson(entries, meta));
    expect(parsed.stills.map((e: { file: string; variant: string }) => [e.file, e.variant])).toEqual([
      ['open.png', 'before'],
      ['open-after.png', 'after'],
    ]);
    const md = stillsIndexMarkdown(entries, meta);
    expect(md).toContain('## 1. Do open');
    expect(md).toContain('## 1. Do open (result)');
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

  it('survives a malformed destination PNG instead of aborting the export', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'forge-badpng-'));
    const good = join(dir, 'good.png');
    const truncated = join(dir, 'truncated.png');
    await writeFile(good, pngOf(8, 4, [1, 2, 3]));
    // A half-written copy: valid signature, IHDR that declares more than it has.
    await writeFile(truncated, pngOf(8, 4, [1, 2, 3]).subarray(0, 20));
    await expect(stillsEquivalent(good, truncated)).resolves.toBe(false);
    await expect(stillsEquivalent(truncated, good)).resolves.toBe(false);
  });

  it('rejects an absurd declared size rather than allocating for it', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'forge-hugepng-'));
    const huge = pngOf(8, 4, [0, 0, 0]);
    huge.writeUInt32BE(100000, 16); // IHDR width
    const file = join(dir, 'huge.png');
    await writeFile(file, huge);
    await expect(stillsEquivalent(file, join(dir, 'other.png'))).resolves.toBe(false);
  });
});

describe('reconciliation keys on filename, not step id (#71)', () => {
  async function run(config: Parameters<typeof exportStills>[0]['config'], outDir: string, workDir: string) {
    return exportStills({
      entries: stillsEntries(manifest(['open', 'save']), workDir, undefined, ['open', 'save'], config),
      outDir,
      meta,
      config,
      tutorialStepIds: ['open', 'save'],
    });
  }

  it('prunes the old set when the filename scheme changes', async () => {
    const f = await fixture(['open@before', 'save@before']);
    await run({ filenames: 'indexed' }, f.outDir, f.workDir);
    expect((await readdir(f.outDir)).filter((n) => n.endsWith('.png')).sort()).toEqual([
      '01-open.png',
      '02-save.png',
    ]);

    const result = await run({ filenames: 'id' }, f.outDir, f.workDir);

    expect(result.pruned).toBe(2);
    expect((await readdir(f.outDir)).filter((n) => n.endsWith('.png')).sort()).toEqual([
      'open.png',
      'save.png',
    ]);
  });

  it('prunes the orphaned -after frame when a step stops exporting both', async () => {
    const f = await fixture(['open@before', 'open', 'save@before', 'save']);
    await run({ capture: 'both' }, f.outDir, f.workDir);
    expect(await readdir(f.outDir)).toContain('open-after.png');

    const result = await run({ capture: 'before' }, f.outDir, f.workDir);

    expect(result.pruned).toBe(2);
    expect(await readdir(f.outDir)).not.toContain('open-after.png');
  });
});

describe('PNG decoding against real Playwright output shapes (#71 §5)', () => {
  /** Encode with a chosen per-scanline filter and channel count, optionally split across IDATs. */
  function pngFiltered(
    width: number,
    height: number,
    channels: 1 | 2 | 3 | 4,
    filter: 0 | 1 | 2 | 3 | 4,
    idatParts = 1,
  ): Buffer {
    const colorType = { 1: 0, 2: 4, 3: 2, 4: 6 }[channels];
    const stride = width * channels;
    const pixels = Buffer.alloc(stride * height);
    for (let i = 0; i < pixels.length; i++) pixels[i] = (i * 7 + 11) % 251;

    const raw = Buffer.alloc((stride + 1) * height);
    for (let y = 0; y < height; y++) {
      raw[y * (stride + 1)] = filter;
      for (let x = 0; x < stride; x++) {
        const cur = pixels[y * stride + x]!;
        const a = x >= channels ? pixels[y * stride + x - channels]! : 0;
        const b = y > 0 ? pixels[(y - 1) * stride + x]! : 0;
        const c = y > 0 && x >= channels ? pixels[(y - 1) * stride + x - channels]! : 0;
        let enc: number;
        switch (filter) {
          case 0: enc = cur; break;
          case 1: enc = cur - a; break;
          case 2: enc = cur - b; break;
          case 3: enc = cur - ((a + b) >> 1); break;
          default: {
            const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c);
            enc = cur - (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
          }
        }
        raw[y * (stride + 1) + 1 + x] = enc & 0xff;
      }
    }

    const chunk = (type: string, body: Buffer) => {
      const len = Buffer.alloc(4);
      len.writeUInt32BE(body.length);
      return Buffer.concat([len, Buffer.from(type, 'ascii'), body, Buffer.alloc(4)]);
    };
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width, 0);
    ihdr.writeUInt32BE(height, 4);
    ihdr[8] = 8;
    ihdr[9] = colorType;
    const compressed = deflateSync(raw);
    const parts: Buffer[] = [];
    const size = Math.ceil(compressed.length / idatParts);
    for (let i = 0; i < idatParts; i++) parts.push(chunk('IDAT', compressed.subarray(i * size, (i + 1) * size)));
    return Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk('IHDR', ihdr),
      chunk('tEXt', Buffer.from('Software\u0000forge', 'latin1')),
      ...parts,
      chunk('IEND', Buffer.alloc(0)),
    ]);
  }

  it('reconstructs every filter type and channel count identically', async () => {
    // Chromium emits RGBA with mixed per-scanline filters; a regression here
    // fails towards "equal", which would silently keep a stale screenshot.
    const dir = await mkdtemp(join(tmpdir(), 'forge-filters-'));
    for (const channels of [1, 2, 3, 4] as const) {
      const reference = join(dir, `ref-${channels}.png`);
      await writeFile(reference, pngFiltered(9, 6, channels, 0));
      for (const filter of [1, 2, 3, 4] as const) {
        const variant = join(dir, `f${filter}-${channels}.png`);
        await writeFile(variant, pngFiltered(9, 6, channels, filter));
        expect(
          await stillsEquivalent(reference, variant),
          `filter ${filter}, ${channels} channels`,
        ).toBe(true);
      }
    }
  });

  it('handles IDAT split across chunks, as real encoders emit', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'forge-idat-'));
    const one = join(dir, 'one.png');
    const many = join(dir, 'many.png');
    await writeFile(one, pngFiltered(16, 8, 4, 4, 1));
    await writeFile(many, pngFiltered(16, 8, 4, 4, 5));
    expect(await stillsEquivalent(one, many)).toBe(true);
  });

  it('still reports a genuinely different image as different', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'forge-diff-'));
    const a = join(dir, 'a.png');
    const b = join(dir, 'b.png');
    await writeFile(a, pngFiltered(9, 6, 3, 2));
    await writeFile(b, pngOf(9, 6, [200, 30, 30]));
    expect(await stillsEquivalent(a, b)).toBe(false);
  });

  it('pins the tolerance boundary', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'forge-tol-'));
    const base = join(dir, 'base.png');
    const edge = join(dir, 'edge.png');
    const over = join(dir, 'over.png');
    await writeFile(base, pngOf(4, 4, [100, 100, 100]));
    await writeFile(edge, pngOf(4, 4, [108, 100, 100])); // delta 8 — equal
    await writeFile(over, pngOf(4, 4, [109, 100, 100])); // delta 9 — different
    expect(await stillsEquivalent(base, edge)).toBe(true);
    expect(await stillsEquivalent(base, over)).toBe(false);
  });
});
