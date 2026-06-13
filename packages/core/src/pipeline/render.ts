import { resolve, join } from 'node:path';
import type { RenderOptions, TimingManifest, Tutorial, TutorialAdapter } from '../types.js';
import { validateTutorial } from '../spec.js';
import { localizeTutorial } from '../i18n.js';
import { runTTSPhase, loadTTSResult } from './tts.js';
import { runRecordPhase, loadManifest } from './record.js';
import { runPostPhase, type PostPhaseResult } from './post.js';
import { renderContactSheet, contactSheetEntries, contactSheetPath } from './contact-sheet.js';
import { defaultCacheDir } from '../tts/cache.js';
import { ensureDir, removeDir } from '../util/fs.js';
import { logger } from '../util/logger.js';

export interface RenderResult extends PostPhaseResult {
  manifest: TimingManifest;
  workDir: string;
  /** Path to the authoring contact sheet, if one was emitted (#9). */
  contactSheetPath?: string | null;
}

/**
 * Run the full pipeline (or a single phase) for one tutorial.
 * Phases: tts → record → post. The work directory is kept on failure
 * (and on success with keepWorkDir: true) so every stage is inspectable.
 */
export async function render(
  tutorial: Tutorial,
  adapter: TutorialAdapter,
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
        : await loadTTSResult(workDir);
    if (phase === 'tts') {
      return partialResult(workDir, output, await safeLoadManifest(workDir, tutorial));
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

    if (phase === 'record') {
      return { ...partialResult(workDir, output, manifest), contactSheetPath: sheetPath };
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
    });

    if (!(options.keepWorkDir ?? options.debug ?? false)) {
      await removeDir(workDir);
    } else {
      logger.info(`work dir kept at ${workDir}`);
    }
    return { ...post, manifest, workDir, contactSheetPath: sheetPath };
  } catch (err) {
    logger.error(`render failed — work dir kept at ${workDir}`);
    throw err;
  }
}

async function safeLoadManifest(workDir: string, tutorial: Tutorial): Promise<TimingManifest> {
  try {
    return await loadManifest(workDir);
  } catch {
    return {
      tutorialId: tutorial.id,
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
    videoClockOffsetMs: manifest.videoClockOffsetMs ?? 0,
    outputDurationMs: 0,
    manifest,
    workDir,
  };
}
