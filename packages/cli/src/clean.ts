import { join } from 'node:path';
import { rm } from 'node:fs/promises';
import { defaultCacheDir } from 'tutorial-forge';

export async function cleanCommand(opts: { cache?: boolean }): Promise<void> {
  const workRoot = join(process.cwd(), '.forge');
  await rm(workRoot, { recursive: true, force: true });
  console.log(`removed ${workRoot}`);
  if (opts.cache) {
    const cache = defaultCacheDir();
    await rm(cache, { recursive: true, force: true });
    console.log(`removed ${cache}`);
  }
}
