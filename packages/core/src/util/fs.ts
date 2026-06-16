import { mkdir, rm, access } from 'node:fs/promises';

export async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
}

export async function removeDir(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
}

export async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/** Run tasks with bounded concurrency, preserving result order. */
export async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  // On the first error: stop *scheduling* new items, let the items already in
  // flight settle, then reject with the first error. We don't reject via
  // Promise.all (which would return before the in-flight items finish, leaving
  // them running orphaned past the call) — workers swallow into `firstError` and
  // we rethrow only once every worker has drained. A failure thus never kicks
  // off the rest of the queue, and never outlives the call.
  let firstError: unknown;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length && firstError === undefined) {
      const i = next++;
      try {
        results[i] = await fn(items[i] as T, i);
      } catch (err) {
        if (firstError === undefined) firstError = err;
      }
    }
  });
  await Promise.all(workers);
  if (firstError !== undefined) throw firstError;
  return results;
}
