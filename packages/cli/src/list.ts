import { loadConfig, discoverTutorials } from './load.js';

export async function listCommand(globs: string[], opts: { config?: string }): Promise<void> {
  const cwd = process.cwd();
  const config = await loadConfig(cwd, opts.config);
  const patterns = globs.length > 0 ? globs : config.tutorials ?? ['**/*.tutorial.ts'];
  const discovered = await discoverTutorials(cwd, patterns);
  if (discovered.length === 0) {
    console.log(`No tutorials matched ${patterns.join(', ')}`);
    return;
  }
  for (const { tutorial, file } of discovered) {
    console.log(`${tutorial.id}  "${tutorial.title}"  ${tutorial.steps.length} steps  (${file})`);
  }
}
