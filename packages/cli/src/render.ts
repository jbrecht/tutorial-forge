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
        debug: opts.debug,
      });
      if (opts.phase === 'all' || opts.phase === 'post') {
        console.log(`✓ ${result.output} (${(result.outputDurationMs / 1000).toFixed(1)}s)`);
        if (result.srtPath) console.log(`  subtitles: ${result.srtPath}`);
      } else {
        console.log(`✓ phase "${opts.phase}" complete — work dir: ${result.workDir}`);
      }
    }
  }
}
