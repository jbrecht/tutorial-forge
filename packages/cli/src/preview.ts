import { resolve } from 'node:path';
import { previewStep } from 'tutorial-forge';
import { loadConfig, discoverTutorials } from './load.js';

export interface PreviewCmdOptions {
  only?: string;
  config?: string;
  headed?: boolean;
  out?: string;
  lang?: string;
}

/**
 * `tutorial-forge preview <step> [globs...]` — render a single step to a PNG
 * by replaying setup + prior steps to reach state, then running the target
 * step. No TTS, no video assembly (#11).
 */
export async function previewCommand(
  step: string,
  globs: string[],
  opts: PreviewCmdOptions,
): Promise<void> {
  const cwd = process.cwd();
  const config = await loadConfig(cwd, opts.config);
  const patterns = globs.length > 0 ? globs : config.tutorials ?? ['**/*.tutorial.ts'];

  let discovered = await discoverTutorials(cwd, patterns);
  if (opts.only) {
    discovered = discovered.filter((d) => d.tutorial.id === opts.only);
    if (discovered.length === 0) throw new Error(`No tutorial with id "${opts.only}" found`);
  }
  if (discovered.length === 0) throw new Error(`No tutorials matched ${patterns.join(', ')}`);
  if (discovered.length > 1) {
    const ids = discovered.map((d) => d.tutorial.id).join(', ');
    throw new Error(`preview needs a single tutorial — narrow with --only <id>. Matched: ${ids}`);
  }

  const { tutorial } = discovered[0]!;
  const lang = opts.lang?.trim() || undefined;
  const result = await previewStep(tutorial, config.adapter, {
    step,
    output: opts.out ? resolve(cwd, opts.out) : undefined,
    viewport: config.viewport,
    headless: opts.headed ? false : config.headless ?? true,
    cursor: config.cursor,
    callouts: config.callouts,
    lang,
    defaultLang: config.defaultLang ?? 'en',
  });
  console.log(`✓ step ${result.index + 1} "${result.stepId}" → ${result.screenshot}`);
}
