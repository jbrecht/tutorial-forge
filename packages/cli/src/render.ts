import { join, resolve } from 'node:path';
import { render, type ForgeConfig } from 'tutorial-forge';
import { loadConfig, discoverTutorials } from './load.js';

export interface RenderCmdOptions {
  only?: string;
  phase: 'tts' | 'record' | 'post' | 'all';
  headed?: boolean;
  keepWork?: boolean;
  outDir?: string;
  concurrency?: string;
  config?: string;
  /** Comma-separated language list, e.g. "es,fr". Overrides config.languages. */
  lang?: string;
  /** Enable zoom-on-callout (overrides config.zoom). */
  zoom?: boolean;
  /** Debug mode: trace, console log, per-step screenshots, work dir kept. */
  debug?: boolean;
  /** Enable idle speed-up (overrides config.idleSpeedup). */
  idleSpeedup?: boolean;
  /** Also export an animated GIF. */
  gif?: boolean;
  /** GIF excerpt range ("step-id" or "from..to"). Implies --gif. */
  gifSteps?: string;
  /** Capture implementation (overrides config.recorder). */
  recorder?: string;
  /** Emit a per-step contact sheet next to the video for authoring verification. */
  contactSheet?: boolean;
}

/** Merge --gif/--gif-steps flags with config.gif (flags win; --gif-steps implies --gif). */
function resolveGifOption(
  opts: RenderCmdOptions,
  configGif: ForgeConfig['gif'],
): ForgeConfig['gif'] {
  if (!opts.gif && !opts.gifSteps) return configGif;
  const base = typeof configGif === 'object' ? configGif : {};
  return opts.gifSteps ? { ...base, steps: opts.gifSteps } : { ...base };
}

function resolveRecorder(value: string | undefined): 'video' | 'screencast' | undefined {
  if (value === undefined) return undefined;
  if (value !== 'video' && value !== 'screencast') {
    throw new Error(`Invalid --recorder "${value}" (expected video | screencast)`);
  }
  return value;
}

export async function renderCommand(globs: string[], opts: RenderCmdOptions): Promise<void> {
  const cwd = process.cwd();
  const config: ForgeConfig = await loadConfig(cwd, opts.config);
  const patterns = globs.length > 0 ? globs : config.tutorials ?? ['**/*.tutorial.ts'];

  let discovered = await discoverTutorials(cwd, patterns);
  if (opts.only) {
    discovered = discovered.filter((d) => d.tutorial.id === opts.only);
    if (discovered.length === 0) throw new Error(`No tutorial with id "${opts.only}" found`);
  }
  if (discovered.length === 0) {
    throw new Error(`No tutorials matched ${patterns.join(', ')}`);
  }

  const outDir = resolve(cwd, opts.outDir ?? config.outDir ?? 'tutorials/dist');
  const defaultLang = config.defaultLang ?? 'en';
  // null = source language with no suffix (the pre-localization behavior).
  const langs: Array<string | null> =
    opts.lang?.split(',').map((l) => l.trim()).filter(Boolean) ?? config.languages ?? [null];

  for (const { tutorial } of discovered) {
    for (const lang of langs) {
      const suffix = lang ? `.${lang}` : '';
      const label = lang ? ` [${lang}]` : '';
      console.log(`\n▶ ${tutorial.id}${label} — ${tutorial.title} (${tutorial.steps.length} steps)`);
      const result = await render(tutorial, config.adapter, {
        tts: (lang && config.ttsByLang?.[lang]) || config.tts,
        output: join(outDir, `${tutorial.id}${suffix}.mp4`),
        workDir: join(cwd, '.forge', `${tutorial.id}${suffix}`),
        viewport: config.viewport,
        headless: opts.headed ? false : config.headless ?? true,
        cursor: config.cursor,
        callouts: config.callouts,
        subtitles: config.subtitles,
        captionStyle: config.captionStyle,
        leadInMs: config.leadInMs,
        keepWorkDir: opts.keepWork ?? config.keepWorkDir,
        ttsCacheDir: config.ttsCacheDir,
        ttsConcurrency: opts.concurrency ? parseInt(opts.concurrency, 10) : config.ttsConcurrency,
        phase: opts.phase,
        lang: lang ?? undefined,
        defaultLang,
        zoom: opts.zoom ?? config.zoom,
        idleSpeedup: opts.idleSpeedup ?? config.idleSpeedup,
        gif: resolveGifOption(opts, config.gif),
        recorder: resolveRecorder(opts.recorder) ?? config.recorder,
        debug: opts.debug,
        contactSheet: opts.contactSheet ?? config.contactSheet,
      });
      if (opts.phase === 'all' || opts.phase === 'post') {
        console.log(`✓ ${result.output} (${(result.outputDurationMs / 1000).toFixed(1)}s)`);
        if (result.srtPath) console.log(`  subtitles: ${result.srtPath}`);
        if (result.gifPath) console.log(`  gif:       ${result.gifPath}`);
        if (result.contactSheetPath) console.log(`  contact:   ${result.contactSheetPath}`);
      } else {
        console.log(`✓ phase "${opts.phase}" complete — work dir: ${result.workDir}`);
        if (result.contactSheetPath) console.log(`  contact:   ${result.contactSheetPath}`);
      }
    }
  }
}
