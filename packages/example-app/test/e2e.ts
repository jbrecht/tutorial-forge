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
import { chromium } from 'playwright';
import { render, previewStep, probeDurationMs, detectFlashOffsetMs, SilentProvider, StepError, tutorial, step, type TutorialAdapter } from 'tutorial-forge';
// Internal (not public API) — exercised from source under tsx for #10 coverage.
import { instrumentPage } from '../../core/src/browser/instrument.ts';
import { CURSOR_INIT_SCRIPT } from '../../core/src/browser/cursor.ts';
import { CALLOUT_INIT_SCRIPT } from '../../core/src/browser/callout.ts';
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
    contactSheet: true, // exercises per-step screenshots + contact-sheet assembly (#9)
  });

  assert.ok(existsSync(output), 'output mp4 exists');
  assert.ok(result.srtPath && existsSync(result.srtPath), 'sidecar srt exists');

  // #9 — contact sheet emitted next to the video, with one kept screenshot per step.
  assert.ok(result.contactSheetPath && existsSync(result.contactSheetPath), 'contact sheet PNG exists');
  for (const s of result.manifest.steps) {
    assert.ok(existsSync(join(outDir, 'work', 'steps', `${s.id}.png`)), `step screenshot kept: ${s.id}`);
  }

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

  // Idle speed-up: a tutorial with a long silent wait must come out shorter,
  // with narration offsets remapped (cue still starts after the lead-in).
  const idleTutorial = tutorial('Idle', [
    step('A short narrated step.', async () => {}, { id: 'narrated' }),
    step('', async (page) => {
      await page.waitForTimeout(4000); // silent dead time — the compression target
    }, { id: 'silent-wait' }),
    step('And a narrated wrap-up.', async () => {}, { id: 'outro' }),
  ], { id: 'idle-demo' });
  const idleOutput = join(outDir, 'idle-demo.mp4');
  const idleResult = await render(idleTutorial, adapter, {
    tts: SilentProvider(),
    output: idleOutput,
    workDir: join(outDir, 'work-idle'),
    ttsCacheDir: join(outDir, 'tts-cache'),
    idleSpeedup: true,
    subtitles: 'burn', // exercises browser-rendered caption overlays (+ retime remap)
    gif: { widthPx: 480, steps: 'narrated..silent-wait' }, // exercises GIF excerpt export
    recorder: 'screencast', // exercises CDP capture with explicit frame timestamps
  });
  const idleUncompressedMs =
    idleResult.manifest.totalDurationMs - (idleResult.manifest.steps[0]!.startMs - 300);
  assert.ok(
    idleResult.outputDurationMs < idleUncompressedMs - 2000,
    `idle speed-up saved >2s (${idleResult.outputDurationMs}ms vs ${idleUncompressedMs}ms uncompressed)`,
  );
  assert.equal(idleResult.srtPath, null, 'burn mode writes no sidecar srt');
  assert.equal(idleResult.manifest.capture?.recorder, 'screencast', 'manifest records the recorder');
  assert.equal(idleResult.videoClockOffsetMs, 0, 'screencast capture is clock-aligned (no flash)');
  assert.ok(idleResult.gifPath && existsSync(idleResult.gifPath), 'gif excerpt exists');
  const gifDurationMs = await probeDurationMs(idleResult.gifPath!);
  assert.ok(
    gifDurationMs < idleResult.outputDurationMs,
    `gif excerpt (${gifDurationMs}ms) is shorter than the full video (${idleResult.outputDurationMs}ms)`,
  );
  console.log(
    `e2e OK [idle]: ${(idleUncompressedMs / 1000).toFixed(1)}s → ${(idleResult.outputDurationMs / 1000).toFixed(1)}s`,
  );

  // #11 — single-step preview: replays setup + prior steps to reach state,
  // runs just the target step, dumps a screenshot (no TTS, no video assembly).
  const previewById = await previewStep(gettingStarted, adapter, {
    step: 'create-event',
    workDir: join(outDir, 'preview'),
    output: join(outDir, 'preview-create-event.png'),
  });
  assert.ok(existsSync(previewById.screenshot), 'preview screenshot exists');
  assert.equal(previewById.stepId, 'create-event', 'preview resolved the step id');
  const previewByIndex = await previewStep(gettingStarted, adapter, {
    step: '2',
    workDir: join(outDir, 'preview'),
    output: join(outDir, 'preview-2.png'),
  });
  assert.equal(previewByIndex.index, 1, 'preview resolved a 1-based index to 0-based');
  assert.ok(existsSync(previewByIndex.screenshot), 'preview-by-index screenshot exists');
  console.log(`e2e OK [preview]: ${previewById.stepId} → ${previewById.screenshot}`);

  // #10 — auto-scroll-into-view: an instrumented action on a below-the-fold
  // target smooth-scrolls it into frame before the cursor travels there, so
  // the action plays on-screen (no manual scrollIntoView needed).
  {
    const browser = await chromium.launch();
    try {
      const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
      await ctx.addInitScript(CURSOR_INIT_SCRIPT);
      await ctx.addInitScript(CALLOUT_INIT_SCRIPT);
      const page = await ctx.newPage();
      await page.goto(baseURL);
      await page.evaluate(() => {
        const above = Object.assign(document.createElement('div'), { style: 'height:3000px' });
        const btn = Object.assign(document.createElement('button'), { id: 'far-target', textContent: 'Far' });
        btn.addEventListener('click', () => (btn.textContent = 'Clicked'));
        const below = Object.assign(document.createElement('div'), { style: 'height:3000px' });
        document.body.append(above, btn, below);
        window.scrollTo(0, 0);
      });
      const before = await page.locator('#far-target').boundingBox();
      assert.ok(before && before.y > 720, `target starts below the fold (y=${before?.y})`);
      await instrumentPage(page, { cursor: true, callouts: true, nowMs: () => 0, onCallout: () => {} })
        .locator('#far-target')
        .click();
      const after = await page.locator('#far-target').boundingBox();
      assert.ok(after && after.y >= 0 && after.y <= 720, `target scrolled into view (y=${after?.y.toFixed(0)})`);
      assert.equal(await page.locator('#far-target').textContent(), 'Clicked', 'the click landed on-screen');
      console.log(`e2e OK [scroll]: below-fold target ${before!.y.toFixed(0)} → ${after!.y.toFixed(0)} (vh 720), clicked`);
    } finally {
      await browser.close();
    }
  }

  // #10 — focus option: a pure-narration step anchors the cursor on a control,
  // smooth-scrolling it into frame even though the step performs no action.
  {
    const focusTut = tutorial('Focus', [
      step('Add a far control.', async (p) => {
        await p.evaluate(() => {
          const above = Object.assign(document.createElement('div'), { style: 'height:3000px' });
          const anchor = Object.assign(document.createElement('div'), { id: 'focus-anchor', textContent: 'Anchor', tabIndex: 0 });
          const below = Object.assign(document.createElement('div'), { style: 'height:3000px' });
          document.body.append(above, anchor, below);
          window.scrollTo(0, 0);
        });
      }, { id: 'add' }),
      step('This control matters.', async () => {}, { id: 'narrate', focus: (p) => p.locator('#focus-anchor') }),
    ], { id: 'focus-demo' });
    const focusPreview = await previewStep(focusTut, adapter, {
      step: 'narrate',
      workDir: join(outDir, 'focus'),
      output: join(outDir, 'focus.png'),
      viewport: { width: 1280, height: 720 },
    });
    assert.ok(existsSync(focusPreview.screenshot), 'focus-anchored preview screenshot exists');
    console.log(`e2e OK [focus]: pure-narration step anchored without error → ${focusPreview.screenshot}`);
  }

  // #8 — per-tutorial setup/teardown + ctx.onTeardown compose with the adapter.
  // Setup runs adapter→tutorial; teardown runs step-thunks (LIFO)→tutorial→adapter.
  {
    const order: string[] = [];
    const hookAdapter: TutorialAdapter = {
      baseURL,
      async setup(page) {
        order.push('adapter.setup');
        await page.goto(baseURL);
        await page.getByRole('heading', { name: 'Dashboard' }).waitFor();
      },
      async teardown() {
        order.push('adapter.teardown');
      },
    };
    const hookTut = tutorial('Hooks', [
      step('Only step.', async (_page, ctx) => {
        ctx.onTeardown(() => { order.push('step.teardown.a'); });
        ctx.onTeardown(() => { order.push('step.teardown.b'); });
      }, { id: 'only' }),
    ], {
      id: 'hooks-demo',
      async setup() {
        order.push('tutorial.setup');
      },
      async teardown() {
        order.push('tutorial.teardown');
      },
    });
    await render(hookTut, hookAdapter, {
      tts: SilentProvider(),
      output: join(outDir, 'hooks.mp4'),
      workDir: join(outDir, 'work-hooks'),
      ttsCacheDir: join(outDir, 'tts-cache'),
    });
    assert.deepEqual(
      order,
      ['adapter.setup', 'tutorial.setup', 'step.teardown.b', 'step.teardown.a', 'tutorial.teardown', 'adapter.teardown'],
      'tutorial hooks + onTeardown compose with the adapter in the right order (teardown is LIFO)',
    );
    console.log(`e2e OK [hooks]: ${order.join(' → ')}`);
  }

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
