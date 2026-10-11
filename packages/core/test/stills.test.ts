import { mkdtemp, mkdir, writeFile, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  exportStills,
  pngSize,
  selectStillSteps,
  selectStillStepIds,
  validateStillsSelection,
  stillFileName,
  stillsDir,
  stillsEntries,
  stillsIndexJson,
  stillsIndexMarkdown,
  type StillsIndexMeta,
} from '../src/pipeline/stills.js';
import type { TimingManifest } from '../src/types.js';

const step = (id: string, narration = `Do ${id}.`) => ({
  id,
  narration,
  audioFile: null,
  audioDurationMs: 0,
  startMs: 0,
  actionStartMs: 0,
  actionEndMs: 0,
  endMs: 0,
  callouts: [],
});

const manifest = (ids: string[]): TimingManifest => ({
  tutorialId: 'run-an-event',
  fps: 25,
  recordingStartEpochMs: 0,
  steps: ids.map((id) => step(id)),
  totalDurationMs: 0,
});

const meta: StillsIndexMeta = {
  tutorialId: 'run-an-event',
  title: 'Run an event',
  viewport: { width: 1920, height: 1080 },
};

describe('stillsDir', () => {
  it('sits next to the video, named after it', () => {
    expect(stillsDir('/out/run-an-event.mp4')).toBe('/out/run-an-event-stills');
  });
});

describe('stillFileName', () => {
  it('zero-pads to at least two digits', () => {
    expect(stillFileName(3, 'set-status', 9)).toBe('03-set-status.png');
  });

  it('widens padding for tutorials with 100+ steps', () => {
    expect(stillFileName(7, 'open', 120)).toBe('007-open.png');
  });

  it('pads from the tutorial total, not the selection, so names are stable across subsets', () => {
    expect(stillFileName(12, 'open', 12)).toBe('12-open.png');
  });
});

describe('selectStillSteps', () => {
  const m = manifest(['open', 'filter', 'set-status', 'save']);

  it('selects every step when no expression is given', () => {
    expect(selectStillSteps(m)).toEqual([0, 1, 2, 3]);
    expect(selectStillSteps(m, '  ')).toEqual([0, 1, 2, 3]);
  });

  it('selects a single id', () => {
    expect(selectStillSteps(m, 'set-status')).toEqual([2]);
  });

  it('expands a range', () => {
    expect(selectStillSteps(m, 'filter..save')).toEqual([1, 2, 3]);
  });

  it('merges a comma-separated mix in tutorial order, collapsing duplicates', () => {
    expect(selectStillSteps(m, 'save, open..filter, open')).toEqual([0, 1, 3]);
  });

  it('throws on an unknown step id', () => {
    expect(() => selectStillSteps(m, 'nope')).toThrow(/No step "nope"/);
  });

  it('throws on a backwards range', () => {
    expect(() => selectStillSteps(m, 'save..open')).toThrow(/runs backwards/);
  });
});

describe('stillsEntries', () => {
  it('points at record per-step screenshots and keeps tutorial-order indices', () => {
    const entries = stillsEntries(manifest(['open', 'filter', 'save']), '/work', 'filter..save');
    expect(entries).toEqual([
      {
        index: 2,
        id: 'filter',
        narration: 'Do filter.',
        source: join('/work', 'steps', 'filter.png'),
        file: '02-filter.png',
      },
      {
        index: 3,
        id: 'save',
        narration: 'Do save.',
        source: join('/work', 'steps', 'save.png'),
        file: '03-save.png',
      },
    ]);
  });
});

describe('stillsIndexJson', () => {
  const entries = stillsEntries(manifest(['open', 'save']), '/work');

  it('carries step id, file, and narration for each still', () => {
    const parsed = JSON.parse(stillsIndexJson(entries, meta));
    expect(parsed.tutorialId).toBe('run-an-event');
    expect(parsed.title).toBe('Run an event');
    expect(parsed.viewport).toEqual({ width: 1920, height: 1080 });
    expect(parsed.stills).toEqual([
      { index: 1, id: 'open', file: '01-open.png', narration: 'Do open.' },
      { index: 2, id: 'save', file: '02-save.png', narration: 'Do save.' },
    ]);
  });

  it('is deterministic, so a docs repo only diffs on real changes', () => {
    expect(stillsIndexJson(entries, meta)).toBe(stillsIndexJson(entries, meta));
  });

  it('omits lang when the render was not localized', () => {
    expect(JSON.parse(stillsIndexJson(entries, meta))).not.toHaveProperty('lang');
    expect(JSON.parse(stillsIndexJson(entries, { ...meta, lang: 'es' })).lang).toBe('es');
  });
});

describe('stillsIndexMarkdown', () => {
  it('emits a captioned image per step, referenced by basename', () => {
    const md = stillsIndexMarkdown(stillsEntries(manifest(['open']), '/work'), meta);
    expect(md).toContain('# Run an event — screenshots');
    expect(md).toContain('## 1. open');
    expect(md).toContain('![Do open.](01-open.png)');
  });

  it('uses the step id as alt text when narration is empty', () => {
    const m = manifest(['silent-beat']);
    m.steps[0]!.narration = '   ';
    const md = stillsIndexMarkdown(stillsEntries(m, '/work'), meta);
    expect(md).toContain('![silent-beat](01-silent-beat.png)');
  });

  it('flattens and escapes narration that would break the alt text', () => {
    const m = manifest(['pick']);
    m.steps[0]!.narration = 'Choose [Save]\nthen wait';
    const md = stillsIndexMarkdown(stillsEntries(m, '/work'), meta);
    expect(md).toContain('![Choose \\[Save\\] then wait](01-pick.png)');
  });
});

describe('exportStills', () => {
  async function fixture(ids: string[], present: string[]) {
    const root = await mkdtemp(join(tmpdir(), 'forge-stills-'));
    const workDir = join(root, 'work');
    await mkdir(join(workDir, 'steps'), { recursive: true });
    for (const id of present) await writeFile(join(workDir, 'steps', `${id}.png`), `png:${id}`);
    return { root, workDir, manifest: manifest(ids), outDir: join(root, 'out-stills') };
  }

  it('copies the selected frames and writes both indexes', async () => {
    const f = await fixture(['open', 'save'], ['open', 'save']);
    const result = await exportStills(stillsEntries(f.manifest, f.workDir), f.outDir, meta);

    expect(result.dir).toBe(f.outDir);
    expect(result.missing).toEqual([]);
    expect((await readdir(f.outDir)).sort()).toEqual([
      '01-open.png',
      '02-save.png',
      'index.json',
      'index.md',
    ]);
    expect(await readFile(join(f.outDir, '01-open.png'), 'utf8')).toBe('png:open');
    expect(result.files).toEqual([join(f.outDir, '01-open.png'), join(f.outDir, '02-save.png')]);
  });

  it('skips the markdown index when disabled', async () => {
    const f = await fixture(['open'], ['open']);
    const result = await exportStills(stillsEntries(f.manifest, f.workDir), f.outDir, meta, {
      markdown: false,
    });
    expect(result.indexMarkdownPath).toBeNull();
    expect(await readdir(f.outDir)).not.toContain('index.md');
  });

  it('exports the frames that exist and reports the rest — a failed render still yields stills', async () => {
    const f = await fixture(['open', 'filter', 'save'], ['open', 'filter']);
    const result = await exportStills(stillsEntries(f.manifest, f.workDir), f.outDir, meta);

    expect(result.files).toHaveLength(2);
    expect(result.missing).toEqual(['save']);
    // The index describes only what was written, so no broken image links.
    expect(JSON.parse(await readFile(join(f.outDir, 'index.json'), 'utf8')).stills).toHaveLength(2);
  });

  it('writes nothing when no frames exist at all', async () => {
    const f = await fixture(['open'], []);
    const result = await exportStills(stillsEntries(f.manifest, f.workDir), f.outDir, meta);
    expect(result).toEqual({
      dir: null,
      files: [],
      indexJsonPath: null,
      indexMarkdownPath: null,
      missing: ['open'],
      pruned: 0,
    });
    await expect(readdir(f.outDir)).rejects.toThrow();
  });

  it('honours a step selection', async () => {
    const f = await fixture(['open', 'filter', 'save'], ['open', 'filter', 'save']);
    const result = await exportStills(
      stillsEntries(f.manifest, f.workDir, 'save'),
      f.outDir,
      meta,
    );
    expect(await readdir(f.outDir)).toContain('03-save.png');
    expect(result.files).toHaveLength(1);
  });
});

/** Minimal 1x1-ish PNG header: signature + IHDR with the given dimensions. */
function pngBytes(width: number, height: number): Buffer {
  const buf = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf, 0);
  buf.write('IHDR', 12, 'ascii');
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  return buf;
}

describe('pngSize', () => {
  it('reads dimensions out of the IHDR chunk', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'forge-png-'));
    const file = join(dir, 'a.png');
    await writeFile(file, pngBytes(3840, 2160));
    expect(await pngSize(file)).toEqual({ width: 3840, height: 2160 });
  });

  it('returns undefined for a missing file or a non-PNG', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'forge-png-'));
    const notPng = join(dir, 'b.png');
    await writeFile(notPng, 'this is not a png at all!!');
    expect(await pngSize(join(dir, 'nope.png'))).toBeUndefined();
    expect(await pngSize(notPng)).toBeUndefined();
  });
});

describe('stills index pixelSize (#71)', () => {
  it('stamps the real exported dimensions, which differ from the CSS viewport on retina', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forge-stills-dsf-'));
    const workDir = join(root, 'work');
    await mkdir(join(workDir, 'steps'), { recursive: true });
    await writeFile(join(workDir, 'steps', 'open.png'), pngBytes(3840, 2160));

    const outDir = join(root, 'out-stills');
    await exportStills(stillsEntries(manifest(['open']), workDir), outDir, meta);

    const index = JSON.parse(await readFile(join(outDir, 'index.json'), 'utf8'));
    expect(index.viewport).toEqual({ width: 1920, height: 1080 });
    expect(index.pixelSize).toEqual({ width: 3840, height: 2160 });
  });

  it('omits pixelSize when the frame is unreadable rather than guessing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forge-stills-nodsf-'));
    const workDir = join(root, 'work');
    await mkdir(join(workDir, 'steps'), { recursive: true });
    await writeFile(join(workDir, 'steps', 'open.png'), 'not really a png');

    const outDir = join(root, 'out-stills');
    await exportStills(stillsEntries(manifest(['open']), workDir), outDir, meta);

    const index = JSON.parse(await readFile(join(outDir, 'index.json'), 'utf8'));
    expect(index).not.toHaveProperty('pixelSize');
  });
});

describe('selectStillStepIds / validateStillsSelection (#71)', () => {
  const ids = ['open', 'filter', 'save'];

  it('resolves against plain ids, with no manifest needed', () => {
    expect(selectStillStepIds(ids, 't', 'filter..save')).toEqual([1, 2]);
    expect(selectStillStepIds(ids, 't')).toEqual([0, 1, 2]);
  });

  it('names the tutorial and its steps when an id is unknown', () => {
    expect(() => selectStillStepIds(ids, 'run-an-event', 'typo')).toThrow(
      /No step "typo" in tutorial "run-an-event" \(steps: open, filter, save\)/,
    );
  });

  it('pre-flights a selection so a typo fails before recording', () => {
    expect(() => validateStillsSelection(ids, 't', 'save')).not.toThrow();
    expect(() => validateStillsSelection(ids, 't', 'open..nope')).toThrow(/No step "nope"/);
    expect(() => validateStillsSelection(ids, 't', 'save..open')).toThrow(/runs backwards/);
  });

  it('accepts an absent selection (the export-everything default)', () => {
    expect(() => validateStillsSelection(ids, 't', undefined)).not.toThrow();
  });
});

describe('stillsEntries against a partial manifest (#71)', () => {
  // A failed render's manifest holds only the completed steps. Selection and
  // numbering must still come from the tutorial spec.
  const tutorialIds = ['open', 'filter', 'save'];
  const partial = manifest(['open', 'filter']); // 'save' never ran

  it('keeps tutorial-order numbering for the steps that did record', () => {
    const entries = stillsEntries(partial, '/work', undefined, tutorialIds);
    expect(entries.map((e) => e.file)).toEqual(['01-open.png', '02-filter.png', '03-save.png']);
  });

  it('does not abandon the export when the selection names a step that never ran', () => {
    const entries = stillsEntries(partial, '/work', 'open..save', tutorialIds);
    expect(entries.map((e) => e.id)).toEqual(['open', 'filter', 'save']);
    // 'save' has no narration to borrow, and its frame is absent, so the
    // export drops it into `missing` rather than into the index.
    expect(entries.find((e) => e.id === 'save')!.narration).toBe('');
  });

  it('throws only for ids absent from the whole tutorial, not merely unrecorded', () => {
    expect(() => stillsEntries(partial, '/work', 'save', tutorialIds)).not.toThrow();
    expect(() => stillsEntries(partial, '/work', 'typo', tutorialIds)).toThrow(/No step "typo"/);
  });

  it('pads from the tutorial total so a failure cannot renumber survivors', () => {
    const big = Array.from({ length: 120 }, (_, i) => `s${i + 1}`);
    const failedEarly = manifest(['s1', 's2', 's3']);
    const entries = stillsEntries(failedEarly, '/work', undefined, big);
    expect(entries[0]!.file).toBe('001-s1.png');
  });
});

describe('exportStills pruning (#71)', () => {
  it('replaces images from a previous export so the dir matches the index', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forge-stills-prune-'));
    const workDir = join(root, 'work');
    await mkdir(join(workDir, 'steps'), { recursive: true });
    await writeFile(join(workDir, 'steps', 'open.png'), 'png:open');

    const outDir = join(root, 'out-stills');
    await mkdir(outDir, { recursive: true });
    // Leftovers from an earlier run: a renamed step and a wider subset.
    await writeFile(join(outDir, '01-old-name.png'), 'stale');
    await writeFile(join(outDir, '07-removed-step.png'), 'stale');
    // Author's own file — must survive.
    await writeFile(join(outDir, 'notes.md'), 'mine');

    const result = await exportStills(stillsEntries(manifest(['open']), workDir), outDir, meta);

    expect(result.pruned).toBe(2);
    const listed = (await readdir(outDir)).sort();
    expect(listed).toEqual(['01-open.png', 'index.json', 'index.md', 'notes.md']);
  });

  it('reports nothing pruned on a first export', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forge-stills-fresh-'));
    const workDir = join(root, 'work');
    await mkdir(join(workDir, 'steps'), { recursive: true });
    await writeFile(join(workDir, 'steps', 'open.png'), 'png:open');
    const result = await exportStills(
      stillsEntries(manifest(['open']), workDir),
      join(root, 'out-stills'),
      meta,
    );
    expect(result.pruned).toBe(0);
  });
});

describe('pngSize chunk validation (#71)', () => {
  it('rejects a file whose first chunk is not IHDR', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'forge-png-chunk-'));
    const file = join(dir, 'odd.png');
    const buf = pngBytes(100, 50);
    buf.write('gAMA', 12, 'ascii'); // valid PNG signature, different first chunk
    await writeFile(file, buf);
    expect(await pngSize(file)).toBeUndefined();
  });

  it('rejects a file truncated after the signature', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'forge-png-trunc-'));
    const file = join(dir, 'short.png');
    await writeFile(file, pngBytes(100, 50).subarray(0, 12));
    expect(await pngSize(file)).toBeUndefined();
  });
});
