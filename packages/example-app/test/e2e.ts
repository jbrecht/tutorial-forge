/**
 * End-to-end render test (spec §8): boot the example app, render the
 * getting-started tutorial headless with SilentProvider, then assert on the
 * artifacts. Exits non-zero on any failure.
 */
import { strict as assert } from 'node:assert';
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { render, probeDurationMs, SilentProvider, type TutorialAdapter } from 'tutorial-forge';
import { startServer } from '../src/server.ts';
import gettingStarted from '../tutorials/getting-started.tutorial.ts';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = mkdtempSync(join(tmpdir(), 'forge-e2e-'));

const { port, close } = await startServer(0);
const baseURL = `http://localhost:${port}`;
const adapter: TutorialAdapter = {
  baseURL,
  async setup(page) {
    await page.goto(baseURL);
    await page.getByRole('heading', { name: 'Dashboard' }).waitFor();
  },
};

try {
  const output = join(outDir, 'getting-started.mp4');
  const result = await render(gettingStarted, adapter, {
    tts: SilentProvider(),
    output,
    workDir: join(outDir, 'work'),
    keepWorkDir: true,
    ttsCacheDir: join(outDir, 'tts-cache'),
  });

  assert.ok(existsSync(output), 'output mp4 exists');
  assert.ok(result.srtPath && existsSync(result.srtPath), 'sidecar srt exists');

  const expectedMs = result.manifest.totalDurationMs - (result.manifest.steps[0]!.startMs - 300);
  const actualMs = await probeDurationMs(output);
  const drift = Math.abs(actualMs - expectedMs) / expectedMs;
  assert.ok(drift < 0.05, `duration within ±5% of manifest (expected ~${expectedMs}ms, got ${actualMs}ms)`);

  const narratedSteps = result.manifest.steps.filter((s) => s.audioDurationMs > 0).length;
  const cueCount = readFileSync(result.srtPath!, 'utf8').trim().split('\n\n').length;
  assert.equal(cueCount, narratedSteps, 'srt cue count matches narrated step count');

  assert.ok(
    result.manifest.steps.some((s) => s.callouts.length > 0),
    'at least one callout was captured',
  );
  assert.ok(result.videoClockOffsetMs > 0, 'calibration flash was detected');

  console.log(`\ne2e OK: ${output} (${(actualMs / 1000).toFixed(1)}s, offset ${result.videoClockOffsetMs}ms, ${narratedSteps} cues)`);
} finally {
  await close();
}
