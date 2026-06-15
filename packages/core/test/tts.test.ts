import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tutorial, step } from '../src/spec.js';
import { silentTTSResult, loadTTSResultIfPresent, loadTTSResult } from '../src/pipeline/tts.js';

const noop = async () => {};
const freshDir = () => mkdtempSync(join(tmpdir(), 'tf-tts-'));

describe('silentTTSResult (#50)', () => {
  it('maps every step to null audio / 0 ms, preserving narration and step ids', () => {
    const t = tutorial('Demo', [step('First line.', noop), step('Second line.', noop)]);
    expect(silentTTSResult(t).steps).toEqual([
      { id: 'step-01', narration: 'First line.', audioFile: null, audioDurationMs: 0 },
      { id: 'step-02', narration: 'Second line.', audioFile: null, audioDurationMs: 0 },
    ]);
  });
});

describe('loadTTSResultIfPresent (#50)', () => {
  it('returns null when tts.json is absent (lets --phase record fall back to silent timings)', async () => {
    expect(await loadTTSResultIfPresent(freshDir())).toBeNull();
  });

  it('returns the parsed result when tts.json is present', async () => {
    const dir = freshDir();
    const data = { steps: [{ id: 'step-01', narration: 'x', audioFile: null, audioDurationMs: 0 }] };
    writeFileSync(join(dir, 'tts.json'), JSON.stringify(data));
    expect(await loadTTSResultIfPresent(dir)).toEqual(data);
  });

  it('throws on a corrupt tts.json — a present-but-unreadable file is not the same as absent', async () => {
    const dir = freshDir();
    writeFileSync(join(dir, 'tts.json'), '{ not valid json');
    await expect(loadTTSResultIfPresent(dir)).rejects.toThrow();
  });
});

describe('loadTTSResult', () => {
  it('throws a clear "run the tts phase first" error when tts.json is absent (used by --phase post)', async () => {
    await expect(loadTTSResult(freshDir())).rejects.toThrow(/run the tts phase first/);
  });
});
