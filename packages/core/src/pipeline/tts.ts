import { join } from 'node:path';
import { writeFile, readFile } from 'node:fs/promises';
import type { TTSProvider, Tutorial } from '../types.js';
import { stepId } from '../spec.js';
import { synthesizeCached } from '../tts/cache.js';
import { probeDurationMs } from '../post/ffmpeg.js';
import { ensureDir, mapLimit } from '../util/fs.js';
import { logger } from '../util/logger.js';

export interface TTSPhaseResult {
  /** Per step, in step order. Null audioFile / 0 duration for silent steps. */
  steps: Array<{ id: string; narration: string; audioFile: string | null; audioDurationMs: number }>;
}

const TTS_RESULT_FILE = 'tts.json';

/**
 * Phase 1 — synthesize + measure every narration line. No browser dependency;
 * bounded concurrency. Result is persisted to workDir/tts.json so the record
 * phase can re-run without re-synthesizing.
 */
export async function runTTSPhase<S = unknown>(
  tutorial: Tutorial<S>,
  opts: { provider: TTSProvider; workDir: string; cacheDir: string; concurrency: number },
): Promise<TTSPhaseResult> {
  const audioDir = join(opts.workDir, 'audio');
  await ensureDir(audioDir);

  const steps = await mapLimit(tutorial.steps, opts.concurrency, async (step, i) => {
    const id = stepId(step, i);
    if (!step.narration.trim()) {
      return { id, narration: step.narration, audioFile: null, audioDurationMs: 0 };
    }
    const audioFile = join(audioDir, `step-${id}.wav`);
    await synthesizeCached(opts.provider, step.narration, audioFile, opts.cacheDir);
    const audioDurationMs = await probeDurationMs(audioFile);
    return { id, narration: step.narration, audioFile, audioDurationMs };
  });

  const result: TTSPhaseResult = { steps };
  await writeFile(join(opts.workDir, TTS_RESULT_FILE), JSON.stringify(result, null, 2));
  logger.info(
    `tts: ${steps.filter((s) => s.audioFile).length} narrated step(s), ` +
      `${Math.round(steps.reduce((a, s) => a + s.audioDurationMs, 0) / 1000)}s of narration`,
  );
  return result;
}

/** Load a previous run's tts.json (for `--phase record`/`--phase post`). */
export async function loadTTSResult(workDir: string): Promise<TTSPhaseResult> {
  try {
    return JSON.parse(await readFile(join(workDir, TTS_RESULT_FILE), 'utf8')) as TTSPhaseResult;
  } catch (err) {
    throw new Error(
      `No ${TTS_RESULT_FILE} in ${workDir} — run the tts phase first (cause: ${err instanceof Error ? err.message : err})`,
    );
  }
}
