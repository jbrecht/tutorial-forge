import { resolve } from 'node:path';
import { createJiti } from 'jiti';
import { glob } from 'tinyglobby';
import { validateConfig, validateTutorial, type ForgeConfig, type Tutorial } from 'tutorial-forge';
import { access } from 'node:fs/promises';

const jiti = createJiti(import.meta.url, { interopDefault: true });

const CONFIG_CANDIDATES = ['forge.config.ts', 'forge.config.mts', 'forge.config.js', 'forge.config.mjs'];

export async function loadConfig(cwd: string, explicitPath?: string): Promise<ForgeConfig> {
  let path: string | null = explicitPath ? resolve(cwd, explicitPath) : null;
  if (!path) {
    for (const candidate of CONFIG_CANDIDATES) {
      const p = resolve(cwd, candidate);
      try {
        await access(p);
        path = p;
        break;
      } catch {
        /* try next */
      }
    }
  }
  if (!path) {
    throw new Error(
      `No forge.config.{ts,js} found in ${cwd}. Create one with defineConfig() from "tutorial-forge".`,
    );
  }
  const mod = await jiti.import<ForgeConfig | { default: ForgeConfig }>(path);
  const config = (mod as { default?: ForgeConfig }).default ?? (mod as ForgeConfig);
  return validateConfig(config);
}

export interface DiscoveredTutorial {
  tutorial: Tutorial;
  file: string;
}

export async function discoverTutorials(cwd: string, globs: string[]): Promise<DiscoveredTutorial[]> {
  const files = await glob(globs, {
    cwd,
    absolute: true,
    ignore: ['**/node_modules/**', '**/dist/**', '**/.forge/**'],
  });
  files.sort();
  const found: DiscoveredTutorial[] = [];
  for (const file of files) {
    const mod = await jiti.import<unknown>(file);
    const def = (mod as { default?: unknown }).default ?? mod;
    const tutorials = Array.isArray(def) ? def : [def];
    for (const t of tutorials) {
      if (!isTutorialLike(t)) {
        throw new Error(`${file}: default export is not a Tutorial (need id, title, steps[])`);
      }
      validateTutorial(t);
      found.push({ tutorial: t, file });
    }
  }
  const ids = new Set<string>();
  for (const { tutorial, file } of found) {
    if (ids.has(tutorial.id)) throw new Error(`Duplicate tutorial id "${tutorial.id}" (in ${file})`);
    ids.add(tutorial.id);
  }
  return found;
}

function isTutorialLike(v: unknown): v is Tutorial {
  const t = v as Tutorial;
  return !!t && typeof t.id === 'string' && typeof t.title === 'string' && Array.isArray(t.steps);
}
