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
import { render, probeDurationMs, detectFlashOffsetMs, SilentProvider, StepError, tutorial, step, type TutorialAdapter } from 'tutorial-forge';
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
  assert.equal(
    await detectFlashOffsetMs(output, 2),
    null,
    'calibration flash must be trimmed out of the final video',
  );

  console.log(`\ne2e OK: ${output} (${(actualMs / 1000).toFixed(1)}s, offset ${result.videoClockOffsetMs}ms, ${narratedSteps} cues)`);

  // Localized render: load the Spanish sidecar the way the CLI would and
  // verify the pipeline produces a Spanish video + subtitles.
  gettingStarted.translations = {
    es: JSON.parse(readFileSync(join(here, '..', 'tutorials', 'getting-started.tutorial.es.json'), 'utf8')),
  };
  const esOutput = join(outDir, 'getting-started.es.mp4');
  const esResult = await render(gettingStarted, adapter, {
    tts: SilentProvider(),
    output: esOutput,
    workDir: join(outDir, 'work-es'),
    keepWorkDir: true,
    ttsCacheDir: join(outDir, 'tts-cache'),
    lang: 'es',
    zoom: true, // exercises the zoom-on-callout filter path
  });
  assert.ok(existsSync(esOutput), 'es output mp4 exists');
  assert.equal(esResult.manifest.lang, 'es', 'manifest records the language');
  const esSrt = readFileSync(esResult.srtPath!, 'utf8');
  assert.ok(esSrt.includes('Bienvenido a Lumen Events'), 'es srt contains Spanish narration');
  assert.ok(!esSrt.includes('Welcome to Lumen Events'), 'es srt contains no source narration');
  console.log(`e2e OK [es]: ${esOutput} (${(esResult.outputDurationMs / 1000).toFixed(1)}s)`);

  // Failure path: a broken step in debug mode must throw StepError with
  // screenshot, console log, and trace artifacts in a kept work dir.
  const broken = tutorial('Broken', [
    step('This click will fail.', async (page) => {
      await page.evaluate(() => console.error('app exploded'));
      await page.getByRole('button', { name: 'No Such Button' }).click({ timeout: 1500 });
    }, { id: 'bad-click' }),
  ], { id: 'broken' });
  let failure: StepError | null = null;
  try {
    await render(broken, adapter, {
      tts: SilentProvider(),
      output: join(outDir, 'broken.mp4'),
      workDir: join(outDir, 'work-broken'),
      ttsCacheDir: join(outDir, 'tts-cache'),
      debug: true,
    });
  } catch (err) {
    failure = err as StepError;
  }
  assert.ok(failure instanceof StepError, 'broken tutorial throws StepError');
  assert.equal(failure.stepId, 'bad-click');
  assert.ok(failure.artifacts?.screenshot && existsSync(failure.artifacts.screenshot), 'failure screenshot exists');
  assert.ok(failure.artifacts?.consoleLog && existsSync(failure.artifacts.consoleLog), 'failure console log exists');
  assert.ok(
    readFileSync(failure.artifacts!.consoleLog!, 'utf8').includes('app exploded'),
    'console log captured the page error',
  );
  assert.ok(failure.artifacts?.trace && existsSync(failure.artifacts.trace), 'debug trace exists');
  console.log(`e2e OK [failure]: StepError with artifacts in ${failure.artifacts!.workDir}`);
} finally {
  await close();
}
