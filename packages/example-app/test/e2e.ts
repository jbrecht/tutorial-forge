/**
 * End-to-end render test (spec §8): boot the example app, render the
 * getting-started tutorial headless with SilentProvider, then assert on the
 * artifacts. Exits non-zero on any failure.
 */
import { strict as assert } from 'node:assert';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { chromium } from 'playwright';
import { render, previewStep, probeAdapterSetup, probeDurationMs, detectFlashOffsetMs, contactSheetPath, SilentProvider, StepError, tutorial, step, type TutorialAdapter } from 'tutorial-forge';
// Internal (not public API) — exercised from source under tsx for #10 coverage.
import { instrumentPage } from '../../core/src/browser/instrument.ts';
import { CURSOR_INIT_SCRIPT } from '../../core/src/browser/cursor.ts';
import { CALLOUT_INIT_SCRIPT } from '../../core/src/browser/callout.ts';
import { anchorFocus, createStepContext } from '../../core/src/pipeline/step-hooks.ts';
import { startServer } from '../src/server.ts';
import gettingStarted from '../tutorials/getting-started.tutorial.ts';

const execFileAsync = promisify(execFile);
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

  // #35 — chapters: sidecars written, and the MP4 carries a chapter track at
  // boundaries derived from the manifest (one per narrated step, silent folded).
  // #37 — the getting-started tutorial declares objectives + summary, so the
  // chapter track is bookended by an Objectives and a Recap chapter (+2).
  assert.ok(result.chaptersVttPath && existsSync(result.chaptersVttPath), 'chapters vtt sidecar exists');
  assert.ok(result.chaptersTxtPath && existsSync(result.chaptersTxtPath), 'chapters txt sidecar exists');
  assert.ok(readFileSync(result.chaptersVttPath!, 'utf8').startsWith('WEBVTT'), 'chapters vtt is well-formed');
  const narratedCount = result.manifest.steps.filter((s) => s.narration.trim()).length;
  const expectedChapters = narratedCount + 2; // intro (Objectives) + recap (Recap) cards
  assert.equal(
    readFileSync(result.chaptersTxtPath!, 'utf8').trim().split('\n').length,
    expectedChapters,
    'one chapter stamp per narrated step, plus intro + recap card chapters',
  );
  const chaptersTxt = readFileSync(result.chaptersTxtPath!, 'utf8');
  assert.ok(/0:00 Objectives/.test(chaptersTxt), 'first chapter is the Objectives card at 0:00');
  assert.ok(/ Recap\n?$/.test(chaptersTxt.trim() + '\n'), 'last chapter is the Recap card');
  const probedChapters = JSON.parse(
    (await execFileAsync('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_chapters', output])).stdout,
  ) as { chapters: unknown[] };
  assert.equal(probedChapters.chapters.length, expectedChapters, 'MP4 chapter track includes the card chapters');

  // #37 — cards add measurable length, embedded at the head/tail of the video.
  assert.ok(result.cardsDurationMs > 0, 'cards contributed duration to the output');

  // #9 — contact sheet emitted next to the video, with one kept screenshot per step.
  assert.ok(result.contactSheetPath && existsSync(result.contactSheetPath), 'contact sheet PNG exists');
  for (const s of result.manifest.steps) {
    assert.ok(existsSync(join(outDir, 'work', 'steps', `${s.id}.png`)), `step screenshot kept: ${s.id}`);
  }

  // Expected length = trimmed body + the intro/recap cards composited around it (#37).
  const bodyMs = result.manifest.totalDurationMs - (result.manifest.steps[0]!.startMs - 300);
  const expectedMs = bodyMs + result.cardsDurationMs;
  const actualMs = await probeDurationMs(output);
  const drift = Math.abs(actualMs - expectedMs) / expectedMs;
  assert.ok(drift < 0.05, `duration within ±5% of manifest+cards (expected ~${expectedMs}ms, got ${actualMs}ms)`);

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
  // #37 — localized cards (Spanish objectives/summary via reserved __keys__) are
  // rendered, and the intro card pushes the first subtitle past 0 in the file.
  assert.ok(esResult.cardsDurationMs > 0, 'es render composited localized cards');
  const esFirstCueMs = (() => {
    const m = /\n(\d\d):(\d\d):(\d\d),(\d\d\d) -->/.exec(esSrt);
    return m ? (+m[1]! * 3600 + +m[2]! * 60 + +m[3]!) * 1000 + +m[4]! : 0;
  })();
  assert.ok(esFirstCueMs >= 3000, `es first subtitle starts after the intro card (got ${esFirstCueMs}ms)`);
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
      // async focus (authors naturally write it async) must still anchor.
      step('This control matters.', async () => {}, { id: 'narrate', focus: async (p) => p.locator('#focus-anchor') }),
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

  // #10 follow-up — an ASYNC focus callback must resolve and still scroll the
  // anchor into view (a sync-only call site would TypeError on the Promise and
  // silently skip the anchor).
  {
    const browser = await chromium.launch();
    try {
      const bctx = await browser.newContext({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
      await bctx.addInitScript(CURSOR_INIT_SCRIPT);
      await bctx.addInitScript(CALLOUT_INIT_SCRIPT);
      const page = await bctx.newPage();
      await page.goto(baseURL);
      await page.evaluate(() => {
        const above = Object.assign(document.createElement('div'), { style: 'height:3000px' });
        const anchor = Object.assign(document.createElement('div'), { id: 'async-anchor', textContent: 'A', tabIndex: 0 });
        const below = Object.assign(document.createElement('div'), { style: 'height:3000px' });
        document.body.append(above, anchor, below);
        window.scrollTo(0, 0);
      });
      const instrumented = instrumentPage(page, { cursor: true, callouts: true, nowMs: () => 0, onCallout: () => {} });
      const { ctx } = createStepContext();
      await anchorFocus(
        { narration: '', run: async () => {}, focus: async (p) => p.locator('#async-anchor') },
        instrumented,
        ctx,
        'async',
      );
      const box = await page.locator('#async-anchor').boundingBox();
      assert.ok(box && box.y >= 0 && box.y <= 720, `async focus scrolled the anchor into view (y=${box?.y.toFixed(0)})`);
      console.log(`e2e OK [async-focus]: async focus resolved + scrolled anchor to y=${box!.y.toFixed(0)}`);
    } finally {
      await browser.close();
    }
  }

  // #14 — settleUntil: 'networkidle' waits on a real signal (in-flight fetch
  // quiescing) instead of a magic settleMs, and resolves rather than hanging.
  {
    const settleTut = tutorial('Settle', [
      step('Trigger a fetch then settle on networkidle.', async (p) => {
        await p.evaluate(() => { void fetch(location.href).then((r) => r.text()); });
      }, { id: 'fetch', settleUntil: 'networkidle' }),
    ], { id: 'settle-demo' });
    const settlePreview = await previewStep(settleTut, adapter, {
      step: 'fetch',
      workDir: join(outDir, 'settle'),
      output: join(outDir, 'settle.png'),
      viewport: { width: 1280, height: 720 },
    });
    assert.ok(existsSync(settlePreview.screenshot), 'settleUntil step rendered a screenshot');
    console.log(`e2e OK [settleUntil]: networkidle settle resolved → ${settlePreview.screenshot}`);
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
  // screenshot, console log, and trace artifacts in a kept work dir. Cleanup
  // registered before the failing step must still run (no orphan leak, #8).
  const cleanedUpOnFailure: string[] = [];
  const broken = tutorial('Broken', [
    step('A step that seeds data.', async (_page, ctx) => {
      ctx.onTeardown(() => { cleanedUpOnFailure.push('step.teardown'); });
    }, { id: 'seed' }),
    step('This click will fail.', async (page) => {
      await page.evaluate(() => console.error('app exploded'));
      await page.getByRole('button', { name: 'No Such Button' }).click({ timeout: 1500 });
    }, { id: 'bad-click' }),
  ], {
    id: 'broken',
    async teardown() { cleanedUpOnFailure.push('tutorial.teardown'); },
  });
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
  assert.deepEqual(
    cleanedUpOnFailure,
    ['step.teardown', 'tutorial.teardown'],
    'onTeardown thunks + tutorial.teardown run even when a later step fails',
  );
  console.log(`e2e OK [failure]: StepError + teardown ran (${cleanedUpOnFailure.join(', ')})`);

  // #17 — ctx.state: adapter.setup's return lands on ctx.state, typed end-to-end
  // (TutorialAdapter<S> → tutorial<S> → step<S>), so tutorial.setup and steps
  // read what the adapter established without a module-global + `!` handoff, and
  // a step can stash a live-created id on it for its own onTeardown.
  {
    interface Seed { token: string }
    const seen: Record<string, unknown> = {};
    const stateAdapter: TutorialAdapter<Seed> = {
      baseURL,
      async setup(page) {
        await page.goto(baseURL);
        await page.getByRole('heading', { name: 'Dashboard' }).waitFor();
        return { token: 'seed-123' }; // becomes ctx.state
      },
    };
    const stateTut = tutorial<Seed>('State', [
      step<Seed>('Read adapter state; stash a live id.', async (_page, ctx) => {
        seen.stepSaw = ctx.state.token; // typed: ctx.state is Seed, no assertion
        ctx.state.token = 'mutated-by-step';
        ctx.onTeardown(() => { seen.teardownSaw = ctx.state.token; });
      }, { id: 'use-state' }),
    ], {
      id: 'state-demo',
      async setup(_page, ctx) { seen.tutorialSetupSaw = ctx.state.token; },
    });
    await render(stateTut, stateAdapter, {
      tts: SilentProvider(),
      output: join(outDir, 'state.mp4'),
      workDir: join(outDir, 'work-state'),
      ttsCacheDir: join(outDir, 'tts-cache'),
    });
    assert.equal(seen.tutorialSetupSaw, 'seed-123', 'tutorial.setup reads adapter state via ctx.state');
    assert.equal(seen.stepSaw, 'seed-123', 'step reads adapter state via ctx.state');
    assert.equal(seen.teardownSaw, 'mutated-by-step', 'onTeardown sees step mutations to ctx.state');
    console.log('e2e OK [ctx.state]: adapter → tutorial.setup → step → onTeardown handoff');
  }

  // #15 — a throw in tutorial.setup must still run the FULL teardown chain, so
  // data seeded (and any ctx.onTeardown registered) before the throw is cleaned
  // up. Previously teardown ran only on a step failure or a clean finish, so a
  // setup-phase throw silently leaked everything seeded so far.
  {
    const cleaned: string[] = [];
    const failAdapter: TutorialAdapter = {
      baseURL,
      async setup(page, ctx) {
        await page.goto(baseURL);
        await page.getByRole('heading', { name: 'Dashboard' }).waitFor();
        ctx.onTeardown(() => { cleaned.push('adapter.onTeardown'); }); // seeded-in-setup cleanup
      },
      async teardown() { cleaned.push('adapter.teardown'); },
    };
    const failTut = tutorial('SetupFail', [step('never runs', async () => {}, { id: 'noop' })], {
      id: 'setup-fail',
      async setup() { throw new Error('seed warm-up timed out'); },
      async teardown() { cleaned.push('tutorial.teardown'); },
    });
    let setupErr: Error | null = null;
    try {
      await render(failTut, failAdapter, {
        tts: SilentProvider(),
        output: join(outDir, 'setup-fail.mp4'),
        workDir: join(outDir, 'work-setup-fail'),
        ttsCacheDir: join(outDir, 'tts-cache'),
      });
    } catch (err) {
      setupErr = err as Error;
    }
    assert.ok(setupErr && /seed warm-up timed out/.test(setupErr.message), 'setup failure propagates');
    assert.deepEqual(
      cleaned,
      ['adapter.onTeardown', 'tutorial.teardown', 'adapter.teardown'],
      'setup-phase failure runs the full teardown chain — no seeded-data leak (#15)',
    );
    console.log(`e2e OK [setup-fail]: teardown ran on setup failure (${cleaned.join(', ')})`);
  }

  // #16 — preview must run the FULL teardown chain (incl. adapter.teardown), not
  // just step thunks. preview is the run-repeatedly iterate tool, so leaking the
  // adapter seed each run quietly fills the shared test DB.
  {
    const cleaned: string[] = [];
    const previewAdapter: TutorialAdapter = {
      baseURL,
      async setup(page) {
        await page.goto(baseURL);
        await page.getByRole('heading', { name: 'Dashboard' }).waitFor();
      },
      async teardown() { cleaned.push('adapter.teardown'); },
    };
    const previewTut = tutorial('PreviewTeardown', [
      step('Seed a row.', async (_p, ctx) => { ctx.onTeardown(() => { cleaned.push('step.teardown'); }); }, { id: 'seed' }),
      step('Target.', async () => {}, { id: 'target' }),
    ], { id: 'preview-teardown', async teardown() { cleaned.push('tutorial.teardown'); } });
    await previewStep(previewTut, previewAdapter, {
      step: 'target',
      workDir: join(outDir, 'preview-td'),
      output: join(outDir, 'preview-td.png'),
    });
    assert.deepEqual(
      cleaned,
      ['step.teardown', 'tutorial.teardown', 'adapter.teardown'],
      'preview runs the full teardown chain — no adapter-seed leak (#16)',
    );
    console.log(`e2e OK [preview-teardown]: ${cleaned.join(', ')}`);
  }

  // #19 — probeAdapterSetup actually runs adapter.setup (and tears it down),
  // surfacing the wrong-database class of failure that a reachable-but-mispointed
  // server hides behind a green check. It must tear down even when setup throws.
  {
    await probeAdapterSetup(adapter); // the working adapter resolves cleanly
    const cleaned: string[] = [];
    const badAdapter: TutorialAdapter = {
      baseURL,
      async setup(_page, ctx) {
        ctx.onTeardown(() => { cleaned.push('cleaned'); });
        throw new Error('sign-in failed: steward not found (wrong database?)');
      },
      async teardown() { cleaned.push('adapter.teardown'); },
    };
    let probeErr: Error | null = null;
    try {
      await probeAdapterSetup(badAdapter);
    } catch (err) {
      probeErr = err as Error;
    }
    assert.ok(probeErr && /wrong database/.test(probeErr.message), 'probeAdapterSetup surfaces a setup failure (#19)');
    assert.deepEqual(cleaned, ['cleaned', 'adapter.teardown'], 'probe tears down even when setup throws');
    console.log('e2e OK [probe-setup]: success resolves; failure surfaces + tears down');
  }

  // #20 — a failed render with contactSheet on still emits a PARTIAL contact
  // sheet (completed steps + the failure frame), the at-a-glance view you most
  // want for a failing run — the post phase that normally builds it never runs.
  {
    const partialBroken = tutorial('PartialBroken', [
      step('First step succeeds.', async () => {}, { id: 'ok-1' }),
      step('Second step succeeds.', async () => {}, { id: 'ok-2' }),
      step('Third step fails.', async (page) => {
        await page.getByRole('button', { name: 'No Such Button' }).click({ timeout: 1000 });
      }, { id: 'boom' }),
    ], { id: 'partial-broken' });
    const partialOutput = join(outDir, 'partial-broken.mp4');
    let perr: StepError | null = null;
    try {
      await render(partialBroken, adapter, {
        tts: SilentProvider(),
        output: partialOutput,
        workDir: join(outDir, 'work-partial'),
        ttsCacheDir: join(outDir, 'tts-cache'),
        contactSheet: true,
      });
    } catch (err) {
      perr = err as StepError;
    }
    assert.ok(perr instanceof StepError && perr.stepId === 'boom', 'partial render failed at the bad step');
    assert.ok(existsSync(contactSheetPath(partialOutput)), 'partial contact sheet emitted on step failure (#20)');
    console.log(`e2e OK [partial-sheet]: ${contactSheetPath(partialOutput)}`);
  }
} finally {
  await close();
}
