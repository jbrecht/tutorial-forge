import { resolve, join } from 'node:path';
import type { RenderOptions, TimingManifest, Tutorial, TutorialAdapter } from '../types.js';
import { StepError } from '../types.js';
import { validateTutorial, stepId } from '../spec.js';
import { localizeTutorial } from '../i18n.js';
import { runTTSPhase, loadTTSResult, loadTTSResultIfPresent, silentTTSResult } from './tts.js';
import { runRecordPhase, loadManifest } from './record.js';
import { runPostPhase, type PostPhaseResult } from './post.js';
import { renderContactSheet, contactSheetEntries, contactSheetPath } from './contact-sheet.js';
import {
  exportStills,
  stillsEntries,
  stillsDir,
  validateStillsSelection,
  assertNoFilenameCollisions,
  type StillsConfig,
  type StillsResult,
} from './stills.js';
import { defaultCacheDir } from '../tts/cache.js';
import { ensureDir, removeDir } from '../util/fs.js';
import { logger } from '../util/logger.js';

export interface RenderResult extends PostPhaseResult {
  manifest: TimingManifest;
  workDir: string;
  /** Path to the authoring contact sheet, if one was emitted (#9). */
  contactSheetPath?: string | null;
  /** Exported per-step stills, if --stills was on (#71); null when none were written. */
  stills?: StillsResult | null;
}

/**
 * Run the full pipeline (or a single phase) for one tutorial.
 * Phases: tts → record → post. The work directory is kept on failure
 * (and on success with keepWorkDir: true) so every stage is inspectable.
 */
export async function render<S = unknown>(
  tutorial: Tutorial<S>,
  adapter: TutorialAdapter<S>,
  options: RenderOptions,
): Promise<RenderResult> {
  validateTutorial(tutorial);
  const lang = options.lang;
  if (lang) {
    tutorial = localizeTutorial(tutorial, lang, options.defaultLang ?? 'en');
  }

  const workDir = resolve(
    options.workDir ?? join('.forge', lang ? `${tutorial.id}.${lang}` : tutorial.id),
  );
  const output = resolve(options.output);
  const viewport = options.viewport ?? { width: 1920, height: 1080 };
  const leadInMs = options.leadInMs ?? 300;
  const phase = options.phase ?? 'all';
  const wantContactSheet = options.contactSheet ?? false;
  const stillsConfig = options.stills === true ? {} : options.stills || undefined;
  const wantStills = stillsConfig !== undefined;
  // The tutorial spec's step ids — the authority for stills numbering and
  // selection, including on a failed render whose manifest holds only the
  // steps that completed.
  const tutorialStepIds = tutorial.steps.map((s, i) => stepId(s, i));
  // Fail a typo'd --stills-steps now, not after a full recording pass.
  if (wantStills && stillsConfig.steps) {
    validateStillsSelection(tutorialStepIds, tutorial.id, stillsConfig.steps);
  }
  // Two steps whose ids collapse to one filename are computable from the spec,
  // so reject them here rather than after a full recording pass.
  if (wantStills) {
    assertNoFilenameCollisions(
      tutorialStepIds,
      tutorialStepIds.length,
      stillsConfig.filenames ?? 'id',
      tutorial.id,
    );
  }
  // Only the recording phases produce frames to publish. Say so up front
  // rather than letting the flag look like it worked.
  if (wantStills && phase !== 'all' && phase !== 'record') {
    logger.warn(
      `stills: skipped — phase "${phase}" does not record frames (use --phase record or all)`,
    );
  }
  await ensureDir(workDir);

  try {
    const tts =
      phase === 'all' || phase === 'tts'
        ? await runTTSPhase(tutorial, {
            provider: options.tts,
            workDir,
            cacheDir: options.ttsCacheDir ?? defaultCacheDir(),
            concurrency: options.ttsConcurrency ?? 4,
          })
        : phase === 'record'
          ? // A standalone `--phase record` (the TTS-free framing check) falls back
            // to placeholder timings when no tts.json exists yet — paces steps as
            // silent rather than throwing (#50). `--phase post` still needs real
            // timings, so it stays strict below.
            ((await loadTTSResultIfPresent(workDir)) ?? silentTTSResult(tutorial))
          : await loadTTSResult(workDir);
    if (phase === 'tts') {
      return partialResult(workDir, output, await safeLoadManifest(workDir, tutorial.id));
    }

    const manifest =
      phase === 'all' || phase === 'record'
        ? await runRecordPhase(tutorial, adapter, tts, {
            workDir,
            viewport,
            headless: options.headless ?? true,
            cursor: options.cursor ?? true,
            callouts: options.callouts ?? true,
            leadInMs,
            lang,
            recorder: options.recorder,
            debug: options.debug,
            screenshots: wantContactSheet || options.debug,
            stills: wantStills
              ? {
                  capture: stillsConfig.capture ?? 'before',
                  crop: stillsConfig.crop === 'target',
                  cropPaddingPx: stillsConfig.cropPaddingPx ?? 24,
                }
              : undefined,
          })
        : await loadManifest(workDir);

    // Authoring contact sheet (#9): emit next to the final video so it
    // survives work-dir cleanup. Built whenever record ran with screenshots on.
    let sheetPath: string | null = null;
    if (wantContactSheet && (phase === 'all' || phase === 'record')) {
      sheetPath = await renderContactSheet(contactSheetEntries(manifest, workDir), contactSheetPath(output), viewport);
      if (sheetPath) logger.info(`contact sheet: ${sheetPath}`);
      else logger.warn('contact sheet: no step screenshots found to assemble');
    }

    // Documentation stills (#71): copied out of the work dir so they survive
    // its cleanup. Done right after record (not in post) so the TTS-free
    // `--phase record` framing check can produce the image set on its own.
    let stills: StillsResult | null = null;
    if (wantStills && (phase === 'all' || phase === 'record')) {
      stills = await exportDocumentationStills(() => ({
        entries: stillsEntries(manifest, workDir, stillsConfig.steps, tutorialStepIds, stillsConfig),
        outDir: stillsDir(output),
        meta: { tutorialId: tutorial.id, title: tutorial.title, lang, viewport },
        config: stillsConfig,
        tutorialStepIds,
      }));
      if (stills?.dir) {
        const extra = [
          stills.unchanged ? `${stills.unchanged} unchanged` : '',
          stills.kept ? `${stills.kept} kept` : '',
          stills.pruned ? `${stills.pruned} orphan(s) removed` : '',
        ].filter(Boolean);
        logger.info(
          `stills: ${stills.files.length} image(s) in ${stills.dir}` +
            (extra.length ? ` (${extra.join(', ')})` : ''),
        );
      } else if (stills) {
        logger.warn('stills: nothing exported — no frames from this recording pass');
      }
      if (stills?.missing.length) {
        logger.warn(`stills: no frame for step(s) ${stills.missing.join(', ')}`);
      }
    }

    if (phase === 'record') {
      return { ...partialResult(workDir, output, manifest), contactSheetPath: sheetPath, stills };
    }

    const post = await runPostPhase(manifest, {
      workDir,
      output,
      viewport,
      subtitles: options.subtitles ?? 'sidecar',
      leadInMs,
      zoom: options.zoom,
      idleSpeedup: options.idleSpeedup,
      captionStyle: options.captionStyle,
      gif: options.gif,
      chapters: options.chapters,
      // Intro/recap cards (#37): driven by the (localized) tutorial's objectives
      // and summary; suppressible per-render with cards: false.
      cards:
        (options.cards ?? true) && (tutorial.objectives?.length || tutorial.summary?.trim())
          ? { title: tutorial.title, objectives: tutorial.objectives, summary: tutorial.summary }
          : undefined,
    });

    if (!(options.keepWorkDir ?? options.debug ?? false)) {
      await removeDir(workDir);
    } else {
      logger.info(`work dir kept at ${workDir}`);
    }
    return { ...post, manifest, workDir, contactSheetPath: sheetPath, stills };
  } catch (err) {
    logger.error(`render failed — work dir kept at ${workDir}`);
    // On a step failure, the steps that completed already have settled
    // screenshots on disk; emit a partial contact sheet (completed steps + the
    // failure frame as the last cell) so the at-a-glance "what did each step
    // frame" view exists for exactly the run you most want it for (#20).
    if (wantContactSheet && err instanceof StepError) {
      await emitFailureContactSheet(err, workDir, output, viewport);
    }
    // Same bargain for stills: the steps that completed already have frames on
    // disk, and a partial image set is still useful to a docs author.
    if (wantStills && err instanceof StepError) {
      await emitPartialStills(workDir, output, tutorial, tutorialStepIds, lang, viewport, stillsConfig);
    }
    throw err;
  }
}

/** Best-effort partial contact sheet for a failed render. Never throws — diagnostics must not mask the StepError. */
async function emitFailureContactSheet(
  err: StepError,
  workDir: string,
  output: string,
  viewport: { width: number; height: number },
): Promise<void> {
  try {
    const manifest = await loadManifest(workDir); // completed steps only (the failing one isn't recorded)
    const entries = contactSheetEntries(manifest, workDir);
    if (err.artifacts?.screenshot) {
      entries.push({
        index: entries.length + 1,
        id: `${err.stepId} (failed)`,
        narration: err.cause instanceof Error ? err.cause.message : String(err.cause),
        file: err.artifacts.screenshot,
      });
    }
    const sheet = await renderContactSheet(entries, contactSheetPath(output), viewport);
    if (sheet) logger.info(`contact sheet (partial, through failure): ${sheet}`);
  } catch (sheetErr) {
    logger.warn(`partial contact sheet skipped: ${sheetErr instanceof Error ? sheetErr.message : sheetErr}`);
  }
}

/**
 * The success-path stills export, wrapped. A stills failure (a file occupying
 * the stills path, a read-only output dir, a full disk) must never cost a
 * successful recording its MP4 — this is a documentation side-artifact, and
 * `runPostPhase` has not run yet at the call site. Warns and returns null.
 */
async function exportDocumentationStills(
  // A thunk, so building the entries (which can throw on a filename collision)
  // is inside the guard too — the MP4 must survive any stills failure.
  build: () => Parameters<typeof exportStills>[0],
): Promise<StillsResult | null> {
  try {
    return await exportStills(build());
  } catch (err) {
    logger.warn(
      `stills: export failed, continuing with the render — ${err instanceof Error ? err.message : err}`,
    );
    return null;
  }
}

/** Best-effort stills export for a failed render. Never throws — diagnostics must not mask the StepError. */
async function emitPartialStills(
  workDir: string,
  output: string,
  tutorial: Pick<Tutorial<never>, 'id' | 'title'>,
  tutorialStepIds: string[],
  lang: string | undefined,
  viewport: { width: number; height: number },
  config: StillsConfig,
): Promise<void> {
  try {
    const manifest = await loadManifest(workDir); // completed steps only
    const result = await exportStills({
      // Selection and numbering resolve against the full tutorial, so a
      // selection naming a step that never ran still exports the ones that did.
      entries: stillsEntries(manifest, workDir, config.steps, tutorialStepIds, config),
      outDir: stillsDir(output),
      meta: { tutorialId: tutorial.id, title: tutorial.title, lang, viewport },
      config,
      tutorialStepIds,
    });
    if (result.dir) logger.info(`stills (partial, through failure): ${result.files.length} image(s) in ${result.dir}`);
  } catch (stillsErr) {
    logger.warn(`partial stills skipped: ${stillsErr instanceof Error ? stillsErr.message : stillsErr}`);
  }
}

async function safeLoadManifest(workDir: string, tutorialId: string): Promise<TimingManifest> {
  try {
    return await loadManifest(workDir);
  } catch {
    return {
      tutorialId,
      fps: 25,
      recordingStartEpochMs: 0,
      steps: [],
      totalDurationMs: 0,
    };
  }
}

function partialResult(workDir: string, output: string, manifest: TimingManifest): RenderResult {
  return {
    output,
    srtPath: null,
    gifPath: null,
    chaptersVttPath: null,
    chaptersTxtPath: null,
    videoClockOffsetMs: manifest.videoClockOffsetMs ?? 0,
    outputDurationMs: 0,
    cardsDurationMs: 0,
    manifest,
    workDir,
  };
}
