#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { Command } from 'commander';
import { renderCommand } from './render.js';
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

const program = new Command('forge')
  .description('tutorial-forge — scripted Playwright walkthroughs to narrated tutorial videos')
  .version('0.1.0');

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
  .action(async (globs: string[], opts) => {
    if (!['tts', 'record', 'post', 'all'].includes(opts.phase)) {
      throw new Error(`Invalid --phase "${opts.phase}"`);
    }
    await renderCommand(globs, opts);
  });

program
  .command('list')
  .description('list discovered tutorials')
  .argument('[globs...]')
  .option('--config <path>', 'path to forge.config.ts')
  .action(listCommand);

program
  .command('doctor')
  .description('check the environment (node, ffmpeg, playwright, TTS env vars)')
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
