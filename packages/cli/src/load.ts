import { resolve, dirname, basename } from 'node:path';
import { createJiti } from 'jiti';
import { glob } from 'tinyglobby';
import { validateConfig, validateTutorial, type ForgeConfig, type Tutorial } from 'tutorial-forge';
import { access, readFile } from 'node:fs/promises';

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
    const sidecars = await loadTranslationSidecars(file);
    for (const t of tutorials) {
      if (!isTutorialLike(t)) {
        throw new Error(`${file}: default export is not a Tutorial (need id, title, steps[])`);
      }
      if (Object.keys(sidecars).length) {
        t.translations = { ...t.translations, ...sidecars };
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

/**
 * Find translation sidecars next to a tutorial file:
 * tutorials/getting-started.tutorial.ts → tutorials/getting-started.tutorial.<lang>.json
 * Each is a flat { stepId: translatedNarration } table.
 */
async function loadTranslationSidecars(
  tutorialFile: string,
): Promise<Record<string, Record<string, string>>> {
  const base = basename(tutorialFile).replace(/\.(ts|mts|cts|js|mjs|cjs)$/, '');
  const candidates = await glob([`${base}.*.json`], { cwd: dirname(tutorialFile), absolute: true });
  const translations: Record<string, Record<string, string>> = {};
  for (const file of candidates.sort()) {
    const lang = basename(file).slice(base.length + 1).replace(/\.json$/, '');
    if (!/^[a-z]{2,3}(-[A-Za-z0-9]+)?$/.test(lang)) continue; // not a language tag
    const parsed: unknown = JSON.parse(await readFile(file, 'utf8'));
    if (
      typeof parsed !== 'object' || parsed === null || Array.isArray(parsed) ||
      Object.values(parsed).some((v) => typeof v !== 'string')
    ) {
      throw new Error(`${file}: expected a flat JSON object of stepId → narration string`);
    }
    translations[lang] = parsed as Record<string, string>;
  }
  return translations;
}
