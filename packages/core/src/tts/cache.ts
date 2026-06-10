import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { copyFile, rename, rm } from 'node:fs/promises';
import type { TTSProvider } from '../types.js';
import { sha256 } from '../util/hash.js';
import { ensureDir, exists } from '../util/fs.js';
import { normalizeToWav } from '../post/ffmpeg.js';
import { logger } from '../util/logger.js';

export function defaultCacheDir(): string {
  return join(process.env.XDG_CACHE_HOME ?? join(homedir(), '.cache'), 'tutorial-forge', 'tts');
}

export function cacheKeyFor(provider: TTSProvider, text: string): string {
  return sha256(provider.cacheKey, text);
}

/**
 * Synthesize one narration line through the content-hash cache.
 * Cached entries are already normalized to 48kHz mono WAV; on miss we
 * synthesize to a temp file, normalize, and move into the cache atomically.
 * Returns the path of a WAV copy at outPath.
 */
export async function synthesizeCached(
  provider: TTSProvider,
  text: string,
  outPath: string,
  cacheDir = defaultCacheDir(),
): Promise<void> {
  const cached = join(cacheDir, `${cacheKeyFor(provider, text)}.wav`);
  if (!(await exists(cached))) {
    await ensureDir(cacheDir);
    const raw = cached + '.raw.tmp';
    const normalized = cached + '.tmp';
    try {
      await provider.synthesize(text, raw);
      await normalizeToWav(raw, normalized);
      await rename(normalized, cached);
    } finally {
      await rm(raw, { force: true });
      await rm(normalized, { force: true });
    }
    logger.debug(`tts cache miss: "${text.slice(0, 40)}…"`);
  } else {
    logger.debug(`tts cache hit: "${text.slice(0, 40)}…"`);
  }
  await ensureDir(dirname(outPath));
  await copyFile(cached, outPath);
}
