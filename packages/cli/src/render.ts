import { join, resolve } from 'node:path';
import { render, mapLimit, type ForgeConfig } from 'tutorial-forge';
import { loadConfig, discoverTutorials } from './load.js';

export interface RenderCmdOptions {
  only?: string;
  phase: 'tts' | 'record' | 'post' | 'all';
  headed?: boolean;
  keepWork?: boolean;
  outDir?: string;
  concurrency?: string;
  /** How many tutorial×language renders to run in parallel (default 1). */
  renderConcurrency?: string;
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
  /** Chapter markers. Commander sets this false only when --no-chapters is passed (else true). */
  chapters?: boolean;
  /** Intro/recap cards. Commander sets this false only when --no-cards is passed (else true). */
  cards?: boolean;
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

/**
 * How many renders to run in parallel: the `--render-concurrency` flag wins over
 * `config.renderConcurrency`, default 1 (serial). A non-positive or non-numeric
 * value clamps to 1, so the worst case is today's safe serial behavior.
 */
export function resolveRenderConcurrency(
  flag: string | undefined,
  configValue: number | undefined,
): number {
  const raw = flag !== undefined ? parseInt(flag, 10) : configValue;
  return Number.isFinite(raw) && (raw as number) >= 1 ? Math.floor(raw as number) : 1;
}

/** Work dir / output key for a job: `<id>` or `<id>.<lang>`. Two jobs that share it write the same paths. */
function jobPathKey(id: string, lang: string | null): string {
  return lang ? `${id}.${lang}` : id;
}

/**
 * Flatten discovered tutorials × languages into a flat render-job list, in
 * tutorial-major order. Languages are de-duplicated first: two jobs with the
 * same `(id, lang)` would target the same `.forge/<id><suffix>` work dir and
 * `<id><suffix>.mp4` output, which under `--render-concurrency > 1` means two
 * renders writing the same paths at once (e.g. `--lang "es,es"`).
 *
 * Also throws on the rarer cross-tutorial collision (#65): distinct ids whose
 * id+language suffixes coincide (e.g. a tutorial named `setup.es` and a tutorial
 * `setup` rendered in `es` both resolve to `setup.es`). This is a **backstop** —
 * `validateTutorial` already forbids dots in ids (`SLUG_RE`) and `discoverTutorials`
 * rejects duplicate ids, so it can't occur through the normal CLI path today. It
 * guards against a future relaxed slug rule or a caller that skips validation,
 * where the collision would mean simultaneous corruption under concurrency rather
 * than a benign sequential overwrite.
 */
export function buildRenderJobs<T extends { id: string }>(
  discovered: Array<{ tutorial: T }>,
  langs: Array<string | null>,
): Array<{ tutorial: T; lang: string | null }> {
  const uniqueLangs = [...new Set(langs)];
  const jobs = discovered.flatMap(({ tutorial }) => uniqueLangs.map((lang) => ({ tutorial, lang })));

  const byKey = new Map<string, { tutorial: T; lang: string | null }>();
  for (const job of jobs) {
    const key = jobPathKey(job.tutorial.id, job.lang);
    const prior = byKey.get(key);
    if (prior) {
      const desc = (j: { tutorial: T; lang: string | null }) =>
        `"${j.tutorial.id}" (${j.lang ? `lang ${j.lang}` : 'source language'})`;
      throw new Error(
        `Render job collision: ${desc(prior)} and ${desc(job)} both resolve to "${key}" — ` +
          `same work dir (.forge/${key}) and output (${key}.mp4). Rename one tutorial so its ` +
          `id and language suffix don't coincide with another's.`,
      );
    }
    byKey.set(key, job);
  }
  return jobs;
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

  // Flatten tutorial × language into a job list so it can run with bounded
  // concurrency. Default 1 = today's serial, fail-fast behavior unchanged.
  const jobs = buildRenderJobs(discovered, langs);
  const renderConcurrency = resolveRenderConcurrency(opts.renderConcurrency, config.renderConcurrency);
  if (renderConcurrency > 1) {
    console.log(`rendering ${jobs.length} job(s) at concurrency ${renderConcurrency}`);
  }

  await mapLimit(jobs, renderConcurrency, async ({ tutorial, lang }) => {
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
      // --no-chapters forces off; otherwise fall back to config (post defaults on).
      chapters: opts.chapters === false ? false : config.chapters,
      // --no-cards forces off; otherwise fall back to config (post defaults on).
      cards: opts.cards === false ? false : config.cards,
    });
    if (opts.phase === 'all' || opts.phase === 'post') {
      console.log(`✓ ${result.output} (${(result.outputDurationMs / 1000).toFixed(1)}s)`);
      if (result.srtPath) console.log(`  subtitles: ${result.srtPath}`);
      if (result.chaptersVttPath) console.log(`  chapters:  ${result.chaptersVttPath}`);
      if (result.gifPath) console.log(`  gif:       ${result.gifPath}`);
      if (result.contactSheetPath) console.log(`  contact:   ${result.contactSheetPath}`);
    } else {
      console.log(`✓ phase "${opts.phase}" complete — work dir: ${result.workDir}`);
      if (result.contactSheetPath) console.log(`  contact:   ${result.contactSheetPath}`);
    }
  });
}
