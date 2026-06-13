#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { Command } from 'commander';
import { renderCommand } from './render.js';
import { previewCommand } from './preview.js';
import { listCommand } from './list.js';
import { doctorCommand } from './doctor.js';
import { cleanCommand } from './clean.js';

// Load .env from the invocation directory so TTS keys don't need exporting.
// Shell-set variables take precedence (loadEnvFile never overrides them).
const envFile = join(process.cwd(), '.env');
if (existsSync(envFile)) {
  try {
    process.loadEnvFile(envFile);
  } catch {
    /* Node < 20.12 or malformed file — fall back to the shell environment */
  }
}

const program = new Command('tutorial-forge')
  .description('tutorial-forge — scripted Playwright walkthroughs to narrated tutorial videos')
  .version('0.8.0');

program
  .command('render')
  .description('render tutorials to MP4')
  .argument('[globs...]', 'tutorial file globs (default: config or **/*.tutorial.ts)')
  .option('--only <id>', 'render only the tutorial with this id')
  .option('--phase <phase>', 'tts | record | post | all', 'all')
  .option('--headed', 'show the browser while recording')
  .option('--keep-work', 'keep the work directory on success')
  .option('--out-dir <dir>', 'output directory (overrides config)')
  .option('--concurrency <n>', 'TTS synthesis concurrency')
  .option('--config <path>', 'path to forge.config.ts')
  .option('--lang <langs>', 'render these languages (comma-separated, e.g. "es,fr"); overrides config.languages')
  .option('--zoom', 'zoom toward click targets (overrides config.zoom)')
  .option('--idle-speedup', 'fast-forward narration-free waits (overrides config.idleSpeedup)')
  .option('--gif', 'also export an animated GIF (captioned)')
  .option('--gif-steps <range>', 'GIF excerpt: a step id or "from-id..to-id" (implies --gif)')
  .option('--recorder <kind>', "capture implementation: 'video' (default) or 'screencast'")
  .option('--contact-sheet', 'emit a per-step contact sheet PNG next to the video (authoring verification)')
  .option('--debug', 'keep work dir with Playwright trace, console log, per-step screenshots')
  .action(async (globs: string[], opts) => {
    if (!['tts', 'record', 'post', 'all'].includes(opts.phase)) {
      throw new Error(`Invalid --phase "${opts.phase}"`);
    }
    await renderCommand(globs, opts);
  });

program
  .command('preview')
  .description('render a single step to a PNG (replays prior steps to reach state; no TTS/video)')
  .argument('<step>', 'step to preview: 1-based index or step id')
  .argument('[globs...]', 'tutorial file globs (default: config or **/*.tutorial.ts)')
  .option('--only <id>', 'select this tutorial (required when globs match more than one)')
  .option('--config <path>', 'path to forge.config.ts')
  .option('--headed', 'show the browser')
  .option('--out <path>', 'screenshot output path (default: .forge/preview/<id>/preview-<step>.png)')
  .option('--lang <lang>', 'render this language (affects steps that branch on ctx.lang)')
  .action(async (step: string, globs: string[], opts) => {
    await previewCommand(step, globs, opts);
  });

program
  .command('list')
  .description('list discovered tutorials')
  .argument('[globs...]')
  .option('--config <path>', 'path to forge.config.ts')
  .action(listCommand);

program
  .command('doctor')
  .description('check the environment (node, ffmpeg, playwright, TTS env vars, app reachability)')
  .option('--config <path>', 'path to forge.config.ts')
  .action(doctorCommand);

program
  .command('clean')
  .description('remove .forge/ work dirs')
  .option('--cache', 'also clear the TTS cache')
  .action(cleanCommand);

program.parseAsync().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
