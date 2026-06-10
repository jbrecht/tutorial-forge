import { mkdtempSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { cacheKeyFor, synthesizeCached } from '../src/tts/cache.js';
import { silentWav } from '../src/tts/silent.js';
import { estimateDurationMs } from '../src/tts/provider.js';
import type { TTSProvider } from '../src/types.js';

describe('cacheKeyFor', () => {
  const provider = { cacheKey: 'p:v1', synthesize: async () => {} };
  it('is stable for identical inputs', () => {
    expect(cacheKeyFor(provider, 'hello')).toBe(cacheKeyFor(provider, 'hello'));
  });
  it('partitions by provider and text without delimiter collisions', () => {
    expect(cacheKeyFor(provider, 'hello')).not.toBe(cacheKeyFor(provider, 'hello!'));
    expect(cacheKeyFor({ ...provider, cacheKey: 'p:v2' }, 'hello')).not.toBe(cacheKeyFor(provider, 'hello'));
    expect(cacheKeyFor({ ...provider, cacheKey: 'p:v1x' }, 'y')).not.toBe(cacheKeyFor(provider, 'xy'));
  });
});

describe('synthesizeCached', () => {
  it('synthesizes once and serves the second call from cache (ffmpeg required)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'forge-cache-'));
    let calls = 0;
    const provider: TTSProvider = {
      cacheKey: 'test:v1',
      async synthesize(text, outPath) {
        calls++;
        const { writeFile } = await import('node:fs/promises');
        await writeFile(outPath, silentWav(500));
      },
    };
    const out1 = join(dir, 'out1.wav');
    const out2 = join(dir, 'out2.wav');
    await synthesizeCached(provider, 'same line', out1, join(dir, 'cache'));
    await synthesizeCached(provider, 'same line', out2, join(dir, 'cache'));
    expect(calls).toBe(1);
    expect((await readFile(out2)).equals(await readFile(out1))).toBe(true);
  });
});

describe('estimateDurationMs', () => {
  it('floors at 1200ms and scales by word count', () => {
    expect(estimateDurationMs('hi')).toBe(1200);
    expect(estimateDurationMs('one two three four five six')).toBe(6 * 380);
  });
});
